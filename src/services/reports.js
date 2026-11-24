/**
 * Dashboard, reports, exports, search and reminders (spec 4.15-4.18, 5.4, 5.7). Everything is aggregated in MongoDB
 * and bucketed in the restaurant's timezone; ranges are half-open [from, to).
 */
const { Order, MenuItem, MenuGroup, Ingredient, StockLot, Table, Booking, Customer, Shift, Expense, SalesTarget } = require('../models');
const V = require('../lib/validate');
const { invalid } = require('../lib/errors');
const { noAccent } = require('../lib/util');
const T = require('../lib/time');
const stock = require('./stock');
const orders = require('./orders');
const shifts = require('./shifts');

const RANGES = { today: 0, d7: 6, d14: 13, m1: 29, m3: 89, m6: 179, y1: 364 };
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Σ of lines that count toward the bill (not comp, not cancelled): spec 5.1. */
const SUB = { $sum: { $map: { input: '$lines', as: 'l', in: { $cond: [{ $or: [{ $eq: ['$$l.comp', true] }, { $eq: ['$$l.status', 'cancelled'] }] }, 0, { $multiply: ['$$l.qty', '$$l.unitPrice'] }] } } } };

// ---------- ranges (4.15) ----------

async function resolveRange(q, ctx) {
  const today = T.today(ctx.tz);
  let from;
  let to;
  if (q.from || q.to) {
    from = V.date(q, 'from', { required: true });
    to = V.date(q, 'to', { required: true });
    if (to <= from) throw invalid('to', 'before_from');
  } else {
    const r = q.range || 'm1';
    to = T.addDays(today, 1);
    if (r === 'all') {
      const first = await Order.aggregate([{ $unwind: '$payments' }, { $group: { _id: null, at: { $min: '$payments.at' } } }]);
      from = first[0]?.at ? T.dateOf(first[0].at, ctx.tz) : T.addDays(today, -29);
    } else if (r in RANGES) from = T.addDays(today, -RANGES[r]);
    else throw invalid('range', 'invalid_enum');
  }
  const days = T.diffDays(from, to);
  const prevFrom = T.addDays(from, -days);
  const at = (d) => T.localToUtc(d, '00:00', ctx.tz);
  return { from, to, days, prevFrom, prevTo: from, fromAt: at(from), toAt: at(to), prevFromAt: at(prevFrom), prevToAt: at(from), range: q.range };
}

// ---------- building blocks ----------

/** { revenue, cash, transfer, free, refunds, tips } by payment time, orders not cancelled (5.4). */
async function paymentSums(fromAt, toAt) {
  const rows = await Order.aggregate([
    { $match: { status: { $ne: 'cancelled' }, 'payments.at': { $gte: fromAt, $lt: toAt } } },
    { $unwind: '$payments' },
    { $match: { 'payments.at': { $gte: fromAt, $lt: toAt } } },
    { $group: { _id: { k: '$payments.kind', m: '$payments.method' }, sum: { $sum: '$payments.amount' } } },
  ]);
  const get = (k, m) => rows.filter((r) => r._id.k === k && (!m || r._id.m === m)).reduce((s, r) => s + r.sum, 0);
  const paidReal = get('pay', 'cash') + get('pay', 'transfer');
  const refundReal = get('refund', 'cash') + get('refund', 'transfer');
  return {
    revenue: paidReal - refundReal,
    payments: { cash: get('pay', 'cash'), transfer: get('pay', 'transfer'), free: get('pay', 'free') },
    refunds: get('refund'), tips: get('tip'),
  };
}

const revenueBetween = async (a, b) => (await paymentSums(a, b)).revenue;

async function closedStats(fromAt, toAt) {
  const rows = await Order.aggregate([
    { $match: { status: 'closed', closedAt: { $gte: fromAt, $lt: toAt } } },
    { $addFields: { sub: SUB, disc: { $sum: '$discounts.amount' } } },
    { $addFields: { discC: { $min: ['$disc', '$sub'] } } },
    { $group: { _id: '$kind', orders: { $sum: 1 }, sub: { $sum: '$sub' }, disc: { $sum: '$discC' }, round: { $sum: '$roundAdjust' } } },
  ]);
  const bySource = { dine: 0, take: 0, delivery: 0 };
  let orderCount = 0;
  let discounts = 0;
  let roundAdjust = 0;
  for (const r of rows) {
    bySource[r._id] = r.sub;
    orderCount += r.orders;
    discounts += r.disc;
    roundAdjust += r.round;
  }
  return { orderCount, bySource, discounts, roundAdjust };
}

