/**
 * Bookings, wait list and floor plan (spec 4.4, 4.13). Two `booked` reservations of the same table must not overlap in
 * [start, start + duration + 10 min). The check runs in one transaction; per-table lock documents make two concurrent
 * transactions write-conflict, so one of them re-checks and sees the other's booking.
 */
const { Booking, Table, Area, WaitEntry, Order, Counter } = require('../models');
const V = require('../lib/validate');
const { business, conflict, notFound, invalid } = require('../lib/errors');
const { uuid, noAccent, phoneKey } = require('../lib/util');
const { withTx } = require('../lib/tx');
const T = require('../lib/time');
const audit = require('./audit');
const orders = require('./orders');
const catalog = require('./catalog');

const BUFFER_MIN = 10;
const opts = (session) => (session ? { session } : undefined);
const withS = (q, session) => (session ? q.session(session) : q);

const span = (date, startMin, durationMin, tz) => {
  const startAt = T.localToUtc(date, T.hhmm(startMin), tz);
  return { startAt, endAt: new Date(startAt.getTime() + (durationMin + BUFFER_MIN) * 60000) };
};

function present(b, ctx) {
  const late = b.status === 'booked' && b.date === T.today(ctx.tz) && ctx.now.getTime() > new Date(b.startAt).getTime() + ctx.rules.holdMinutes * 60000;
  return {
    id: b._id, name: b.name, phone: b.phone, party: b.party, date: b.date, startMin: b.startMin, durationMin: b.durationMin, note: b.note, areaPref: b.areaPref,
    deposit: b.deposit, status: b.status, isLate: late, tableIds: b.tableIds, createdAt: ctx.iso(b.createdAt), updatedAt: ctx.iso(b.updatedAt),
  };
}

async function lockTables(ids, session) {
  if (!session) return;
  for (const id of [...ids].sort()) await Counter.updateOne({ _id: `booklock|${id}` }, { $inc: { seq: 1 } }, { upsert: true, session });
}

async function assertNoOverlap(tableIds, startAt, endAt, ignoreId, session) {
  const clash = await withS(Booking.find({ status: 'booked', tableIds: { $in: tableIds }, startAt: { $lt: endAt }, endAt: { $gt: startAt }, _id: { $ne: ignoreId || '' } }), session).lean();
  if (clash.length) {
    const hit = [...new Set(clash.flatMap((c) => c.tableIds.filter((t) => tableIds.includes(t))))];
    throw conflict('booking_overlap', { tableIds: hit, bookingIds: clash.map((c) => c._id) });
  }
}

async function checkTables(tableIds, party, session) {
  const tabs = await withS(Table.find({ _id: { $in: tableIds } }), session).lean();
  if (tabs.length !== tableIds.length) throw invalid('tableIds', 'not_found');
  if (tabs.reduce((s, t) => s + t.seats, 0) < party) throw business('not_enough_seats', { seats: tabs.reduce((s, t) => s + t.seats, 0), party });
}

function readTableIds(b) {
  const ids = V.arr(b, 'tableIds', { max: 20 });
  if (!ids || !ids.length) throw invalid('tableIds', 'required');
  if (ids.some((x) => typeof x !== 'string' || !x)) throw invalid('tableIds', 'invalid_type');
  return [...new Set(ids)];
}

async function create(body, ctx) {
  const b = V.body(body);
  const doc = {
    _id: uuid(),
    name: V.str(b, 'name', { required: true, max: 100 }), phone: V.str(b, 'phone', { max: 30 }),
    party: V.int(b, 'party', { required: true, min: 1, max: 500 }),
    date: V.date(b, 'date', { required: true }),
    startMin: V.int(b, 'startMin', { required: true, min: 0, max: 1439 }),
    durationMin: V.int(b, 'durationMin', { min: 15, max: 720, def: ctx.rules.seatMinutes }),
    note: V.str(b, 'note', { max: 300 }), areaPref: V.str(b, 'areaPref', { max: 80 }), deposit: V.int(b, 'deposit', { min: 0, max: 1e10, def: 0 }),
    tableIds: readTableIds(b), status: 'booked', createdAt: new Date(), updatedAt: new Date(),
  };
  Object.assign(doc, span(doc.date, doc.startMin, doc.durationMin, ctx.tz));
  doc.search = noAccent(`${doc.name} ${doc.phone} ${phoneKey(doc.phone)}`);
  await withTx(async (session) => {
    await lockTables(doc.tableIds, session);
    await checkTables(doc.tableIds, doc.party, session);
    await assertNoOverlap(doc.tableIds, doc.startAt, doc.endAt, null, session);
    await Booking.create([doc], opts(session));
  });
  return { status: 201, body: present(doc, ctx) };
}

