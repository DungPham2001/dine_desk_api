/**
 * Stock (spec 4.8, 4.9, 5.3, 5.6, 5.7). The ledger (`StockMove`) is append-only: onHand = Σ qty. Lots (`StockLot`)
 * carry the remaining quantity per receipt and are drawn FEFO (earliest expiry first, no expiry last). Stock may go
 * negative: selling is never blocked by a short count, only the item shows as unavailable.
 */
const { Ingredient, StockLot, StockMove, MenuItem, Purchase, Supplier } = require('../models');
const V = require('../lib/validate');
const { business, notFound, invalid } = require('../lib/errors');
const { uuid, noAccent } = require('../lib/util');
const { paginate } = require('../lib/page');
const { withTx } = require('../lib/tx');
const T = require('../lib/time');
const audit = require('./audit');

const r3 = (n) => Math.round(n * 1000) / 1000;
const withS = (q, session) => (session ? q.session(session) : q);
const opts = (session) => (session ? { session } : undefined);

// ---------- reads ----------

/** { ingredientId: onHand } for the given ids (all when omitted). */
async function onHandMap(ids, session) {
  const match = ids ? { $match: { ingredientId: { $in: ids } } } : { $match: {} };
  const rows = await withS(StockMove.aggregate([match, { $group: { _id: '$ingredientId', qty: { $sum: '$qty' } } }]), session);
  return Object.fromEntries(rows.map((x) => [x._id, r3(x.qty)]));
}

/** { ingredientId: unitCost of the most recently received lot }. */
async function lastCostMap(ids) {
  const match = ids ? { $match: { ingredientId: { $in: ids } } } : { $match: {} };
  const rows = await StockLot.aggregate([match, { $sort: { receivedAt: -1, _id: -1 } }, { $group: { _id: '$ingredientId', cost: { $first: '$unitCost' } } }]);
  return Object.fromEntries(rows.map((x) => [x._id, x.cost]));
}

async function presentIngredients(rows) {
  if (!rows.length) return [];
  const ids = rows.map((x) => x._id);
  const [hand, cost] = await Promise.all([onHandMap(ids), lastCostMap(ids)]);
  return rows.map((g) => ({
    id: g._id, name: g.name, unit: g.unit, group: g.group, minQty: g.minQty, supplierId: g.supplierId || null,
    onHand: hand[g._id] || 0, lastCost: cost[g._id] ?? null, createdAt: g.createdAt.toISOString(), updatedAt: g.updatedAt.toISOString(),
  }));
}

/** Cost of one portion (5.7): null when there is no recipe or any ingredient never received. */
function itemCost(item, costMap) {
  if (!item?.recipe?.length) return null;
  let sum = 0;
  for (const l of item.recipe) {
    const c = costMap[l.ingredientId];
    if (c === undefined || c === null) return null;
    sum += l.qty * c;
  }
  return Math.round(sum);
}

/** Per item: { available, unavailableReason } (5.6). */
function availability(item, hand) {
  if (item.status !== 'on') return { available: false, unavailableReason: 'status' };
  for (const l of item.recipe || []) if ((hand[l.ingredientId] || 0) < l.qty) return { available: false, unavailableReason: 'stock' };
  return { available: true, unavailableReason: null };
}

// ---------- writes (ledger) ----------

const fefo = (a, b) => {
  if (a.expiry && b.expiry && a.expiry !== b.expiry) return a.expiry < b.expiry ? -1 : 1;
  if (!a.expiry && b.expiry) return 1;
  if (a.expiry && !b.expiry) return -1;
  return new Date(a.receivedAt) - new Date(b.receivedAt);
};

/** Draws `qty` FEFO and writes one ledger entry of -qty (even when the lots are short). */
async function deduct(ingredientId, qty, { kind, note = '', orderId = null, at = new Date() }, session) {
  const amount = r3(qty);
  if (!(amount > 0)) return null;
  const lots = (await withS(StockLot.find({ ingredientId, remaining: { $gt: 0 } }), session).lean()).sort(fefo);
  let need = amount;
  const alloc = [];
  for (const lot of lots) {
    if (need <= 0) break;
    const take = r3(Math.min(need, lot.remaining));
    const res = await StockLot.updateOne({ _id: lot._id, remaining: { $gte: take } }, { $inc: { remaining: -take }, $set: { updatedAt: new Date() } }, opts(session));
    if (res.modifiedCount) {
      alloc.push({ lotId: lot._id, qty: take });
      need = r3(need - take);
    }
  }
  const [move] = await StockMove.create([{ _id: uuid(), ingredientId, qty: -amount, kind, note, orderId, lots: alloc, at }], opts(session));
  return move;
}

