/**
 * Orders (spec 4.6, 4.7, 5.1-5.3, 5.8-5.11). Lines, discounts and payments live inside the order document.
 * Every change goes through `mutate`: read -> change a copy -> conditional write on `version` (+1). Adding a line is an
 * append, so a lost race simply re-reads and re-applies it (nothing is overwritten); with `If-Match` a lost race is
 * 409 version_conflict. Side effects on other collections (tables, stock, promos, points) run in `after`, inside the
 * same MongoDB transaction when the server supports it.
 */
const { Order, Table, Customer, MenuItem, Promotion, Counter, Staff } = require('../models');
const V = require('../lib/validate');
const { AppError, business, conflict, notFound, invalid } = require('../lib/errors');
const { uuid, noAccent, phoneKey, phoneId } = require('../lib/util');
const { withTx } = require('../lib/tx');
const T = require('../lib/time');
const { paginate } = require('../lib/page');
const stock = require('./stock');
const audit = require('./audit');

const opts = (session) => (session ? { session } : undefined);
const withS = (q, session) => (session ? q.session(session) : q);
const ACTIVE = (l) => l.status !== 'cancelled';
const PREFIX = { dine: 'B', take: 'M', delivery: 'G' };
const DELIVERY = ['received', 'cooking', 'ready', 'delivering', 'delivered'];

// ---------- money (5.1) ----------

function lineTotal(l) {
  return l.comp || l.status === 'cancelled' ? 0 : l.qty * l.unitPrice;
}

/** `rules` = { servicePct, roundTo }: the live rules, or the snapshot frozen when the order was closed. */
function totals(o, rules) {
  const subtotal = o.lines.reduce((s, l) => s + lineTotal(l), 0);
  const discountTotal = Math.min(o.discounts.reduce((s, d) => s + d.amount, 0), subtotal);
  const serviceFee = o.kind === 'dine' && o.serviceOn ? Math.round(((subtotal - discountTotal) * rules.servicePct) / 100) : 0;
  const rawTotal = subtotal - discountTotal + serviceFee + (o.surcharge || 0) + (o.deliveryFee || 0);
  const total = rules.roundTo <= 1 ? rawTotal : Math.floor((rawTotal + rules.roundTo / 2) / rules.roundTo) * rules.roundTo;
  const sum = (f) => o.payments.filter(f).reduce((s, p) => s + p.amount, 0);
  const paid = sum((p) => p.kind === 'pay' || p.kind === 'deposit');
  const refunded = sum((p) => p.kind === 'refund');
  const tips = sum((p) => p.kind === 'tip');
  return {
    subtotal, discountTotal, serviceFee, surcharge: o.surcharge || 0, deliveryFee: o.deliveryFee || 0, rawTotal, roundAdjust: total - rawTotal, total,
    paid, refunded, tips, due: Math.max(0, total - paid + refunded),
  };
}

const rulesFor = (o, ctx) => o.rulesSnap || ctx.rules;

// ---------- presentation ----------

function presentLine(l, ctx) {
  return {
    id: l.id, itemId: l.itemId, name: l.name, qty: l.qty, unitPrice: l.unitPrice, options: l.options || [], note: l.note || '', station: l.station, status: l.status,
    comp: !!l.comp, cancelReason: l.cancelReason || '', firedAt: l.firedAt ? ctx.iso(l.firedAt) : null, doneAt: l.doneAt ? ctx.iso(l.doneAt) : null, lineTotal: lineTotal(l),
  };
}

function present(o, ctx) {
  return {
    id: o._id, code: o.code, number: o.number, kind: o.kind, status: o.status, version: o.version,
    tableId: o.tableId || null, tableLabel: o.tableLabel || '', customerId: o.customerId || null, customerName: o.customerName || '', phone: o.phone || '',
    party: o.party, note: o.note || '', allergy: o.allergy || '', address: o.address || '', deliveryFee: o.deliveryFee || 0,
    deliveryStatus: o.deliveryStatus || null, delivererId: o.delivererId || null, dueAt: o.dueAt ? ctx.iso(o.dueAt) : null, serviceOn: !!o.serviceOn, surcharge: o.surcharge || 0,
    openedAt: ctx.iso(o.openedAt), closedAt: o.closedAt ? ctx.iso(o.closedAt) : null, openedBy: o.openedBy || '',
    lines: o.lines.map((l) => presentLine(l, ctx)),
    discounts: o.discounts.map((d) => ({ id: d.id, label: d.label, amount: d.amount, reason: d.reason || '' })),
    payments: o.payments.map((p) => ({ id: p.id, kind: p.kind, method: p.method, amount: p.amount, note: p.note || '', by: p.by || '', at: ctx.iso(p.at) })),
    totals: totals(o, rulesFor(o, ctx)),
  };
}