async function soldByItem(fromAt, toAt) {
  return Order.aggregate([
    { $match: { status: 'closed', closedAt: { $gte: fromAt, $lt: toAt } } },
    { $unwind: '$lines' },
    { $match: { 'lines.status': { $ne: 'cancelled' } } },
    { $group: { _id: '$lines.itemId', name: { $first: '$lines.name' }, qty: { $sum: '$lines.qty' }, revenue: { $sum: { $cond: ['$lines.comp', 0, { $multiply: ['$lines.qty', '$lines.unitPrice'] }] } } } },
  ]);
}

/** (5.7) cogs = Σ itemCost x qty; lines whose item has no cost are skipped and flag cogsPartial. */
async function cogsOf(sold) {
  const ids = sold.map((s) => s._id);
  const items = await MenuItem.find({ _id: { $in: ids } }).lean();
  const by = Object.fromEntries(items.map((i) => [i._id, i]));
  const costMap = await stock.lastCostMap([...new Set(items.flatMap((i) => (i.recipe || []).map((l) => l.ingredientId)))]);
  let cogs = 0;
  let partial = false;
  for (const s of sold) {
    const c = stock.itemCost(by[s._id], costMap);
    if (c === null) partial = true;
    else cogs += c * s.qty;
  }
  return { cogs, cogsPartial: partial };
}

async function expensesBetween(from, to) {
  const r = await Expense.aggregate([{ $match: { date: { $gte: from, $lt: to } } }, { $group: { _id: null, sum: { $sum: '$amount' } } }]);
  return r[0]?.sum || 0;
}

// ---------- summary / day close ----------

async function summary(r, ctx) {
  const [pay, closed, sold, prevRevenue, cancelled, expenses] = await Promise.all([
    paymentSums(r.fromAt, r.toAt),
    closedStats(r.fromAt, r.toAt),
    soldByItem(r.fromAt, r.toAt),
    revenueBetween(r.prevFromAt, r.prevToAt),
    Order.aggregate([
      { $match: { openedAt: { $gte: r.fromAt, $lt: r.toAt } } }, { $unwind: '$lines' }, { $match: { 'lines.status': 'cancelled' } },
      { $group: { _id: { $cond: [{ $eq: [{ $ifNull: ['$lines.cancelReason', ''] }, ''] }, '-', '$lines.cancelReason'] }, n: { $sum: 1 } } },
    ]),
    expensesBetween(r.from, r.to),
  ]);
  const { cogs, cogsPartial } = await cogsOf(sold);
  return {
    from: r.from, to: r.to,
    revenue: pay.revenue, prevRevenue, orderCount: closed.orderCount, payments: pay.payments, bySource: closed.bySource,
    discounts: closed.discounts, refunds: pay.refunds, tips: pay.tips, roundAdjust: closed.roundAdjust,
    cancelledLines: cancelled.reduce((s, x) => s + x.n, 0), cancelReasons: Object.fromEntries(cancelled.map((x) => [x._id, x.n])),
    cogs, cogsPartial, expenses, profit: pay.revenue - cogs - expenses,
    topItems: sold.sort((a, b) => b.qty - a.qty || b.revenue - a.revenue).slice(0, 20).map((s) => ({ name: s.name, qty: s.qty, revenue: s.revenue })),
  };
}

async function dashboardSummary(q, ctx) {
  return summary(await resolveRange(q, ctx), ctx);
}

async function dayClose(q, ctx) {
  const date = V.date(q, 'date', { def: T.today(ctx.tz) });
  const r = await resolveRange({ from: date, to: T.addDays(date, 1) }, ctx);
  return { date, ...(await summary(r, ctx)), openOrders: await Order.countDocuments({ status: 'open' }) };
}

// ---------- series (4.15) ----------