async function patch(id, body, ctx) {
  const cur = await Booking.findById(id).lean();
  if (!cur) throw notFound();
  if (cur.status !== 'booked') throw business('invalid_state', { status: cur.status });
  const b = V.body(body);
  const next = { ...cur };
  if (V.has(b, 'name')) next.name = V.str(b, 'name', { required: true, max: 100 });
  if (V.has(b, 'phone')) next.phone = V.str(b, 'phone', { max: 30 });
  if (V.has(b, 'party')) next.party = V.int(b, 'party', { required: true, min: 1, max: 500 });
  if (V.has(b, 'date')) next.date = V.date(b, 'date', { required: true });
  if (V.has(b, 'startMin')) next.startMin = V.int(b, 'startMin', { required: true, min: 0, max: 1439 });
  if (V.has(b, 'durationMin')) next.durationMin = V.int(b, 'durationMin', { required: true, min: 15, max: 720 });
  if (V.has(b, 'note')) next.note = V.str(b, 'note', { max: 300 });
  if (V.has(b, 'areaPref')) next.areaPref = V.str(b, 'areaPref', { max: 80 });
  if (V.has(b, 'deposit')) next.deposit = V.int(b, 'deposit', { min: 0, max: 1e10 });
  if (V.has(b, 'tableIds')) next.tableIds = readTableIds(b);
  Object.assign(next, span(next.date, next.startMin, next.durationMin, ctx.tz));
  next.search = noAccent(`${next.name} ${next.phone} ${phoneKey(next.phone)}`);
  next.updatedAt = new Date();
  await withTx(async (session) => {
    await lockTables(next.tableIds, session);
    await checkTables(next.tableIds, next.party, session);
    await assertNoOverlap(next.tableIds, next.startAt, next.endAt, id, session); // the booking being edited never clashes with itself
    const { _id, ...rest } = next;
    void _id;
    await Booking.updateOne({ _id: id }, { $set: rest }, opts(session));
  });
  return present(next, ctx);
}

async function setStatus(auth, id, body, ctx) {
  const cur = await Booking.findById(id).lean();
  if (!cur) throw notFound();
  const status = V.oneOf(V.body(body), 'status', ['noshow', 'cancelled', 'booked'], { required: true });
  if (cur.status === 'arrived') throw business('invalid_state', { status: cur.status });
  await withTx(async (session) => {
    if (status === 'booked') {
      await lockTables(cur.tableIds, session);
      await assertNoOverlap(cur.tableIds, cur.startAt, cur.endAt, id, session);
    }
    await Booking.updateOne({ _id: id }, { $set: { status, updatedAt: new Date() } }, opts(session));
  });
  void auth;
  return present(await Booking.findById(id).lean(), ctx);
}

async function remove(auth, id) {
  const cur = await Booking.findById(id).lean();
  if (!cur) throw notFound();
  await audit.log(auth, 'booking_deleted', 'booking', id, cur.date);
  await Booking.deleteOne({ _id: id });
}

/** Guest arrived: opens the first free table of the booking. `order` is null when every table is busy. */
async function arrive(auth, id, ctx) {
  const cur = await Booking.findById(id).lean();
  if (!cur) throw notFound();
  if (cur.status !== 'booked') throw business('invalid_state', { status: cur.status });
  let order = null;
  for (const tableId of cur.tableIds) {
    try {
      // eslint-disable-next-line no-await-in-loop
      order = await withTx((session) => orders.openTable(tableId, { party: cur.party, customerName: cur.name, phone: cur.phone }, auth, ctx, session));
      break;
    } catch (err) {
      if (err.code !== 'table_in_use' && err.code !== 'not_found') throw err;
    }
  }
  await Booking.updateOne({ _id: id }, { $set: { status: 'arrived', updatedAt: new Date() } });
  return { booking: present(await Booking.findById(id).lean(), ctx), order: order ? orders.present(order, ctx) : null };
}

async function list(q, ctx) {
  const f = {};
  if (q.date) f.date = String(q.date);
  else if (q.from || q.to) f.date = { ...(q.from ? { $gte: String(q.from) } : {}), ...(q.to ? { $lt: String(q.to) } : {}) };
  if (q.status) f.status = { $in: String(q.status).split(',') };
  const rows = await Booking.find(f).sort({ date: 1, startMin: 1, _id: 1 }).limit(2000).lean();
  return { items: rows.map((b) => present(b, ctx)) };
}