const searchOf = (o) => noAccent(`${o.code} ${o.customerName || ''} ${o.phone || ''} ${phoneKey(o.phone)}`);

// ---------- version / mutate ----------

function ifMatch(req) {
  const h = req?.get?.('if-match');
  const raw = h !== undefined ? String(h).replace(/^W\//, '').replace(/"/g, '').trim() : req?.body?.version;
  if (raw === undefined || raw === null || raw === '') return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n)) throw invalid('version', 'invalid_type');
  return n;
}

const clone = (x) => JSON.parse(JSON.stringify(x), (k, v) => (typeof v === 'string' && /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(v) && ['at', 'firedAt', 'doneAt', 'openedAt', 'closedAt', 'dueAt', 'createdAt', 'updatedAt'].includes(k) ? new Date(v) : v));

/**
 * `fn(o, ctx)` edits the copy `o` and may return `{ after(session) }`. Returns the stored order.
 * `expected`: the client's version (If-Match); undefined = append-style change that may be retried on a lost race.
 */
async function mutate(id, expected, ctx, fn, { session = null } = {}) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const cur = await withS(Order.findById(id), session).lean();
    if (!cur) throw notFound();
    if (expected !== undefined && cur.version !== expected) throw conflict('version_conflict', { current: present(cur, ctx) });
    const o = clone(cur);
    const out = (await fn(o, ctx, session)) || {};
    const { _id, version, ...rest } = o;
    void _id;
    rest.search = searchOf(o);
    rest.updatedAt = new Date();
    const res = await Order.updateOne({ _id: id, version: cur.version }, { $set: rest, $inc: { version: 1 } }, opts(session));
    if (res.modifiedCount === 1 || res.matchedCount === 1) {
      if (out.after) await out.after(session, o);
      return { ...o, version: version + 1 };
    }
    if (expected !== undefined) {
      const fresh = await withS(Order.findById(id), session).lean();
      throw conflict('version_conflict', { current: present(fresh, ctx) });
    }
  }
  throw new AppError(409, 'version_conflict');
}

/** Runs a change atomically (transaction when available) and answers with the full order. */
async function change(id, req, ctx, fn) {
  const expected = ifMatch(req);
  const o = await withTx((session) => mutate(id, expected, ctx, fn, { session }));
  return present(o, ctx);
}

const mustBeOpen = (o) => {
  if (o.status !== 'open') throw business('invalid_state', { status: o.status });
};

// ---------- numbering (5.11) ----------

async function nextNumber(day) {
  const c = await Counter.findOneAndUpdate({ _id: `order|${day}` }, { $inc: { seq: 1 } }, { upsert: true, new: true }).lean();
  return c.seq;
}
const codeOf = (kind, n) => `${PREFIX[kind]}${String(n).padStart(3, '0')}`;

async function linkCustomer(phone, name, session) {
  const key = phoneId(phone);
  if (key.length < 6) return null;
  return withS(Customer.findOne({ phoneKey: key }), session).lean();
}

async function newOrder({ kind, party = 1, customerName = '', phone = '', table = null, extra = {} }, auth, ctx, session) {
  const day = T.today(ctx.tz);
  const number = await nextNumber(day);
  const cust = await linkCustomer(phone, customerName, session);
  const now = new Date();
  const doc = {
    _id: uuid(), code: codeOf(kind, number), number, day, kind, status: 'open', version: 1,
    tableId: table?._id || null, tableLabel: table?.label || '', customerId: cust?._id || null,
    customerName: customerName || cust?.name || '', phone: phone || '', party, note: '', allergy: cust?.allergy || '',
    address: '', deliveryFee: 0, deliveryStatus: kind === 'delivery' ? 'received' : null, delivererId: null, dueAt: null,
    serviceOn: kind === 'dine' && ctx.rules.servicePct > 0, surcharge: 0, openedAt: now, closedAt: null, openedBy: auth.name,
    lines: [], discounts: [], payments: [], createdAt: now, updatedAt: now, ...extra,
  };
  doc.search = searchOf(doc);
  return doc;
}