function bucketStarts(r, gran, ctx) {
  const out = [];
  if (gran === 'hour') for (let h = 0; h < 24; h += 1) out.push({ date: r.from, at: T.localToUtc(r.from, T.hhmm(h * 60), ctx.tz) });
  else if (gran === 'day') for (let d = r.from; d < r.to; d = T.addDays(d, 1)) out.push({ date: d, at: T.localToUtc(d, '00:00', ctx.tz) });
  else if (gran === 'week') for (let d = r.from; d < r.to; d = T.addDays(d, 7)) out.push({ date: d, at: T.localToUtc(d, '00:00', ctx.tz) });
  else {
    for (let d = r.from; d < r.to; ) {
      const label = T.monthStart(d);
      out.push({ date: label, at: T.localToUtc(d, '00:00', ctx.tz) });
      const [y, m] = label.split('-').map(Number);
      d = `${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2, '0')}-01`;
    }
  }
  return out;
}

async function revenueSeries(q, ctx) {
  const r = await resolveRange(q, ctx);
  const gran = ['hour', 'day', 'week', 'month'].includes(q.granularity) ? q.granularity : r.range === 'today' ? 'hour' : r.days <= 31 ? 'day' : r.days <= 200 ? 'week' : 'month';
  const starts = bucketStarts(r, gran, ctx);
  const boundaries = [...starts.map((s) => s.at), r.toAt];
  const [rev, cnt, prevTotal] = await Promise.all([
    Order.aggregate([
      { $match: { status: { $ne: 'cancelled' }, 'payments.at': { $gte: r.fromAt, $lt: r.toAt } } },
      { $unwind: '$payments' },
      { $match: { 'payments.at': { $gte: r.fromAt, $lt: r.toAt }, 'payments.kind': { $in: ['pay', 'refund'] }, 'payments.method': { $ne: 'free' } } },
      { $bucket: { groupBy: '$payments.at', boundaries, default: 'other', output: { revenue: { $sum: { $cond: [{ $eq: ['$payments.kind', 'refund'] }, { $multiply: ['$payments.amount', -1] }, '$payments.amount'] } } } } },
    ]),
    Order.aggregate([
      { $match: { status: 'closed', closedAt: { $gte: r.fromAt, $lt: r.toAt } } },
      { $bucket: { groupBy: '$closedAt', boundaries, default: 'other', output: { orders: { $sum: 1 } } } },
    ]),
    revenueBetween(r.prevFromAt, r.prevToAt),
  ]);
  const revBy = new Map(rev.filter((x) => x._id !== 'other').map((x) => [new Date(x._id).getTime(), x.revenue]));
  const cntBy = new Map(cnt.filter((x) => x._id !== 'other').map((x) => [new Date(x._id).getTime(), x.orders]));
  const buckets = starts.map((s) => ({
    start: ctx.iso(gran === 'month' ? T.localToUtc(s.date, '00:00', ctx.tz) : s.at), revenue: revBy.get(s.at.getTime()) || 0, orders: cntBy.get(s.at.getTime()) || 0,
  }));
  return {
    granularity: gran, from: r.from, to: r.to, total: buckets.reduce((s, b) => s + b.revenue, 0), prevTotal, orders: buckets.reduce((s, b) => s + b.orders, 0), buckets,
  };
}

async function peaks(q, ctx) {
  const r = await resolveRange(q, ctx);
  const [res] = await Order.aggregate([
    { $match: { status: 'closed', closedAt: { $gte: r.fromAt, $lt: r.toAt } } },
    { $addFields: { sub: SUB, h: { $hour: { date: '$closedAt', timezone: ctx.tz } }, d: { $isoDayOfWeek: { date: '$closedAt', timezone: ctx.tz } } } },
    { $facet: { h: [{ $group: { _id: '$h', v: { $sum: '$sub' } } }], d: [{ $group: { _id: '$d', v: { $sum: '$sub' } } }] } },
  ]);
  const byHour = Array(24).fill(0);
  const byWeekday = Array(7).fill(0);
  for (const x of res?.h || []) byHour[x._id] = x.v;
  for (const x of res?.d || []) byWeekday[x._id - 1] = x.v;
  return { byHour, byWeekday };
}