async function addMove(ingredientId, qty, kind, note, session) {
  await StockMove.create([{ _id: uuid(), ingredientId, qty: r3(qty), kind, note, at: new Date() }], opts(session));
}

/** Undo the `sale` moves of an order (reopen): positive entry, quantities go back to their lots. */
async function reverseSales(orderId, code, session) {
  const moves = await withS(StockMove.find({ orderId, kind: 'sale', qty: { $lt: 0 }, reversed: { $ne: true } }), session).lean();
  for (const m of moves) {
    for (const a of m.lots || []) await StockLot.updateOne({ _id: a.lotId }, { $inc: { remaining: a.qty }, $set: { updatedAt: new Date() } }, opts(session));
    await StockMove.create([{ _id: uuid(), ingredientId: m.ingredientId, qty: -m.qty, kind: 'sale', note: `Hoàn đơn ${code}`, orderId, at: new Date(), reversed: true }], opts(session));
    await StockMove.updateOne({ _id: m._id }, { $set: { reversed: true } }, opts(session));
  }
}

async function createLot({ ingredientId, purchaseId = null, qty, unitCost, expiry, at }, session) {
  const now = new Date();
  const lot = { _id: uuid(), ingredientId, purchaseId, received: r3(qty), remaining: r3(qty), unitCost, expiry: expiry || null, receivedAt: at || now, createdAt: now, updatedAt: now };
  await StockLot.create([lot], opts(session));
  await addMove(ingredientId, qty, 'receive', purchaseId ? 'Phiếu nhập' : 'Nhập kho', session);
  return lot;
}

const ingredientOr404 = async (id, session) => {
  const g = id ? await withS(Ingredient.findById(id), session).lean() : null;
  if (!g) throw invalid('ingredientId', 'not_found');
  return g;
};

// ---------- endpoints ----------

const presentLot = (l) => ({
  id: l._id, ingredientId: l.ingredientId, purchaseId: l.purchaseId || null, received: l.received, remaining: l.remaining, unitCost: l.unitCost,
  expiry: l.expiry || null, receivedAt: new Date(l.receivedAt).toISOString(),
});

async function listLots(q) {
  const f = {};
  if (q.ingredientId) f.ingredientId = String(q.ingredientId);
  if (q.remaining === 'gt0') f.remaining = { $gt: 0 };
  const rows = await StockLot.find(f).sort({ receivedAt: -1, _id: -1 }).limit(1000).lean();
  return { items: rows.map(presentLot) };
}

async function patchLot(id, body) {
  const lot = await StockLot.findById(id).lean();
  if (!lot) throw notFound();
  const b = V.body(body);
  const expiry = V.date(b, 'expiry', { required: true });
  await StockLot.updateOne({ _id: id }, { $set: { expiry, updatedAt: new Date() } });
  return presentLot(await StockLot.findById(id).lean());
}

async function deleteLot(auth, id) {
  const lot = await StockLot.findById(id).lean();
  if (!lot) throw notFound();
  await withTx(async (session) => {
    if (lot.remaining) await addMove(lot.ingredientId, -lot.remaining, 'count', 'Xóa lô', session);
    await StockLot.deleteOne({ _id: id }, opts(session));
    await audit.log(auth, 'lot_deleted', 'lot', id, `${lot.remaining}`, opts(session));
  });
}

const presentMove = (m, ctx) => ({ id: m._id, ingredientId: m.ingredientId, qty: m.qty, kind: m.kind, note: m.note, at: ctx.iso(m.at) });

async function listMoves(q, ctx) {
  const f = {};
  if (q.ingredientId) f.ingredientId = String(q.ingredientId);
  if (q.kinds) f.kind = { $in: String(q.kinds).split(',').map((s) => s.trim()).filter(Boolean) };
  return paginate(StockMove, f, q, { field: 'at', present: (rows) => rows.map((m) => presentMove(m, ctx)) });
}