// ---------- open / create ----------

/** Seats a table (free or being cleaned, without an order) and creates the dine-in order. */
async function openTable(tableId, body, auth, ctx, session = null) {
  const b = V.body(body);
  const party = V.int(b, 'party', { min: 1, max: 500, def: 1 });
  const customerName = V.str(b, 'customerName', { max: 100 });
  const phone = V.str(b, 'phone', { max: 30 });
  const table = await withS(Table.findById(tableId), session).lean();
  if (!table) throw notFound();
  const doc = await newOrder({ kind: 'dine', party, customerName, phone, table }, auth, ctx, session);
  const claimed = await Table.findOneAndUpdate(
    { _id: tableId, currentOrderId: null, status: { $in: ['free', 'cleaning'] } },
    { $set: { status: 'busy', currentOrderId: doc._id, updatedAt: new Date() } },
    { new: true, ...opts(session) },
  ).lean();
  if (!claimed) {
    const now = await withS(Table.findById(tableId), session).lean();
    throw conflict('table_in_use', { orderId: now?.currentOrderId || null });
  }
  await Order.create([doc], opts(session));
  return doc;
}

async function openTableEndpoint(auth, tableId, body, ctx) {
  const doc = await withTx((session) => openTable(tableId, body, auth, ctx, session));
  return { status: 201, body: present(doc, ctx) };
}

async function createOrder(auth, body, ctx) {
  const b = V.body(body);
  const kind = V.oneOf(b, 'kind', ['take', 'delivery'], { required: true });
  const customerName = V.str(b, 'customerName', { required: kind === 'delivery', max: 100 });
  const phone = V.str(b, 'phone', { required: kind === 'delivery', max: 30 });
  const address = V.str(b, 'address', { required: kind === 'delivery', max: 300 });
  const extra = { note: V.str(b, 'note', { max: 500 }), dueAt: V.datetime(b, 'dueAt', { def: null }) };
  if (kind === 'delivery') {
    extra.address = address;
    extra.deliveryFee = V.int(b, 'deliveryFee', { min: 0, max: 100_000_000, def: 0 });
    const d = V.str(b, 'delivererId', { def: null }) || null;
    if (d && !(await Staff.exists({ _id: d }))) throw invalid('delivererId', 'not_found');
    extra.delivererId = d;
  }
  const doc = await newOrder({ kind, party: V.int(b, 'party', { min: 1, def: 1 }), customerName, phone, extra }, auth, ctx);
  await Order.create(doc);
  return { status: 201, body: present(doc, ctx) };
}

// ---------- reads ----------

async function get(id, ctx) {
  const o = await Order.findById(id).lean();
  if (!o) throw notFound();
  return present(o, ctx);
}