async function itemsReport(q, ctx) {
  const r = await resolveRange(q, ctx);
  const sold = Object.fromEntries((await soldByItem(r.fromAt, r.toAt)).map((s) => [s._id, s.qty]));
  const menu = await MenuItem.find({}).select('name price').lean();
  let rows = menu.map((m) => ({ itemId: m._id, name: m.name, price: m.price, qty: sold[m._id] || 0 }));
  rows.sort((a, b) => (q.sort === 'slow' ? a.qty - b.qty : b.qty - a.qty) || a.name.localeCompare(b.name));
  const limit = Number.parseInt(q.limit, 10);
  if (limit > 0) rows = rows.slice(0, limit);
  return rows;
}

// ---------- today glance ----------

async function todayGlance(ctx) {
  const now = ctx.now;
  const today = T.today(ctx.tz);
  const [fromAt, toAt] = T.dayRange(today, ctx.tz);
  const soon = new Date(now.getTime() + 60 * 60000);
  const [todayRevenue, openOrders, tabs, openList, bookings, shift, ings, hand, lots, menu, upcoming] = await Promise.all([
    revenueBetween(fromAt, toAt),
    Order.countDocuments({ status: 'open' }),
    Table.find({}).select('status').lean(),
    Order.find({ status: 'open' }).select('kind party lines.status lines.firedAt').lean(),
    Booking.find({ date: today, status: { $in: ['booked', 'arrived'] } }).select('status startAt').lean(),
    Shift.findOne({ closedAt: null }).lean(),
    Ingredient.find({}).select('minQty').lean(),
    stock.onHandMap(),
    StockLot.countDocuments({ remaining: { $gt: 0 }, expiry: { $ne: null, $lte: T.addDays(today, 3) } }),
    MenuItem.find({ status: 'on' }).select('recipe status').lean(),
    Booking.find({ status: 'booked', startAt: { $gte: new Date(now.getTime() - ctx.rules.holdMinutes * 60000), $lte: soon } }).select('tableIds').lean(),
  ]);
  const count = { free: 0, busy: 0, billing: 0, cleaning: 0 };
  for (const t of tabs) count[t.status] += 1;
  const held = new Set(upcoming.flatMap((b) => b.tableIds));
  const freeIds = new Set((await Table.find({ status: 'free' }).select('_id').lean()).map((t) => t._id));
  const reserved = [...held].filter((id) => freeIds.has(id)).length;
  let longest = 0;
  for (const o of openList) for (const l of o.lines) if ((l.status === 'sent' || l.status === 'cooking') && l.firedAt) longest = Math.max(longest, Math.floor((now - new Date(l.firedAt)) / 1000));
  return {
    todayRevenue, openOrders,
    tables: { ...count, reserved, guests: openList.filter((o) => o.kind === 'dine').reduce((s, o) => s + o.party, 0) },
    longestKitchenWaitSeconds: longest,
    bookingsToday: bookings.length,
    bookingsWithinHour: bookings.filter((b) => b.status === 'booked' && b.startAt >= now && b.startAt <= soon).length,
    openShift: shift ? { openedBy: shift.openedBy, openedAt: ctx.iso(shift.openedAt), cashIn: await shifts.cashIn(shift, ctx) } : null,
    alerts: {
      lowStock: ings.filter((g) => g.minQty > 0 && (hand[g._id] || 0) < g.minQty).length,
      expiringLots: lots,
      unavailableItems: menu.filter((m) => !stock.availability(m, hand).available).length,
    },
  };
}

// ---------- reports ----------

async function profitLoss(q, ctx) {
  const s = await summary(await resolveRange(q, ctx), ctx);
  return { revenue: s.revenue, cogs: s.cogs, expenses: s.expenses, profit: s.profit, cogsPartial: s.cogsPartial };
}

async function itemMargins() {
  const menu = await MenuItem.find({ 'recipe.0': { $exists: true } }).lean();
  const costMap = await stock.lastCostMap([...new Set(menu.flatMap((i) => i.recipe.map((l) => l.ingredientId)))]);
  const rows = [];
  for (const m of menu) {
    const cost = stock.itemCost(m, costMap);
    if (cost === null) continue;
    const margin = m.price - cost;
    rows.push({ itemId: m._id, name: m.name, price: m.price, cost, margin, marginPct: m.price > 0 ? Math.round((margin * 100) / m.price) : 0 });
  }
  return rows.sort((a, b) => b.margin - a.margin);
}