/** Free tables for a slot (4.13): enough seats, no overlapping booking, and not occupied right now when the slot is imminent. */
async function availability(q, ctx) {
  const date = V.date(q, 'date', { required: true });
  const startMin = Number.parseInt(q.startMin, 10);
  if (!Number.isInteger(startMin) || startMin < 0 || startMin > 1439) throw invalid('startMin', 'invalid_format');
  const durationMin = q.durationMin ? Number.parseInt(q.durationMin, 10) : ctx.rules.seatMinutes;
  const party = q.party ? Number.parseInt(q.party, 10) : 1;
  if (!(durationMin > 0) || !(party > 0)) throw invalid('durationMin', 'invalid_format');
  const { startAt, endAt } = span(date, startMin, durationMin, ctx.tz);
  const now = ctx.now.getTime();
  const [tabs, clash] = await Promise.all([
    Table.find({ seats: { $gte: party } }).lean(),
    Booking.find({ status: 'booked', startAt: { $lt: endAt }, endAt: { $gt: startAt }, _id: { $ne: q.ignoreBookingId ? String(q.ignoreBookingId) : '' } }).select('tableIds').lean(),
  ]);
  const taken = new Set(clash.flatMap((c) => c.tableIds));
  const imminent = startAt.getTime() < now + 60 * 60000 && endAt.getTime() > now;
  const free = tabs.filter((t) => !taken.has(t._id) && !(imminent && t.currentOrderId));
  free.sort((a, b) => a.seats - b.seats || a.label.localeCompare(b.label));
  return { items: free.map((t) => catalog.presentTable(t, ctx)) };
}

// ---------- wait list ----------

const presentWait = (w, ctx) => ({ id: w._id, name: w.name, phone: w.phone, party: w.party, joinedAt: ctx.iso(w.joinedAt) });
async function listWait(ctx) {
  return { items: (await WaitEntry.find({}).sort({ joinedAt: 1 }).lean()).map((w) => presentWait(w, ctx)) };
}
async function addWait(body, ctx) {
  const b = V.body(body);
  const doc = { _id: uuid(), name: V.str(b, 'name', { required: true, max: 100 }), phone: V.str(b, 'phone', { max: 30 }), party: V.int(b, 'party', { min: 1, max: 500, def: 1 }), joinedAt: new Date(), createdAt: new Date(), updatedAt: new Date() };
  await WaitEntry.create(doc);
  return presentWait(doc, ctx);
}
async function removeWait(id) {
  const r = await WaitEntry.deleteOne({ _id: id });
  if (!r.deletedCount) throw notFound();
}

// ---------- floor (4.4) ----------

async function floor(ctx) {
  const now = ctx.now;
  const [areas, tabs, upcoming] = await Promise.all([
    Area.find({}).sort({ sort: 1, createdAt: 1 }).lean(),
    Table.find({}).sort({ label: 1 }).lean(),
    // held (late but within hold) and upcoming within 60 min both reserve the table
    Booking.find({ status: 'booked', startAt: { $gte: new Date(now.getTime() - ctx.rules.holdMinutes * 60000), $lte: new Date(now.getTime() + 60 * 60000) } }).sort({ startAt: 1 }).lean(),
  ]);
  const orderIds = tabs.map((t) => t.currentOrderId).filter(Boolean);
  const ords = orderIds.length ? await Order.find({ _id: { $in: orderIds } }).lean() : [];
  const oBy = Object.fromEntries(ords.map((o) => [o._id, o]));
  const nextBy = {};
  for (const b of upcoming) for (const tid of b.tableIds) if (!nextBy[tid]) nextBy[tid] = b;
  return {
    areas: areas.map((a) => ({ id: a._id, name: a.name })),
    tables: tabs.map((t) => {
      const o = t.currentOrderId ? oBy[t.currentOrderId] : null;
      const nb = nextBy[t._id];
      return {
        id: t._id, areaId: t.areaId, label: t.label, seats: t.seats, canMerge: t.canMerge, status: t.status,
        order: o ? { id: o._id, code: o.code, party: o.party, openedAt: ctx.iso(o.openedAt), total: orders.totals(o, orders.rulesFor(o, ctx)).total } : null,
        nextBooking: nb ? { id: nb._id, startMin: nb.startMin, date: nb.date } : null,
      };
    }),
  };
}

async function cleanTable(id) {
  const r = await Table.findOneAndUpdate({ _id: id, status: 'cleaning' }, { $set: { status: 'free', updatedAt: new Date() } }, { new: true }).lean();
  if (!r) {
    const t = await Table.findById(id).lean();
    if (!t) throw notFound();
    throw business('invalid_state', { status: t.status });
  }
  return r;
}

module.exports = { present, create, patch, setStatus, remove, arrive, list, availability, listWait, addWait, removeWait, floor, cleanTable };
