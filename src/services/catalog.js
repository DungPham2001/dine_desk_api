/**
 * Catalog resources: areas, tables, menu, ingredients, suppliers, staff, promotions, customers, expenses, targets.
 * Each parser validates input and returns the fields to store; `present` shapes the API output (spec 3).
 */
const { Area, Table, MenuGroup, MenuItem, Ingredient, StockLot, StockMove, Supplier, Staff, Promotion, Customer, Expense, SalesTarget, Order, Booking } = require('../models');
const V = require('../lib/validate');
const { business, conflict, notFound, invalid, AppError } = require('../lib/errors');
const { uuid, noAccent, phoneKey, phoneId } = require('../lib/util');
const { withTx } = require('../lib/tx');
const T = require('../lib/time');
const { paginate } = require('./../lib/page');
const { crud, pick } = require('./crud');
const stock = require('./stock');
const audit = require('./audit');

const iso = (d, ctx) => (d ? ctx.iso(d) : null);
const stamp = (r, ctx) => ({ createdAt: ctx.iso(r.createdAt), updatedAt: ctx.iso(r.updatedAt) });
const ci = (s) => new RegExp(`^${String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');

// ---------- areas ----------

const areas = crud(Area, {
  sort: { sort: 1, createdAt: 1 },
  parse: (b, create) => pick(b, create, { name: (x, c) => V.str(x, 'name', { required: c, max: 80 }), sort: (x) => V.int(x, 'sort', { def: 0 }) }),
  present: (a, ctx) => ({ id: a._id, name: a.name, ...stamp(a, ctx) }),
  async beforeDelete(a) {
    if (await Table.exists({ areaId: a._id, currentOrderId: { $ne: null } })) throw conflict('has_dependents');
    await Table.deleteMany({ areaId: a._id });
  },
});

// ---------- tables ----------

const presentTable = (t, ctx) => ({ id: t._id, areaId: t.areaId, label: t.label, seats: t.seats, canMerge: t.canMerge, status: t.status, currentOrderId: t.currentOrderId || null, ...stamp(t, ctx) });
const tables = crud(Table, {
  sort: { label: 1 },
  parse: async (b, create, cur) => {
    const out = pick(b, create, {
      areaId: (x) => V.str(x, 'areaId', { required: true }),
      label: (x) => V.str(x, 'label', { required: true, max: 20 }),
      seats: (x) => V.int(x, 'seats', { required: true, min: 1, max: 100 }),
      canMerge: (x) => V.bool(x, 'canMerge', { def: true }),
    });
    if (out.areaId && !(await Area.exists({ _id: out.areaId }))) throw invalid('areaId', 'not_found');
    if (out.label && (await Table.exists({ label: out.label, _id: { $ne: cur?._id } }))) throw conflict('duplicate', { field: 'label' });
    return out;
  },
  present: presentTable,
  filter: (q) => (q.areaId ? { areaId: String(q.areaId) } : {}),
  async beforeDelete(t) {
    if (t.currentOrderId) throw conflict('has_dependents', { orderId: t.currentOrderId });
  },
});

// ---------- menu groups / items ----------

const groups = crud(MenuGroup, {
  sort: { sort: 1, createdAt: 1 },
  parse: (b, create) => pick(b, create, { name: (x, c) => V.str(x, 'name', { required: c, max: 80 }), sort: (x) => V.int(x, 'sort', { def: 0 }) }),
  present: (g, ctx) => ({ id: g._id, name: g.name, ...stamp(g, ctx) }),
  async beforeDelete(g) { await MenuItem.deleteMany({ groupId: g._id }); },
});

function readOptions(b) {
  const raw = V.arr(b, 'options', { max: 30 });
  if (!raw) return undefined;
  return raw.map((o, i) => {
    const g = V.body(o);
    const f = (k) => `options[${i}].${k}`;
    const name = typeof g.name === 'string' && g.name.trim() ? g.name.trim().slice(0, 60) : null;
    if (!name) throw invalid(f('name'), 'required');
    const choices = Array.isArray(g.choices) ? g.choices : [];
    if (!choices.length) throw invalid(f('choices'), 'required');
    return {
      name,
      required: g.required === true,
      multi: g.multi === true,
      choices: choices.map((c, j) => {
        const cc = V.body(c);
        const cn = typeof cc.name === 'string' && cc.name.trim() ? cc.name.trim().slice(0, 60) : null;
        if (!cn) throw invalid(`options[${i}].choices[${j}].name`, 'required');
        const extra = cc.extra === undefined || cc.extra === null ? 0 : cc.extra;
        if (!Number.isInteger(extra)) throw invalid(`options[${i}].choices[${j}].extra`, 'invalid_type');
        return { name: cn, extra };
      }),
    };
  });
}

const itemSearch = (i) => noAccent(`${i.name} ${i.code || ''}`);
async function presentItems(rows, ctx) {
  void ctx;
  const ids = [...new Set(rows.flatMap((r) => (r.recipe || []).map((l) => l.ingredientId)))];
  const hand = ids.length ? await stock.onHandMap(ids) : {};
  return rows.map((i) => ({
    id: i._id, groupId: i.groupId, code: i.code, name: i.name, desc: i.desc, unit: i.unit, price: i.price, prepMin: i.prepMin, station: i.station, status: i.status,
    tags: i.tags, options: i.options, recipe: (i.recipe || []).map((l) => ({ ingredientId: l.ingredientId, qty: l.qty })), hasRecipe: (i.recipe || []).length > 0, ...stock.availability(i, hand), ...stamp(i, ctx),
  }));
}

const items = crud(MenuItem, {
  sort: { code: 1, name: 1 },
  parse: async (b, create, cur) => {
    const out = pick(b, create, {
      groupId: (x) => V.str(x, 'groupId', { required: true }),
      code: (x) => V.str(x, 'code', { max: 20 }),
      name: (x) => V.str(x, 'name', { required: true, max: 120 }),
      desc: (x) => V.str(x, 'desc', { max: 500 }),
      unit: (x) => V.str(x, 'unit', { max: 30 }),
      price: (x) => V.int(x, 'price', { required: true, min: 0, max: 100_000_000 }),
      prepMin: (x) => V.int(x, 'prepMin', { min: 0, max: 600, def: 0 }),
      station: (x) => V.oneOf(x, 'station', ['kitchen', 'bar', 'grill'], { def: 'kitchen' }),
      status: (x) => V.oneOf(x, 'status', ['on', 'out', 'off'], { def: 'on' }),
      tags: (x) => (V.arr(x, 'tags', { max: 20 }) || []).map((t) => String(t).trim().slice(0, 30)).filter(Boolean),
    });
    const options = readOptions(b);
    if (options) out.options = options;
    if (out.groupId && !(await MenuGroup.exists({ _id: out.groupId }))) throw invalid('groupId', 'not_found');
    out.search = itemSearch({ name: out.name ?? cur?.name, code: out.code ?? cur?.code });
    return out;
  },
  presentMany: presentItems,
  filter: (q) => {
    const f = {};
    if (q.groupId) f.groupId = String(q.groupId);
    if (q.status) f.status = String(q.status);
    if (q.q) f.search = { $regex: noAccent(q.q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') };
    return f;
  },
});

async function setRecipe(id, body, ctx) {
  const item = await MenuItem.findById(id).lean();
  if (!item) throw notFound();
  const lines = V.arr(V.body(body), 'lines', { max: 60 });
  if (!lines) throw invalid('lines', 'required');
  const merged = new Map();
  for (const [i, raw] of lines.entries()) {
    const l = V.body(raw);
    const ingredientId = V.str(l, 'ingredientId', { required: true });
    let qty;
    try { qty = V.num(l, 'qty', { required: true, min: 0.0001, max: 1e9 }); } catch (e) { throw invalid(`lines[${i}].qty`, e.details?.reason); }
    if (!(await Ingredient.exists({ _id: ingredientId }))) throw invalid(`lines[${i}].ingredientId`, 'not_found');
    merged.set(ingredientId, stock.r3((merged.get(ingredientId) || 0) + qty));
  }
  const recipe = [...merged].map(([ingredientId, qty]) => ({ ingredientId, qty }));
  await MenuItem.updateOne({ _id: id }, { $set: { recipe, updatedAt: new Date() } });
  return { itemId: id, lines: recipe, item: (await presentItems([await MenuItem.findById(id).lean()], ctx))[0] };
}

async function getRecipe(id) {
  const item = await MenuItem.findById(id).lean();
  if (!item) throw notFound();
  return { itemId: id, lines: item.recipe || [] };
}

async function itemCost(id) {
  const item = await MenuItem.findById(id).lean();
  if (!item) throw notFound();
  const costMap = await stock.lastCostMap((item.recipe || []).map((l) => l.ingredientId));
  const cost = stock.itemCost(item, costMap);
  if (cost === null) return { cost: null };
  const margin = item.price - cost;
  return { cost, margin, marginPct: item.price > 0 ? Math.round((margin * 100) / item.price) : 0 };
}

async function bulkPrice(auth, body) {
  const b = V.body(body);
  const groupId = V.str(b, 'groupId', { def: null }) || null;
  const percent = V.num(b, 'percent', { required: true, min: -90, max: 500 });
  if (groupId && !(await MenuGroup.exists({ _id: groupId }))) throw invalid('groupId', 'not_found');
  const rows = await MenuItem.find(groupId ? { groupId } : {}).select('price').lean();
  const now = new Date();
  const ops = rows.map((r) => ({ updateOne: { filter: { _id: r._id }, update: { $set: { price: Math.max(0, Math.round((r.price * (1 + percent / 100)) / 1000) * 1000), updatedAt: now } } } }));
  if (ops.length) await MenuItem.bulkWrite(ops);
  await audit.log(auth, 'bulk_price', 'menu', groupId, `${percent}% on ${rows.length} items`);
  return { updated: rows.length };
}

// ---------- ingredients ----------

const ingredients = crud(Ingredient, {
  sort: { name: 1 },
  parse: (b, create, cur) => {
    const out = pick(b, create, {
      name: (x) => V.str(x, 'name', { required: true, max: 120 }),
      unit: (x) => V.str(x, 'unit', { max: 20 }),
      group: (x) => V.str(x, 'group', { max: 60 }),
      minQty: (x) => V.num(x, 'minQty', { min: 0, def: 0 }),
      supplierId: (x) => V.str(x, 'supplierId', { def: null }) || null,
    });
    out.search = noAccent(out.name ?? cur?.name);
    return out;
  },
  presentMany: (rows) => stock.presentIngredients(rows),
  filter: (q) => (q.q ? { search: { $regex: noAccent(q.q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') } } : {}),
  async afterWrite(doc) {
    if (doc.supplierId && !(await Supplier.exists({ _id: doc.supplierId }))) {
      await Ingredient.updateOne({ _id: doc._id }, { $set: { supplierId: null } });
      throw invalid('supplierId', 'not_found');
    }
  },
  async beforeDelete(g, auth) {
    await withTx(async (session) => {
      const o = session ? { session } : undefined;
      await MenuItem.updateMany({ 'recipe.ingredientId': g._id }, { $pull: { recipe: { ingredientId: g._id } } }, o);
      await StockLot.deleteMany({ ingredientId: g._id }, o);
      await StockMove.deleteMany({ ingredientId: g._id }, o);
      await audit.log(auth, 'ingredient_deleted', 'ingredient', g._id, g.name, o);
    });
  },
});

// ---------- suppliers / staff ----------

const suppliers = crud(Supplier, {
  sort: { name: 1 },
  parse: (b, create) => pick(b, create, {
    name: (x) => V.str(x, 'name', { required: true, max: 120 }), phone: (x) => V.str(x, 'phone', { max: 30 }),
    items: (x) => V.str(x, 'items', { max: 300 }), note: (x) => V.str(x, 'note', { max: 300 }),
  }),
  present: (s, ctx) => ({ id: s._id, name: s.name, phone: s.phone, items: s.items, note: s.note, ...stamp(s, ctx) }),
  async beforeDelete(s) { await Ingredient.updateMany({ supplierId: s._id }, { $set: { supplierId: null, updatedAt: new Date() } }); },
});

const ROLES = ['waiter', 'kitchen', 'bar', 'cashier', 'delivery'];
const staff = crud(Staff, {
  sort: { name: 1 },
  parse: (b, create) => pick(b, create, {
    name: (x) => V.str(x, 'name', { required: true, max: 100 }), phone: (x) => V.str(x, 'phone', { max: 30 }),
    role: (x) => V.oneOf(x, 'role', ROLES, { def: 'waiter' }), joined: (x) => V.date(x, 'joined', { def: null }),
    active: (x) => V.bool(x, 'active', { def: true }), note: (x) => V.str(x, 'note', { max: 300 }),
  }),
  present: (s, ctx) => ({ id: s._id, name: s.name, phone: s.phone, role: s.role, joined: s.joined || null, active: s.active, note: s.note, ...stamp(s, ctx) }),
  filter: (q) => (q.role ? { role: String(q.role) } : {}),
  async beforeDelete(s) { await Order.updateMany({ delivererId: s._id }, { $set: { delivererId: null } }); },
});

// ---------- promotions ----------

const promoValid = (p, today) => (!p.end || today <= p.end) && (p.limit === 0 || p.used < p.limit);
const promotions = crud(Promotion, {
  sort: { code: 1 },
  parse: async (b, create, cur) => {
    const out = pick(b, create, {
      code: (x) => V.str(x, 'code', { required: true, max: 30 }).toUpperCase(),
      kind: (x) => V.oneOf(x, 'kind', ['percent', 'amount'], { required: true }),
      value: (x) => V.int(x, 'value', { required: true, min: 1, max: 1_000_000_000 }),
      minAmount: (x) => V.int(x, 'minAmount', { min: 0, def: 0 }),
      limit: (x) => V.int(x, 'limit', { min: 0, def: 0 }),
      end: (x) => V.date(x, 'end', { def: null }),
    });
    const kind = out.kind ?? cur?.kind;
    if (kind === 'percent' && (out.value ?? cur?.value) > 100) throw invalid('value', 'max_100');
    if (out.code && (await Promotion.exists({ code: ci(out.code), _id: { $ne: cur?._id } }))) throw conflict('duplicate', { field: 'code' });
    return out;
  },
  presentMany: async (rows, ctx) => {
    const today = T.today(ctx.tz);
    return rows.map((p) => ({ id: p._id, code: p.code, kind: p.kind, value: p.value, minAmount: p.minAmount, limit: p.limit, used: p.used, end: p.end || null, valid: promoValid(p, today), ...stamp(p, ctx) }));
  },
});

// ---------- customers ----------

const customerSearch = (c) => noAccent(`${c.name} ${c.phone} ${phoneKey(c.phone)}`);

async function presentCustomers(rows, ctx) {
  if (!rows.length) return [];
  const agg = await Order.aggregate([
    { $match: { customerId: { $in: rows.map((r) => r._id) }, status: 'closed' } },
    { $group: { _id: '$customerId', visits: { $sum: 1 }, totalSpent: { $sum: { $ifNull: ['$finalTotal', 0] } } } },
  ]);
  const by = Object.fromEntries(agg.map((x) => [x._id, x]));
  return rows.map((c) => ({
    id: c._id, name: c.name, phone: c.phone, allergy: c.allergy, pref: c.pref, attention: c.attention, birthday: c.birthday || null, points: c.points,
    visits: by[c._id]?.visits || 0, totalSpent: by[c._id]?.totalSpent || 0, ...stamp(c, ctx),
  }));
}

async function readCustomer(b, create, cur) {
  const out = pick(b, create, {
    name: (x) => V.str(x, 'name', { required: true, max: 100 }),
    phone: (x) => V.str(x, 'phone', { required: true, max: 30 }),
    allergy: (x) => V.str(x, 'allergy', { max: 500 }),
    pref: (x) => V.str(x, 'pref', { max: 500 }),
    attention: (x) => V.str(x, 'attention', { max: 500 }),
    birthday: (x) => V.date(x, 'birthday', { def: null }),
  });
  if (out.phone !== undefined) {
    out.phoneKey = phoneId(out.phone);
    if (out.phoneKey.length < 6) throw invalid('phone', 'invalid_format');
    const dup = await Customer.findOne({ phoneKey: out.phoneKey, _id: { $ne: cur?._id } }).select('_id').lean();
    if (dup) throw conflict('phone_taken', { customerId: dup._id });
  }
  out.search = customerSearch({ name: out.name ?? cur?.name, phone: out.phone ?? cur?.phone });
  return out;
}

const customersCrud = crud(Customer, {
  parse: readCustomer,
  presentMany: presentCustomers,
  async beforeDelete(c, auth) {
    await Order.updateMany({ customerId: c._id }, { $set: { customerId: null } });
    await audit.log(auth, 'customer_deleted', 'customer', c._id, '');
  },
});

async function listCustomers(q, ctx) {
  const f = {};
  if (q.q) {
    const n = noAccent(q.q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    f.search = { $regex: n };
  }
  return paginate(Customer, f, q, { field: 'createdAt', dir: -1, present: (rows) => presentCustomers(rows, ctx) });
}

async function mergeCustomers(auth, id, body, ctx) {
  const dropId = V.str(V.body(body), 'dropId', { required: true });
  if (dropId === id) throw invalid('dropId', 'invalid');
  await withTx(async (session) => {
    const o = session ? { session } : undefined;
    const keep = await Customer.findById(id).session(session || null).lean();
    const drop = await Customer.findById(dropId).session(session || null).lean();
    if (!keep || !drop) throw notFound();
    await Customer.updateOne({ _id: id }, { $set: { points: keep.points + drop.points, allergy: keep.allergy || drop.allergy, updatedAt: new Date() } }, o);
    await Order.updateMany({ customerId: dropId }, { $set: { customerId: id } }, o);
    await Customer.deleteOne({ _id: dropId }, o);
    await audit.log(auth, 'customer_merged', 'customer', id, '', o);
  });
  return customersCrud.get(id, ctx);
}

// ---------- expenses / targets ----------

const expenses = crud(Expense, {
  sort: { date: -1, createdAt: -1 },
  parse: (b, create) => pick(b, create, {
    category: (x) => V.str(x, 'category', { required: true, max: 80 }), amount: (x) => V.int(x, 'amount', { required: true, min: 0, max: 100_000_000_000 }),
    date: (x) => V.date(x, 'date', { required: true }), recurring: (x) => V.bool(x, 'recurring', { def: false }), note: (x) => V.str(x, 'note', { max: 300 }),
  }),
  present: (e, ctx) => ({ id: e._id, category: e.category, amount: e.amount, date: e.date, recurring: e.recurring, note: e.note, ...stamp(e, ctx) }),
  filter: (q) => {
    const f = {};
    if (q.from) f.date = { $gte: String(q.from) };
    if (q.to) f.date = { ...f.date, $lt: String(q.to) };
    return f;
  },
});

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
async function getTarget(month) {
  if (!MONTH.test(month)) throw invalid('month', 'invalid_format');
  const t = await SalesTarget.findById(month).lean();
  return { month, targetRevenue: t?.targetRevenue || 0 };
}
async function putTarget(month, body) {
  if (!MONTH.test(month)) throw invalid('month', 'invalid_format');
  const targetRevenue = V.int(V.body(body), 'targetRevenue', { required: true, min: 0, max: 1e12 });
  await SalesTarget.updateOne({ _id: month }, { $set: { targetRevenue, updatedAt: new Date() }, $setOnInsert: { createdAt: new Date() } }, { upsert: true });
  return { month, targetRevenue };
}

module.exports = {
  areas, tables, groups, items, ingredients, suppliers, staff, promotions, customers: customersCrud, expenses,
  presentTable, presentItems, setRecipe, getRecipe, itemCost, bulkPrice, listCustomers, mergeCustomers, readCustomer, customerSearch,
  getTarget, putTarget, promoValid, AppError, business, Booking, uuid, iso,
};
