/** Cash shifts and till entries (spec 4.14, 5.5). */
const { Shift, CashEntry, Order } = require('../models');
const V = require('../lib/validate');
const { business, notFound, invalid } = require('../lib/errors');
const { uuid } = require('../lib/util');
const { withTx } = require('../lib/tx');
const audit = require('./audit');

const opts = (session) => (session ? { session } : undefined);

/** Cash in the drawer from payments during the shift: pay and tip add, refund subtracts, deposit counts for nothing. */
async function cashIn(shift, ctx) {
  void ctx;
  const to = shift.closedAt || new Date(Date.now() + 86400000);
  const rows = await Order.aggregate([
    { $match: { 'payments.at': { $gte: shift.openedAt, $lt: to } } },
    { $unwind: '$payments' },
    { $match: { 'payments.method': 'cash', 'payments.at': { $gte: shift.openedAt, $lt: to } } },
    { $group: { _id: '$payments.kind', sum: { $sum: '$payments.amount' } } },
  ]);
  const by = Object.fromEntries(rows.map((r) => [r._id, r.sum]));
  return (by.pay || 0) + (by.tip || 0) - (by.refund || 0);
}

async function entriesTotal(shiftId) {
  const r = await CashEntry.aggregate([{ $match: { shiftId } }, { $group: { _id: null, sum: { $sum: '$amount' } } }]);
  return r[0]?.sum || 0;
}

async function present(s, ctx) {
  const [cash, entries] = await Promise.all([cashIn(s, ctx), entriesTotal(s._id)]);
  const expected = s.closedAt && s.expectedCash !== null ? s.expectedCash : s.startCash + cash + entries;
  return {
    cashIn: cash, entriesTotal: entries,
    id: s._id, openedBy: s.openedBy, openedAt: ctx.iso(s.openedAt), closedAt: s.closedAt ? ctx.iso(s.closedAt) : null, startCash: s.startCash,
    countedCash: s.countedCash ?? null, expectedCash: expected, difference: s.difference ?? null,
  };
}

const current = () => Shift.findOne({ closedAt: null }).sort({ openedAt: -1 }).lean();

async function getCurrent(ctx) {
  const s = await current();
  if (!s) throw notFound();
  return present(s, ctx);
}

async function list(q, ctx) {
  const n = Number.parseInt(q.limit, 10);
  const rows = await Shift.find({}).sort({ openedAt: -1 }).limit(n > 0 ? Math.min(n, 200) : 50).lean();
  return { items: await Promise.all(rows.map((s) => present(s, ctx))) };
}

/** An already open shift is returned as is (no error): retries and two devices are fine. */
async function open(auth, body, ctx) {
  const existing = await current();
  if (existing) return { status: 200, body: await present(existing, ctx) };
  const startCash = V.int(V.body(body), 'startCash', { required: true, min: 0, max: 1e11 });
  const now = new Date();
  const doc = { _id: uuid(), openedBy: auth.name, openedAt: now, closedAt: null, startCash, countedCash: null, expectedCash: null, difference: null, createdAt: now, updatedAt: now };
  await Shift.create(doc);
  return { status: 201, body: await present(doc, ctx) };
}

async function close(auth, body, ctx) {
  const s = await current();
  if (!s) throw business('shift_not_open');
  const countedCash = V.int(V.body(body), 'countedCash', { required: true, min: 0, max: 1e11 });
  const count = await Order.countDocuments({ status: 'open' });
  if (count) throw business('open_orders_exist', { count });
  const closedAt = new Date();
  const expectedCash = s.startCash + (await cashIn({ ...s, closedAt }, ctx)) + (await entriesTotal(s._id));
  const difference = countedCash - expectedCash;
  await withTx(async (session) => {
    await Shift.updateOne({ _id: s._id }, { $set: { closedAt, countedCash, expectedCash, difference, updatedAt: closedAt } }, opts(session));
    await audit.log(auth, 'shift_closed', 'shift', s._id, `difference ${difference}`, opts(session));
  });
  return present(await Shift.findById(s._id).lean(), ctx);
}

const presentEntry = (e, ctx) => ({ id: e._id, shiftId: e.shiftId, amount: e.amount, reason: e.reason, at: ctx.iso(e.at) });

async function listEntries(q, ctx) {
  let shiftId = q.shiftId ? String(q.shiftId) : null;
  if (!shiftId) shiftId = (await current())?._id;
  if (!shiftId) return { items: [] };
  return { items: (await CashEntry.find({ shiftId }).sort({ at: 1 }).lean()).map((e) => presentEntry(e, ctx)) };
}

async function addEntry(body, ctx) {
  const b = V.body(body);
  const amount = V.int(b, 'amount', { required: true, min: -1e11, max: 1e11 });
  if (amount === 0) throw invalid('amount', 'invalid');
  const reason = V.str(b, 'reason', { required: true, max: 200 });
  const s = await current();
  if (!s) throw business('shift_not_open');
  const now = new Date();
  const doc = { _id: uuid(), shiftId: s._id, amount, reason, at: now, createdAt: now, updatedAt: now };
  await CashEntry.create(doc);
  return { status: 201, body: presentEntry(doc, ctx) };
}

async function removeEntry(id) {
  const e = await CashEntry.findById(id).lean();
  if (!e) throw notFound();
  const s = await Shift.findById(e.shiftId).lean();
  if (s?.closedAt) throw business('invalid_state', { reason: 'shift_closed' });
  await CashEntry.deleteOne({ _id: id });
}

module.exports = { cashIn, getCurrent, list, open, close, listEntries, addEntry, removeEntry };