async function monthProgress(ctx) {
  const today = T.today(ctx.tz);
  const month = today.slice(0, 7);
  const start = `${month}-01`;
  const [y, m] = month.split('-').map(Number);
  const next = `${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2, '0')}-01`;
  const [revenue, t] = await Promise.all([revenueBetween(T.localToUtc(start, '00:00', ctx.tz), T.localToUtc(next, '00:00', ctx.tz)), SalesTarget.findById(month).lean()]);
  return { month, revenue, target: t?.targetRevenue || 0 };
}

// ---------- search (4.16) ----------

async function search(q, ctx) {
  const n = noAccent(q.q || '');
  if (!n) return { items: [] };
  const rx = { $regex: esc(n) };
  const [items, ings, custs, ords, books, groups] = await Promise.all([
    MenuItem.find({ search: rx }).limit(20).select('name groupId').lean(),
    Ingredient.find({ search: rx }).limit(20).select('name unit').lean(),
    Customer.find({ search: rx }).limit(20).select('name phone').lean(),
    Order.find({ search: rx }).sort({ openedAt: -1 }).limit(20).select('code customerName status tableLabel').lean(),
    Booking.find({ search: rx }).sort({ date: -1 }).limit(20).select('name date startMin').lean(),
    MenuGroup.find({}).select('name').lean(),
  ]);
  const gName = Object.fromEntries(groups.map((g) => [g._id, g.name]));
  void ctx;
  const out = [
    ...items.map((i) => ({ type: 'item', id: i._id, title: i.name, subtitle: gName[i.groupId] || '' })),
    ...ings.map((i) => ({ type: 'ingredient', id: i._id, title: i.name, subtitle: i.unit })),
    ...custs.map((c) => ({ type: 'customer', id: c._id, title: c.name, subtitle: c.phone })),
    ...ords.map((o) => ({ type: 'order', id: o._id, title: o.code, subtitle: [o.customerName, o.tableLabel, o.status].filter(Boolean).join(' · ') })),
    ...books.map((b) => ({ type: 'booking', id: b._id, title: b.name, subtitle: `${b.date} ${T.hhmm(b.startMin)}` })),
  ];
  return { items: out.slice(0, 50) };
}

// ---------- reminders (4.17) ----------