async function receive(body) {
  const b = V.body(body);
  const g = await ingredientOr404(V.str(b, 'ingredientId', { required: true }));
  const qty = V.num(b, 'qty', { required: true, min: 0.001, max: 1e9 });
  const unitCost = V.int(b, 'unitCost', { min: 0, def: 0 });
  const expiry = V.date(b, 'expiry', { def: null });
  await withTx((session) => createLot({ ingredientId: g._id, qty, unitCost, expiry }, session));
  return (await presentIngredients([await Ingredient.findById(g._id).lean()]))[0];
}

async function waste(auth, body) {
  const b = V.body(body);
  const g = await ingredientOr404(V.str(b, 'ingredientId', { required: true }));
  const qty = V.num(b, 'qty', { required: true, min: 0.001, max: 1e9 });
  const reason = V.str(b, 'reason', { max: 300 });
  if (!reason) throw business('reason_required');
  await withTx(async (session) => {
    await deduct(g._id, qty, { kind: 'waste', note: reason }, session);
    await audit.log(auth, 'waste', 'ingredient', g._id, `${qty} ${g.unit}: ${reason}`, opts(session));
  });
  return (await presentIngredients([await Ingredient.findById(g._id).lean()]))[0];
}

async function stocktake(auth, body) {
  const b = V.body(body);
  const g = await ingredientOr404(V.str(b, 'ingredientId', { required: true }));
  const counted = V.num(b, 'countedQty', { required: true, min: 0, max: 1e9 });
  const note = V.str(b, 'note', { max: 300 });
  await withTx(async (session) => {
    const onHand = (await onHandMap([g._id], session))[g._id] || 0;
    const diff = r3(counted - onHand);
    if (diff < 0) await deduct(g._id, -diff, { kind: 'count', note: note || 'Kiểm kho' }, session);
    else if (diff > 0) await addMove(g._id, diff, 'count', note || 'Kiểm kho', session);
    if (diff !== 0) await audit.log(auth, 'stocktake', 'ingredient', g._id, `diff ${diff}`, opts(session));
  });
  return (await presentIngredients([await Ingredient.findById(g._id).lean()]))[0];
}

async function reorderSuggestions(ctx) {
  const now = ctx.now;
  const since = new Date(now.getTime() - 14 * 86400000);
  const [ings, first, used] = await Promise.all([
    Ingredient.find({}).lean(),
    StockMove.findOne({}).sort({ at: 1 }).select('at').lean(),
    StockMove.aggregate([{ $match: { kind: 'sale', at: { $gte: since } } }, { $group: { _id: '$ingredientId', qty: { $sum: { $multiply: ['$qty', -1] } } } }]),
  ]);
  const usedBy = Object.fromEntries(used.map((u) => [u._id, u.qty]));
  const hand = await onHandMap();
  const items = [];
  for (const g of ings) {
    const cons = usedBy[g._id] || 0;
    if (!(g.minQty > 0) && !(cons > 0)) continue;
    const onH = hand[g._id] || 0;
    const suggested = r3(g.minQty + (cons / 14) * 3 - onH);
    if (suggested > 0) items.push({ ingredientId: g._id, name: g.name, unit: g.unit, onHand: onH, suggestedQty: suggested });
  }
  items.sort((a, b) => b.suggestedQty - a.suggestedQty);
  return { enoughData: !!first && now.getTime() - new Date(first.at).getTime() >= 7 * 86400000, items };
}

// ---------- purchases ----------

const presentPurchase = (p, ctx) => ({
  id: p._id, supplierId: p.supplierId || null, date: ctx.iso(p.date), method: p.method, note: p.note, total: p.total,
  lines: p.lines.map((l) => ({ ingredientId: l.ingredientId, qty: l.qty, unitCost: l.unitCost, expiry: l.expiry || null })),
  createdAt: ctx.iso(p.createdAt), updatedAt: ctx.iso(p.updatedAt),
});