async function list(q, ctx) {
  const f = {};
  if (q.status) f.status = { $in: String(q.status).split(',') };
  if (q.kind) f.kind = { $in: String(q.kind).split(',') };
  const range = {};
  if (q.from) range.$gte = T.localToUtc(String(q.from), '00:00', ctx.tz);
  if (q.to) range.$lt = T.localToUtc(String(q.to), '00:00', ctx.tz);
  if (Object.keys(range).length) f.openedAt = range;
  if (q.q) f.search = { $regex: noAccent(q.q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') };
  return paginate(Order, f, q, { field: 'openedAt', present: (rows) => rows.map((o) => present(o, ctx)) });
}

// ---------- edit ----------

async function patch(id, req, ctx) {
  const b = V.body(req.body);
  const set = {};
  if (V.has(b, 'note')) set.note = V.str(b, 'note', { max: 500 });
  if (V.has(b, 'allergy')) set.allergy = V.str(b, 'allergy', { max: 500 });
  if (V.has(b, 'party')) set.party = V.int(b, 'party', { required: true, min: 1, max: 500 });
  if (V.has(b, 'serviceOn')) set.serviceOn = V.bool(b, 'serviceOn');
  if (V.has(b, 'surcharge')) set.surcharge = V.int(b, 'surcharge', { min: 0, max: 100_000_000 });
  if (V.has(b, 'dueAt')) set.dueAt = V.datetime(b, 'dueAt');
  if (V.has(b, 'address')) set.address = V.str(b, 'address', { max: 300 });
  if (V.has(b, 'deliveryFee')) set.deliveryFee = V.int(b, 'deliveryFee', { min: 0, max: 100_000_000 });
  if (V.has(b, 'delivererId')) {
    set.delivererId = V.str(b, 'delivererId', { def: null }) || null;
    if (set.delivererId && !(await Staff.exists({ _id: set.delivererId }))) throw invalid('delivererId', 'not_found');
  }
  return change(id, req, ctx, (o) => {
    mustBeOpen(o);
    Object.assign(o, set);
  });
}

// ---------- lines ----------

function resolveOptions(item, picked) {
  const names = Array.isArray(picked) ? picked.map(String) : [];
  const used = new Set();
  let extra = 0;
  for (const g of item.options || []) {
    const chosen = g.choices.filter((c) => names.includes(c.name));
    if (g.required && !chosen.length) throw business('validation_failed', { field: 'options', reason: 'required_group', group: g.name });
    if (!g.multi && chosen.length > 1) throw business('validation_failed', { field: 'options', reason: 'single_choice', group: g.name });
    for (const c of chosen) {
      extra += c.extra || 0;
      used.add(c.name);
    }
  }
  const unknown = names.find((n) => !used.has(n));
  if (unknown !== undefined) throw business('validation_failed', { field: 'options', reason: 'unknown_choice', choice: unknown });
  return { names: names.filter((n) => used.has(n)), extra };
}

const sameOptions = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

async function addLine(id, req, ctx) {
  const b = V.body(req.body);
  const itemId = V.str(b, 'itemId', { required: true });
  const qty = V.int(b, 'qty', { required: true, min: 1, max: 999 });
  const note = V.str(b, 'note', { max: 300 });
  const item = await MenuItem.findById(itemId).lean();
  if (!item) throw invalid('itemId', 'not_found');
  const hand = await stock.onHandMap((item.recipe || []).map((l) => l.ingredientId));
  if (!stock.availability(item, hand).available) throw business('item_unavailable', { itemId, reason: item.status !== 'on' ? 'status' : 'stock' });
  const { names, extra } = resolveOptions(item, b.options); // `extra` sent by the client is ignored: recomputed from the item
  const unitPrice = item.price + extra;
  const o = await withTx((session) => mutate(id, undefined, ctx, (ord) => {
    mustBeOpen(ord);
    const same = ord.lines.find((l) => l.status === 'draft' && l.itemId === itemId && l.unitPrice === unitPrice && sameOptions(l.options || [], names) && (l.note || '') === note && !l.comp);
    if (same) same.qty += qty;
    else {
      ord.lines.push({
        id: uuid(), itemId, name: item.name, qty, unitPrice, options: names, note, station: item.station, status: 'draft', comp: false, cancelReason: '', firedAt: null, doneAt: null,
      });
    }
  }, { session }));
  return present(o, ctx);
}

const findLine = (o, lineId) => {
  const l = o.lines.find((x) => x.id === lineId);
  if (!l) throw notFound();
  return l;
};

async function patchLine(id, lineId, req, ctx) {
  const b = V.body(req.body);
  const qty = V.has(b, 'qty') ? V.int(b, 'qty', { required: true, min: 1, max: 999 }) : undefined;
  const note = V.has(b, 'note') ? V.str(b, 'note', { max: 300 }) : undefined;
  return change(id, req, ctx, (o) => {
    mustBeOpen(o);
    const l = findLine(o, lineId);
    if (l.status !== 'draft') throw business('invalid_state', { status: l.status });
    if (qty !== undefined) l.qty = qty;
    if (note !== undefined) l.note = note;
  });
}

async function deleteLine(id, lineId, req, ctx) {
  return change(id, req, ctx, (o) => {
    mustBeOpen(o);
    const l = findLine(o, lineId);
    if (l.status !== 'draft') throw business('invalid_state', { status: l.status });
    o.lines = o.lines.filter((x) => x.id !== lineId);
  });
}

/** Waste entries for a dish that was already cooked and is now cancelled (5.3). */
async function wasteFor(line, name, session) {
  const item = await withS(MenuItem.findById(line.itemId), session).lean();
  for (const r of item?.recipe || []) await stock.deduct(r.ingredientId, r.qty * line.qty, { kind: 'waste', note: `Hủy món ${name}` }, session);
}

async function cancelLine(auth, id, lineId, req, ctx) {
  const reason = V.str(V.body(req.body), 'reason', { max: 300 });
  if (!reason) throw business('reason_required');
  return change(id, req, ctx, (o) => {
    mustBeOpen(o);
    const l = findLine(o, lineId);
    if (l.status === 'cancelled') return undefined;
    const cooked = l.status === 'done' || l.status === 'served';
    const snap = { ...l };
    l.status = 'cancelled';
    l.cancelReason = reason;
    return {
      async after(session) {
        if (cooked) await wasteFor(snap, snap.name, session);
        await audit.log(auth, 'line_cancelled', 'order', id, `${snap.name} x${snap.qty}: ${reason}`, opts(session));
      },
    };
  });
}

async function compLine(auth, id, lineId, req, ctx) {
  const reason = V.str(V.body(req.body), 'reason', { max: 300 });
  if (!reason) throw business('reason_required');
  return change(id, req, ctx, (o) => {
    mustBeOpen(o);
    const l = findLine(o, lineId);
    if (l.status === 'cancelled') throw business('invalid_state', { status: l.status });
    if (l.comp) return undefined;
    l.comp = true;
    return { after: (session) => audit.log(auth, 'line_comp', 'order', id, `${l.name} x${l.qty}: ${reason}`, opts(session)) };
  });
}

async function fire(id, req, ctx) {
  let fired = 0;
  const order = await change(id, req, ctx, (o) => {
    mustBeOpen(o);
    const now = new Date();
    fired = 0;
    for (const l of o.lines) {
      if (l.status === 'draft') {
        l.status = 'sent';
        l.firedAt = now;
        fired += 1;
      }
    }
    if (fired && o.kind === 'delivery' && o.deliveryStatus === 'received') o.deliveryStatus = 'cooking';
  });
  return { fired, order };
}

const KITCHEN_STEP = { start: ['sent', 'cooking'], done: ['cooking', 'done'], served: ['done', 'served'] };
async function kitchenStep(id, lineId, step, ctx) {
  const [from, to] = KITCHEN_STEP[step];
  const o = await withTx((session) => mutate(id, undefined, ctx, (ord) => {
    mustBeOpen(ord);
    const l = findLine(ord, lineId);
    if (l.status !== from) throw business('invalid_state', { status: l.status, expected: from });
    l.status = to;
    if (to === 'done') l.doneAt = new Date();
  }, { session }));
  return present(o, ctx);
}

async function kitchen(q, ctx) {
  const station = q.station ? String(q.station) : null;
  const orders = await Order.find({ status: 'open', 'lines.status': { $in: ['sent', 'cooking', 'done'] } }).lean();
  const out = [];
  for (const o of orders) {
    for (const l of o.lines) {
      if (!['sent', 'cooking', 'done'].includes(l.status) || (station && l.station !== station)) continue;
      out.push({
        orderId: o._id, orderCode: o.code, tableLabel: o.tableLabel || '', orderKind: o.kind, allergy: o.allergy || '', lineId: l.id, name: l.name, qty: l.qty,
        options: l.options || [], note: l.note || '', station: l.station, status: l.status, firedAt: ctx.iso(l.firedAt), _t: new Date(l.firedAt).getTime(),
      });
    }
  }
  out.sort((a, b) => a._t - b._t);
  return { items: out.map(({ _t, ...r }) => r), serverTime: ctx.iso(new Date()) };
}

// ---------- tables ----------

async function moveTable(auth, id, req, ctx) {
  const toTableId = V.str(V.body(req.body), 'toTableId', { required: true });
  return change(id, req, ctx, async (o, _c, session) => {
    mustBeOpen(o);
    if (o.kind !== 'dine' || !o.tableId) throw business('invalid_state', { reason: 'not_dine' });
    const target = await withS(Table.findById(toTableId), session).lean();
    if (!target) throw invalid('toTableId', 'not_found');
    if (target.currentOrderId || target.status !== 'free') throw conflict('table_in_use', { orderId: target.currentOrderId || null });
    const fromId = o.tableId;
    o.tableId = target._id;
    o.tableLabel = target.label;
    return {
      async after(s) {
        const claimed = await Table.findOneAndUpdate({ _id: toTableId, currentOrderId: null, status: 'free' }, { $set: { status: 'busy', currentOrderId: id, updatedAt: new Date() } }, opts(s));
        if (!claimed) throw conflict('table_in_use');
        await Table.updateOne({ _id: fromId, currentOrderId: id }, { $set: { status: 'free', currentOrderId: null, updatedAt: new Date() } }, opts(s));
      },
    };
  });
}

/** Source order is folded into the target: lines, discounts and also payments (otherwise money would vanish with the cancelled order). */
async function mergeOrders(auth, id, req, ctx) {
  const intoId = V.str(V.body(req.body), 'intoOrderId', { required: true });
  if (intoId === id) throw invalid('intoOrderId', 'invalid');
  const expected = ifMatch(req);
  const target = await withTx(async (session) => {
    const src = await withS(Order.findById(id), session).lean();
    const dst = await withS(Order.findById(intoId), session).lean();
    if (!src || !dst) throw notFound();
    if (src.status !== 'open' || dst.status !== 'open' || src.kind !== 'dine' || dst.kind !== 'dine') throw business('invalid_state');
    const tabs = await withS(Table.find({ _id: { $in: [src.tableId, dst.tableId] } }), session).lean();
    if (tabs.length < 2 || tabs.some((t) => !t.canMerge)) throw business('invalid_state', { reason: 'cannot_merge' });
    const moved = { lines: src.lines, discounts: src.discounts, payments: src.payments, party: src.party };
    await mutate(id, expected, ctx, (o) => {
      o.lines = [];
      o.discounts = [];
      o.payments = [];
      o.status = 'cancelled';
      o.cancelReason = `Ghép vào ${dst.code}`;
      return {
        async after(s) {
          await Table.updateOne({ _id: src.tableId, currentOrderId: id }, { $set: { status: 'cleaning', currentOrderId: null, updatedAt: new Date() } }, opts(s));
        },
      };
    }, { session });
    const merged = await mutate(intoId, undefined, ctx, (o) => {
      o.lines.push(...clone(moved.lines));
      o.discounts.push(...clone(moved.discounts));
      o.payments.push(...clone(moved.payments));
      o.party += moved.party;
    }, { session });
    await audit.log(auth, 'orders_merged', 'order', intoId, `${src.code} -> ${dst.code}`, opts(session));
    return merged;
  });
  return present(target, ctx);
}

// ---------- discounts / promo ----------

async function addDiscount(auth, id, req, ctx) {
  const b = V.body(req.body);
  const label = V.str(b, 'label', { required: true, max: 100 });
  const amount = V.int(b, 'amount', { required: true, min: 1, max: 1_000_000_000 });
  const reason = V.str(b, 'reason', { max: 300 });
  return change(id, req, ctx, (o) => {
    mustBeOpen(o);
    const subtotal = o.lines.reduce((s, l) => s + lineTotal(l), 0);
    const big = amount > subtotal * 0.2;
    if (big && !reason) throw business('reason_required');
    o.discounts.push({ id: uuid(), label, amount, reason });
    return big ? { after: (session) => audit.log(auth, 'big_discount', 'order', id, `${label} ${amount}: ${reason}`, opts(session)) } : undefined;
  });
}

const releasePromo = (promoId, session) => (promoId ? Promotion.updateOne({ _id: promoId, used: { $gt: 0 } }, { $inc: { used: -1 } }, opts(session)) : null);

async function removeDiscount(id, discountId, req, ctx) {
  return change(id, req, ctx, (o) => {
    mustBeOpen(o);
    const d = o.discounts.find((x) => x.id === discountId);
    if (!d) throw notFound();
    o.discounts = o.discounts.filter((x) => x.id !== discountId);
    return { after: (session) => releasePromo(d.promoId, session) };
  });
}

async function applyPromo(id, req, ctx) {
  const code = V.str(V.body(req.body), 'code', { required: true, max: 30 });
  const promo = await Promotion.findOne({ code: new RegExp(`^${code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') }).lean();
  const today = T.today(ctx.tz);
  if (!promo || (promo.end && today > promo.end) || (promo.limit > 0 && promo.used >= promo.limit)) throw business('promo_invalid');
  return change(id, req, ctx, (o) => {
    mustBeOpen(o);
    if (o.discounts.some((d) => d.promoId === promo._id)) throw business('promo_invalid');
    const subtotal = o.lines.reduce((s, l) => s + lineTotal(l), 0);
    if (subtotal < promo.minAmount) throw business('promo_min_amount', { minAmount: promo.minAmount });
    const amount = promo.kind === 'percent' ? Math.round((subtotal * promo.value) / 100) : promo.value;
    o.discounts.push({ id: uuid(), label: `Mã ${promo.code}`, amount, reason: '', promoId: promo._id });
    return {
      async after(session) {
        const r = await Promotion.updateOne(
          { _id: promo._id, $or: [{ limit: 0 }, { $expr: { $lt: ['$used', '$limit'] } }] },
          { $inc: { used: 1 } }, opts(session),
        );
        if (!r.modifiedCount) throw business('promo_invalid');
      },
    };
  });
}

// ---------- payments ----------

async function addPayment(auth, id, req, ctx) {
  const b = V.body(req.body);
  const kind = V.oneOf(b, 'kind', ['pay', 'tip'], { def: 'pay' });
  const method = V.oneOf(b, 'method', ['cash', 'transfer', 'free'], { required: true });
  const amount = V.int(b, 'amount', { required: true, min: 1, max: 100_000_000_000 });
  const note = V.str(b, 'note', { max: 300 });
  if (method === 'free' && kind === 'tip') throw invalid('method', 'invalid_enum');
  if (method === 'free' && !note) throw business('reason_required');
  return change(id, req, ctx, (o) => {
    mustBeOpen(o);
    if (kind === 'pay') {
      const due = totals(o, rulesFor(o, ctx)).due;
      if (amount > due) throw business('validation_failed', { field: 'amount', reason: 'exceeds_due', due });
    }
    o.payments.push({ id: uuid(), kind, method, amount, note, by: auth.name, at: new Date() });
    const dueAfter = totals(o, rulesFor(o, ctx)).due;
    return {
      async after(session) {
        if (kind === 'pay' && dueAfter === 0 && o.kind === 'dine' && o.tableId) {
          await Table.updateOne({ _id: o.tableId, currentOrderId: id, status: 'busy' }, { $set: { status: 'billing', updatedAt: new Date() } }, opts(session));
        }
        if (method === 'free') await audit.log(auth, 'free_payment', 'order', id, `${amount}: ${note}`, opts(session));
      },
    };
  });
}

async function removePayment(id, paymentId, req, ctx) {
  return change(id, req, ctx, (o) => {
    mustBeOpen(o);
    if (!o.payments.some((p) => p.id === paymentId)) throw notFound();
    o.payments = o.payments.filter((p) => p.id !== paymentId);
    const dueAfter = totals(o, rulesFor(o, ctx)).due;
    return {
      async after(session) {
        if (dueAfter > 0 && o.kind === 'dine' && o.tableId) {
          await Table.updateOne({ _id: o.tableId, currentOrderId: id, status: 'billing' }, { $set: { status: 'busy', updatedAt: new Date() } }, opts(session));
        }
      },
    };
  });
}

// ---------- close / cancel / reopen / refund ----------

async function consume(o, session) {
  const ids = [...new Set(o.lines.filter(ACTIVE).map((l) => l.itemId))];
  const items = await withS(MenuItem.find({ _id: { $in: ids } }), session).lean();
  const by = Object.fromEntries(items.map((i) => [i._id, i]));
  for (const l of o.lines.filter(ACTIVE)) {
    for (const r of by[l.itemId]?.recipe || []) {
      await stock.deduct(r.ingredientId, r.qty * l.qty, { kind: 'sale', note: `Đơn ${o.code}`, orderId: o._id }, session);
    }
  }
}

async function close(auth, id, req, ctx) {
  return change(id, req, ctx, (o) => {
    mustBeOpen(o);
    if (o.lines.some((l) => l.status === 'draft')) throw business('draft_lines_pending');
    if (!o.lines.some(ACTIVE)) throw business('empty_order');
    const snap = { servicePct: ctx.rules.servicePct, roundTo: ctx.rules.roundTo };
    const t = totals(o, snap);
    if (t.due > 0) throw business('payment_incomplete', { due: t.due });
    const points = o.customerId ? Math.floor(t.total / 10000) : 0;
    o.status = 'closed';
    o.closedAt = new Date();
    o.rulesSnap = snap;
    o.roundAdjust = t.roundAdjust;
    o.finalTotal = t.total;
    o.pointsAwarded = points;
    if (o.kind === 'delivery') o.deliveryStatus = 'delivered';
    return {
      async after(session) {
        await consume(o, session);
        if (points) await Customer.updateOne({ _id: o.customerId }, { $inc: { points }, $set: { updatedAt: new Date() } }, opts(session));
        if (o.kind === 'dine' && o.tableId) {
          await Table.updateOne({ _id: o.tableId, currentOrderId: id }, { $set: { status: 'cleaning', currentOrderId: null, updatedAt: new Date() } }, opts(session));
        }
      },
    };
  });
}

async function cancel(auth, id, req, ctx) {
  const reason = V.str(V.body(req.body), 'reason', { max: 300 });
  if (!reason) throw business('reason_required');
  return change(id, req, ctx, (o) => {
    mustBeOpen(o);
    o.status = 'cancelled';
    o.cancelReason = reason;
    const promoIds = o.discounts.map((d) => d.promoId).filter(Boolean);
    return {
      async after(session) {
        if (o.kind === 'dine' && o.tableId) {
          await Table.updateOne({ _id: o.tableId, currentOrderId: id }, { $set: { status: 'free', currentOrderId: null, updatedAt: new Date() } }, opts(session));
        }
        for (const p of promoIds) await releasePromo(p, session);
        await audit.log(auth, 'order_cancelled', 'order', id, `${o.code}: ${reason}`, opts(session));
      },
    };
  });
}

async function reopen(auth, id, req, ctx) {
  return change(id, req, ctx, (o) => {
    if (o.status !== 'closed') throw business('invalid_state', { status: o.status });
    const points = o.pointsAwarded || 0;
    o.status = 'open';
    o.closedAt = null;
    o.rulesSnap = null;
    o.finalTotal = null;
    o.pointsAwarded = 0;
    o.roundAdjust = 0;
    if (o.kind === 'delivery') o.deliveryStatus = 'ready';
    return {
      async after(session) {
        await stock.reverseSales(id, o.code, session); // open question 3: stock goes back, closing deducts again
        if (points && o.customerId) await Customer.updateOne({ _id: o.customerId }, { $inc: { points: -points } }, opts(session));
        if (o.kind === 'dine' && o.tableId) {
          await Table.updateOne({ _id: o.tableId, currentOrderId: null, status: { $in: ['free', 'cleaning'] } }, { $set: { status: 'busy', currentOrderId: id, updatedAt: new Date() } }, opts(session));
        }
        await audit.log(auth, 'order_reopened', 'order', id, o.code, opts(session));
      },
    };
  });
}

async function refund(auth, id, req, ctx) {
  const b = V.body(req.body);
  const amount = V.int(b, 'amount', { required: true, min: 1, max: 100_000_000_000 });
  const method = V.oneOf(b, 'method', ['cash', 'transfer'], { required: true });
  const reason = V.str(b, 'reason', { max: 300 });
  if (!reason) throw business('reason_required');
  return change(id, req, ctx, (o) => {
    if (o.status !== 'closed') throw business('invalid_state', { status: o.status });
    const t = totals(o, rulesFor(o, ctx));
    const refundable = t.paid - t.refunded;
    if (amount > refundable) throw business('validation_failed', { field: 'amount', reason: 'exceeds_paid', refundable });
    o.payments.push({ id: uuid(), kind: 'refund', method, amount, note: reason, by: auth.name, at: new Date() });
    return { after: (session) => audit.log(auth, 'refund', 'order', id, `${amount}: ${reason}`, opts(session)) };
  });
}

async function setDeliveryStatus(id, req, ctx) {
  const status = V.oneOf(V.body(req.body), 'status', DELIVERY, { required: true });
  return change(id, req, ctx, (o) => {
    if (o.kind !== 'delivery') throw business('invalid_state', { reason: 'not_delivery' });
    o.deliveryStatus = status;
  });
}

module.exports = {
  totals, lineTotal, present, get, list, patch, openTableEndpoint, openTable, createOrder, addLine, patchLine, deleteLine, cancelLine, compLine, fire, kitchenStep, kitchen,
  moveTable, mergeOrders, addDiscount, removeDiscount, applyPromo, addPayment, removePayment, close, cancel, reopen, refund, setDeliveryStatus, rulesFor, ACTIVE,
};