async function reminders(q, ctx) {
  const now = ctx.now;
  const today = T.today(ctx.tz);
  const from = q.from ? T.localToUtc(V.date(q, 'from'), '00:00', ctx.tz) : now;
  const to = q.to ? T.localToUtc(V.date(q, 'to'), '00:00', ctx.tz) : new Date(now.getTime() + 14 * 86400000);
  const out = [];
  const [books, hold, ings, hand, lots, shift, custs] = await Promise.all([
    Booking.find({ status: 'booked', startAt: { $gte: from, $lt: to } }).sort({ startAt: 1 }).lean(),
    Booking.find({ status: 'booked', date: today }).lean(),
    Ingredient.find({ minQty: { $gt: 0 } }).lean(),
    stock.onHandMap(),
    StockLot.find({ remaining: { $gt: 0 }, expiry: { $ne: null, $lte: T.addDays(today, 7) } }).lean(),
    Shift.findOne({ closedAt: null }).lean(),
    Customer.find({ birthday: { $ne: null } }).select('name birthday').lean(),
  ]);
  for (const b of books) out.push({ dedupeKey: `booking:${b._id}`, kind: 'booking', at: ctx.iso(b.startAt), refType: 'booking', refId: b._id, title: b.name, party: b.party, note: b.note });
  for (const b of hold) {
    const expireAt = new Date(new Date(b.startAt).getTime() + ctx.rules.holdMinutes * 60000);
    if (now > expireAt) out.push({ dedupeKey: `hold:${b._id}`, kind: 'hold_expired', at: ctx.iso(expireAt), refType: 'booking', refId: b._id, title: b.name, party: b.party });
  }
  for (const g of ings) {
    const onHand = hand[g._id] || 0;
    if (onHand < g.minQty) out.push({ dedupeKey: `low:${g._id}:${today}`, kind: 'low_stock', at: ctx.iso(now), refType: 'ingredient', refId: g._id, onHand, minQty: g.minQty, unit: g.unit });
  }
  const names = Object.fromEntries((await Ingredient.find({ _id: { $in: lots.map((l) => l.ingredientId) } }).select('name unit').lean()).map((g) => [g._id, g]));
  for (const l of lots) {
    out.push({
      dedupeKey: `exp:${l._id}`, kind: 'expiry', at: ctx.iso(T.localToUtc(l.expiry, '00:00', ctx.tz)), refType: 'lot', refId: l._id,
      ingredientName: names[l.ingredientId]?.name || '', remaining: l.remaining, unit: names[l.ingredientId]?.unit || '',
    });
  }
  if (shift && now - new Date(shift.openedAt) > 10 * 3600000) out.push({ dedupeKey: `shift:${shift._id}`, kind: 'shift_open_long', at: ctx.iso(new Date(new Date(shift.openedAt).getTime() + 10 * 3600000)), refType: 'shift', refId: shift._id, openedAt: ctx.iso(shift.openedAt) });
  const [ty] = today.split('-').map(Number);
  for (const c of custs) {
    const [, mm, dd] = c.birthday.split('-');
    for (const year of [ty, ty + 1]) {
      const d = `${year}-${mm}-${dd}`;
      if (!T.isDate(d)) continue;
      const diff = T.diffDays(today, d);
      if (diff >= 0 && diff <= 7) {
        out.push({ dedupeKey: `bday:${c._id}:${year}`, kind: 'birthday', at: ctx.iso(T.localToUtc(d, '00:00', ctx.tz)), refType: 'customer', refId: c._id, title: c.name });
        break;
      }
    }
  }
  out.sort((a, b) => a.at.localeCompare(b.at));
  return { items: out };
}

// ---------- exports (4.18) ----------

const csvCell = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const csv = (header, rows) => [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n');

async function exportOrders(q, ctx) {
  const r = await resolveRange({ from: q.from, to: q.to, range: q.range }, ctx);
  const rows = await Order.find({ openedAt: { $gte: r.fromAt, $lt: r.toAt } }).sort({ openedAt: 1 }).lean();
  return csv(['code', 'type', 'table', 'opened', 'closed', 'subtotal', 'discount', 'service', 'total', 'paid', 'status'], rows.map((o) => {
    const t = orders.totals(o, orders.rulesFor(o, ctx));
    return [o.code, o.kind, o.tableLabel, ctx.iso(o.openedAt), o.closedAt ? ctx.iso(o.closedAt) : '', t.subtotal, t.discountTotal, t.serviceFee, t.total, t.paid, o.status];
  }));
}

async function exportRevenue(q, ctx) {
  const s = await revenueSeries({ ...q, granularity: 'day' }, ctx);
  return csv(['date', 'revenue', 'orders'], s.buckets.map((b) => [b.start.slice(0, 10), b.revenue, b.orders]));
}

async function exportStock() {
  const list = await stock.presentIngredients(await Ingredient.find({}).sort({ name: 1 }).lean());
  return csv(['ingredient', 'unit', 'on_hand', 'min', 'last_cost'], list.map((g) => [g.name, g.unit, g.onHand, g.minQty, g.lastCost ?? '']));
}

async function exportCloseout(q, ctx) {
  const d = await dayClose({ date: q.date }, ctx);
  const rows = [['date', d.date], ['revenue', d.revenue], ['cash', d.payments.cash], ['transfer', d.payments.transfer], ['free', d.payments.free], ['discounts', d.discounts], ['refunds', d.refunds], ['tips', d.tips], ['orders', d.orderCount]];
  return csv(['chỉ_tiêu', 'giá_trị'], rows);
}

module.exports = {
  resolveRange, dashboardSummary, dayClose, summary, revenueSeries, peaks, itemsReport, todayGlance, profitLoss, itemMargins, monthProgress, search, reminders,
  exportOrders, exportRevenue, exportStock, exportCloseout, paymentSums,
};