async function readPurchase(body) {
  const b = V.body(body);
  const supplierId = V.str(b, 'supplierId', { def: null }) || null;
  if (supplierId && !(await Supplier.exists({ _id: supplierId }))) throw invalid('supplierId', 'not_found');
  const lines = V.arr(b, 'lines');
  if (!lines || !lines.length) throw invalid('lines', 'required');
  const out = [];
  for (const [i, raw] of lines.entries()) {
    const l = V.body(raw);
    const f = (k) => `lines[${i}].${k}`;
    const ingredientId = V.str(l, 'ingredientId', { required: true });
    if (!(await Ingredient.exists({ _id: ingredientId }))) throw invalid(f('ingredientId'), 'not_found');
    out.push({
      ingredientId,
      qty: (() => { try { return V.num(l, 'qty', { required: true, min: 0.001, max: 1e9 }); } catch (e) { throw invalid(f('qty'), e.details?.reason); } })(),
      unitCost: (() => { try { return V.int(l, 'unitCost', { min: 0, max: 1e9, def: 0 }); } catch (e) { throw invalid(f('unitCost'), e.details?.reason); } })(),
      expiry: (() => { try { return V.date(l, 'expiry', { def: null }); } catch (e) { throw invalid(f('expiry'), e.details?.reason); } })(),
    });
  }
  return {
    supplierId,
    method: V.oneOf(b, 'method', ['cash', 'transfer'], { def: 'cash' }),
    note: V.str(b, 'note', { max: 300 }),
    date: V.datetime(b, 'date', { def: null }),
    lines: out,
    total: out.reduce((s, l) => s + Math.round(l.qty * l.unitCost), 0),
  };
}

async function applyPurchase(id, p, session) {
  for (const l of p.lines) await createLot({ ingredientId: l.ingredientId, purchaseId: id, qty: l.qty, unitCost: l.unitCost, expiry: l.expiry, at: p.date || undefined }, session);
}

/** Removes the lots of a purchase and writes `count` entries of -received per lot (even when partly used, spec 4.9). */
async function undoPurchase(id, session) {
  const lots = await withS(StockLot.find({ purchaseId: id }), session).lean();
  for (const lot of lots) await addMove(lot.ingredientId, -lot.received, 'count', 'Sửa/xóa phiếu nhập', session);
  await StockLot.deleteMany({ purchaseId: id }, opts(session));
}

async function createPurchase(auth, body, ctx) {
  const p = await readPurchase(body);
  const id = uuid();
  const now = new Date();
  await withTx(async (session) => {
    await Purchase.create([{ _id: id, ...p, date: p.date || now, createdAt: now, updatedAt: now }], opts(session));
    await applyPurchase(id, p, session);
  });
  return { status: 201, body: presentPurchase(await Purchase.findById(id).lean(), ctx) };
}

async function updatePurchase(auth, id, body, ctx) {
  const cur = await Purchase.findById(id).lean();
  if (!cur) throw notFound();
  const p = await readPurchase(body);
  await withTx(async (session) => {
    await undoPurchase(id, session);
    await Purchase.updateOne({ _id: id }, { $set: { ...p, date: p.date || cur.date, updatedAt: new Date() } }, opts(session));
    await applyPurchase(id, { ...p, date: p.date || cur.date }, session);
    await audit.log(auth, 'purchase_edited', 'purchase', id, `${cur.total} -> ${p.total}`, opts(session));
  });
  return presentPurchase(await Purchase.findById(id).lean(), ctx);
}

async function deletePurchase(auth, id) {
  const cur = await Purchase.findById(id).lean();
  if (!cur) throw notFound();
  await withTx(async (session) => {
    await undoPurchase(id, session);
    await Purchase.deleteOne({ _id: id }, opts(session));
    await audit.log(auth, 'purchase_deleted', 'purchase', id, `${cur.total}`, opts(session));
  });
}

async function getPurchase(id, ctx) {
  const p = await Purchase.findById(id).lean();
  if (!p) throw notFound();
  return presentPurchase(p, ctx);
}

async function listPurchases(q, ctx) {
  const f = {};
  if (q.supplierId) f.supplierId = String(q.supplierId);
  const range = {};
  if (q.from) range.$gte = T.localToUtc(String(q.from), '00:00', ctx.tz);
  if (q.to) range.$lt = T.localToUtc(String(q.to), '00:00', ctx.tz);
  if (Object.keys(range).length) f.date = range;
  return paginate(Purchase, f, q, { field: 'date', present: (rows) => rows.map((p) => presentPurchase(p, ctx)) });
}

module.exports = {
  r3, onHandMap, lastCostMap, presentIngredients, itemCost, availability, deduct, reverseSales, listLots, patchLot, deleteLot, listMoves, receive, waste, stocktake,
  reorderSuggestions, createPurchase, updatePurchase, deletePurchase, getPurchase, listPurchases, noAccent, MenuItem,
};
