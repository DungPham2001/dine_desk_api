const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const h = require('./helpers');

before(h.start);
after(h.stop);
beforeEach(h.reset);

async function setup() {
  const a = await h.admin();
  const w = await h.world(a.token);
  return { t: a.token, w };
}
const today = () => h.T.today();
const nowMin = () => { const l = h.T.toLocal(new Date()); return h.T.minutesOf(l.time); };

test('bookings: overlap on the same table, buffer, self-edit, status releases the table', async () => {
  const { t, w } = await setup();
  const body = { name: 'Chị Hương', phone: '0988111222', party: 4, date: h.T.addDays(today(), 1), startMin: 1140, durationMin: 90, tableIds: [w.t1.id] };
  const b1 = h.expectOk(await h.api.post('bookings', body, t, { 'Idempotency-Key': 'b-1' }), 201);
  assert.equal(b1.status, 'booked');
  assert.equal(h.expectOk(await h.api.post('bookings', body, t, { 'Idempotency-Key': 'b-1' }), 201).id, b1.id); // replay
  // 1140 + 90 + 10 = 1240: a booking at 1239 clashes, one at 1240 does not
  const clash = h.expectErr(await h.api.post('bookings', { ...body, name: 'B', startMin: 1239 }, t), 409, 'booking_overlap');
  assert.deepEqual(clash.details.tableIds, [w.t1.id]);
  const ok = h.expectOk(await h.api.post('bookings', { ...body, name: 'C', startMin: 1240 }, t), 201);
  h.expectErr(await h.api.post('bookings', { ...body, name: 'D', party: 9 }, t), 422, 'not_enough_seats');
  h.expectErr(await h.api.post('bookings', { ...body, tableIds: [] }, t), 400, 'validation_failed');
  // editing a booking never clashes with itself, but does clash with the neighbour
  h.expectOk(await h.api.patch(`bookings/${b1.id}`, { startMin: 1130, note: 'Sinh nhật' }, t));
  h.expectErr(await h.api.patch(`bookings/${b1.id}`, { startMin: 1200 }, t), 409, 'booking_overlap');
  // cancelled releases the table; re-booking it checks again
  h.expectOk(await h.api.post(`bookings/${ok.id}/status`, { status: 'cancelled' }, t));
  h.expectOk(await h.api.patch(`bookings/${b1.id}`, { startMin: 1200 }, t));
  h.expectOk(await h.api.post('bookings', { ...body, name: 'E', startMin: 1300 }, t), 201);
  h.expectErr(await h.api.post(`bookings/${ok.id}/status`, { status: 'booked' }, t), 409, 'booking_overlap');
  // two clients racing for the same slot: exactly one wins
  const race = await Promise.all([1, 2, 3].map((i) => h.api.post('bookings', { ...body, name: `R${i}`, date: h.T.addDays(today(), 3), tableIds: [w.t3.id], party: 2 }, t)));
  assert.equal(race.filter((r) => r.status === 201).length, 1);
  assert.equal(race.filter((r) => r.status === 409 && r.body.code === 'booking_overlap').length, 2);
});

test('availability: seats, overlaps, ignoreBookingId, sorted by seats', async () => {
  const { t, w } = await setup();
  const date = h.T.addDays(today(), 1);
  const b = h.expectOk(await h.api.post('bookings', { name: 'X', party: 2, date, startMin: 1140, tableIds: [w.t2.id] }, t), 201);
  const q = `bookings/availability?date=${date}&startMin=1140&durationMin=90&party=2`;
  let free = h.expectOk(await h.api.get(q, t)).items.map((x) => x.label);
  assert.deepEqual(free, ['A1', 'A3']); // A2 is taken, 4-seat before 6-seat
  free = h.expectOk(await h.api.get(`${q}&ignoreBookingId=${b.id}`, t)).items.map((x) => x.label);
  assert.deepEqual(free, ['A2', 'A1', 'A3']);
  assert.deepEqual(h.expectOk(await h.api.get(`${q.replace('party=2', 'party=5')}`, t)).items.map((x) => x.label), ['A3']);
});

test('arrive opens the first free table; a busy table gives order = null', async () => {
  const { t, w } = await setup();
  const date = today();
  const start = Math.min(nowMin() + 30, 1400);
  const b = h.expectOk(await h.api.post('bookings', { name: 'Anh Việt', phone: '0988777666', party: 3, date, startMin: start, tableIds: [w.t1.id, w.t3.id] }, t), 201);
  // floor shows the upcoming booking on both tables
  const floor = h.expectOk(await h.api.get('floor', t));
  assert.equal(floor.tables.find((x) => x.label === 'A1').nextBooking.id, b.id);
  h.expectOk(await h.api.post(`tables/${w.t1.id}/open`, { party: 1 }, t), 201);
  const r = h.expectOk(await h.api.post(`bookings/${b.id}/arrive`, {}, t));
  assert.equal(r.booking.status, 'arrived');
  assert.equal(r.order.tableLabel, 'A3');
  assert.equal(r.order.party, 3);
  h.expectErr(await h.api.post(`bookings/${b.id}/arrive`, {}, t), 422, 'invalid_state');
  const b2 = h.expectOk(await h.api.post('bookings', { name: 'Y', party: 2, date, startMin: Math.min(start + 300, 1430), tableIds: [w.t2.id] }, t), 201);
  h.expectOk(await h.api.post(`tables/${w.t2.id}/open`, { party: 1 }, t), 201);
  const r2 = h.expectOk(await h.api.post(`bookings/${b2.id}/arrive`, {}, t));
  assert.equal(r2.order, null);
  assert.equal(r2.booking.status, 'arrived');
});

test('isLate is derived from holdMinutes; wait list', async () => {
  const { t, w } = await setup();
  const start = Math.max(nowMin() - 40, 0);
  if (nowMin() < 40) return; // too close to midnight to build a late booking for today
  const b = h.expectOk(await h.api.post('bookings', { name: 'Trễ', party: 2, date: today(), startMin: start, tableIds: [w.t2.id] }, t), 201);
  assert.equal(b.isLate, true);
  const list = h.expectOk(await h.api.get(`bookings?date=${today()}`, t)).items;
  assert.equal(list[0].isLate, true);
  const wl = h.expectOk(await h.api.post('wait-list', { name: 'Anh Việt', party: 3 }, t), 201);
  assert.equal(h.expectOk(await h.api.get('wait-list', t)).items.length, 1);
  h.expectOk(await h.api.del(`wait-list/${wl.id}`, {}, t), 204);
});

test('shifts: cash entry needs a shift, close blocked by open orders, expectedCash (5.5)', async () => {
  const { t, w } = await setup();
  h.expectErr(await h.api.post('cash-entries', { amount: -1000, reason: 'Đá' }, t), 422, 'shift_not_open');
  h.expectErr(await h.api.get('shifts/current', t), 404, 'not_found');
  const s = h.expectOk(await h.api.post('shifts/open', { startCash: 2000000 }, t, { 'Idempotency-Key': 's-1' }), 201);
  const again = h.expectOk(await h.api.post('shifts/open', { startCash: 5 }, t));
  assert.equal(again.id, s.id);
  h.expectErr(await h.api.post('cash-entries', { amount: -350000 }, t), 400, 'validation_failed');
  h.expectOk(await h.api.post('cash-entries', { amount: -350000, reason: 'Mua đá' }, t), 201);
  const o = h.expectOk(await h.api.post('orders', { kind: 'take' }, t), 201);
  h.expectOk(await h.api.post(`orders/${o.id}/lines`, { itemId: w.itemB.id, qty: 10 }, t), 201);
  h.expectOk(await h.api.post(`orders/${o.id}/fire`, {}, t));
  h.expectErr(await h.api.post('shifts/close', { countedCash: 1 }, t), 422, 'open_orders_exist');
  h.expectOk(await h.api.post(`orders/${o.id}/payments`, { kind: 'pay', method: 'cash', amount: 60000 }, t), 201);
  h.expectOk(await h.api.post(`orders/${o.id}/payments`, { kind: 'pay', method: 'transfer', amount: 40000 }, t), 201);
  h.expectOk(await h.api.post(`orders/${o.id}/payments`, { kind: 'tip', method: 'cash', amount: 5000 }, t), 201);
  h.expectOk(await h.api.post(`orders/${o.id}/close`, {}, t));
  h.expectOk(await h.api.post(`orders/${o.id}/refund`, { amount: 10000, method: 'cash', reason: 'Lỗi' }, t), 201);
  const cur = h.expectOk(await h.api.get('shifts/current', t));
  assert.equal(cur.expectedCash, 2000000 + (60000 + 5000 - 10000) - 350000); // transfer never touches the drawer
  const closed = h.expectOk(await h.api.post('shifts/close', { countedCash: 1700000 }, t));
  assert.equal(closed.difference, 1700000 - cur.expectedCash);
  assert.ok(closed.closedAt);
  h.expectErr(await h.api.post('shifts/close', { countedCash: 1 }, t), 422, 'shift_not_open');
  assert.equal(h.expectOk(await h.api.get('shifts', t)).items.length, 1);
  const log = (await h.api.get('audit-log', t)).body.items.map((x) => x.action);
  assert.ok(log.includes('shift_closed'));
});

async function sale(t, w, { item, qty, method = 'cash', tip = 0 }) {
  const o = h.expectOk(await h.api.post('orders', { kind: 'take' }, t), 201);
  h.expectOk(await h.api.post(`orders/${o.id}/lines`, { itemId: item.id, qty, options: item === w.itemA ? ['Vừa'] : undefined }, t), 201);
  h.expectOk(await h.api.post(`orders/${o.id}/fire`, {}, t));
  const due = (await h.api.get(`orders/${o.id}`, t)).body.totals.due;
  h.expectOk(await h.api.post(`orders/${o.id}/payments`, { kind: 'pay', method, amount: due, note: method === 'free' ? 'Tặng' : '' }, t), 201);
  if (tip) h.expectOk(await h.api.post(`orders/${o.id}/payments`, { kind: 'tip', method: 'cash', amount: tip }, t), 201);
  return h.expectOk(await h.api.post(`orders/${o.id}/close`, {}, t));
}

test('dashboard: revenue excludes tips and free, refunds count in their own period; cogs partial', async () => {
  const { t, w } = await setup();
  h.expectOk(await h.api.put(`menu-items/${w.itemA.id}/recipe`, { lines: [{ ingredientId: w.beef.id, qty: 200 }] }, t));
  h.expectOk(await h.api.post('stock/receive', { ingredientId: w.beef.id, qty: 5000, unitCost: 260 }, t), 201);
  h.expectOk(await h.api.post('expenses', { category: 'Mặt bằng', amount: 50000, date: today() }, t), 201);
  const a = await sale(t, w, { item: w.itemA, qty: 2, tip: 7000 }); // 278 000 cash + tip
  await sale(t, w, { item: w.itemB, qty: 3, method: 'transfer' }); // 30 000
  await sale(t, w, { item: w.itemB, qty: 1, method: 'free' }); // free: not revenue
  h.expectOk(await h.api.post(`orders/${a.id}/refund`, { amount: 8000, method: 'cash', reason: 'Lỗi' }, t), 201);
  const s = h.expectOk(await h.api.get('dashboard/summary?range=today', t));
  assert.equal(s.revenue, 278000 + 30000 - 8000);
  assert.deepEqual(s.payments, { cash: 278000, transfer: 30000, free: 10000 });
  assert.equal(s.refunds, 8000);
  assert.equal(s.tips, 7000);
  assert.equal(s.orderCount, 3);
  assert.equal(s.bySource.take, 278000 + 30000 + 10000);
  assert.equal(s.cogs, 2 * 200 * 260);
  assert.equal(s.cogsPartial, true); // trà đá has no recipe
  assert.equal(s.expenses, 50000);
  assert.equal(s.profit, s.revenue - s.cogs - s.expenses);
  assert.equal(s.topItems[0].name, 'Trà đá');
  assert.equal(s.topItems[0].qty, 4);
  assert.equal((await h.api.get('reports/profit-loss?range=today', t)).body.profit, s.profit);
  const margins = h.expectOk(await h.api.get('reports/item-margins', t)).items;
  assert.equal(margins[0].cost, 52000);
  assert.equal(margins[0].marginPct, Math.round(((139000 - 52000) * 100) / 139000));
  assert.deepEqual(h.expectOk(await h.api.get(`menu-items/${w.itemA.id}/cost`, t)), { cost: 52000, margin: 87000, marginPct: 63 });
  assert.deepEqual(h.expectOk(await h.api.get(`menu-items/${w.itemB.id}/cost`, t)), { cost: null });
  const day = h.expectOk(await h.api.get(`day-close?date=${today()}`, t));
  assert.equal(day.revenue, s.revenue);
  assert.equal(day.openOrders, 0);
});

test('revenue-series: every bucket exists, granularity by range', async () => {
  const { t, w } = await setup();
  await sale(t, w, { item: w.itemB, qty: 2 });
  const hourly = h.expectOk(await h.api.get('dashboard/revenue-series?range=today', t));
  assert.equal(hourly.granularity, 'hour');
  assert.equal(hourly.buckets.length, 24);
  assert.equal(hourly.total, 20000);
  assert.equal(hourly.orders, 1);
  assert.equal(hourly.buckets.reduce((s, b) => s + b.revenue, 0), 20000);
  const daily = h.expectOk(await h.api.get('dashboard/revenue-series?range=d7', t));
  assert.equal(daily.granularity, 'day');
  assert.equal(daily.buckets.length, 7);
  assert.equal(daily.buckets[6].revenue, 20000);
  assert.equal(daily.buckets[0].revenue, 0);
  assert.equal(h.expectOk(await h.api.get('dashboard/revenue-series?range=m6', t)).granularity, 'week');
  const months = h.expectOk(await h.api.get('dashboard/revenue-series?range=y1', t));
  assert.equal(months.granularity, 'month');
  assert.ok(months.buckets.length >= 12 && months.buckets.length <= 13);
  assert.equal(months.total, 20000);
  const custom = h.expectOk(await h.api.get(`dashboard/revenue-series?from=${h.T.addDays(today(), -2)}&to=${h.T.addDays(today(), 1)}`, t));
  assert.equal(custom.buckets.length, 3);
  assert.equal(custom.prevTotal, 0);
  h.expectErr(await h.api.get('dashboard/summary?range=nope', t), 400, 'validation_failed');
  const peaks = h.expectOk(await h.api.get('dashboard/peaks?range=today', t));
  assert.equal(peaks.byHour.length, 24);
  assert.equal(peaks.byWeekday.length, 7);
  assert.equal(peaks.byHour.reduce((a, b) => a + b, 0), 20000);
  const slow = h.expectOk(await h.api.get('dashboard/items?sort=slow&range=today', t)).items;
  assert.equal(slow.length, 2);
  assert.equal(slow[0].qty, 0);
});

test('today-glance, search without accents, reminders, exports', async () => {
  const { t, w } = await setup();
  h.expectOk(await h.api.put(`menu-items/${w.itemA.id}/recipe`, { lines: [{ ingredientId: w.beef.id, qty: 200 }] }, t));
  h.expectOk(await h.api.post('stock/receive', { ingredientId: w.beef.id, qty: 500, unitCost: 260, expiry: h.T.addDays(today(), 2) }, t), 201);
  h.expectOk(await h.api.post('customers', { name: 'Chị Hương', phone: '0988123456', birthday: `1990-${h.T.addDays(today(), 3).slice(5)}` }, t), 201);
  const o = h.expectOk(await h.api.post(`tables/${w.t1.id}/open`, { party: 4 }, t), 201);
  h.expectOk(await h.api.post(`orders/${o.id}/lines`, { itemId: w.itemA.id, qty: 1, options: ['Vừa'] }, t), 201);
  h.expectOk(await h.api.post(`orders/${o.id}/fire`, {}, t));
  const g = h.expectOk(await h.api.get('dashboard/today-glance', t));
  assert.equal(g.openOrders, 1);
  assert.deepEqual([g.tables.busy, g.tables.free, g.tables.guests], [1, 2, 4]);
  assert.equal(g.alerts.lowStock, 1); // 500 g left, minQty 1000
  assert.equal(g.alerts.expiringLots, 1);
  assert.equal(g.openShift, null);
  assert.ok(g.longestKitchenWaitSeconds >= 0);

  const s = h.expectOk(await h.api.get('search?q=bo%20luc%20lac', t)).items;
  assert.equal(s[0].type, 'item');
  assert.equal(s[0].title, 'Bò lúc lắc');
  assert.ok(h.expectOk(await h.api.get('search?q=huong', t)).items.some((x) => x.type === 'customer'));
  assert.ok(h.expectOk(await h.api.get(`search?q=${o.code.toLowerCase()}`, t)).items.some((x) => x.type === 'order'));

  const rem = h.expectOk(await h.api.get('reminders', t)).items;
  const kinds = rem.map((x) => x.kind);
  assert.ok(kinds.includes('low_stock') && kinds.includes('expiry') && kinds.includes('birthday'), kinds.join());
  assert.equal(new Set(rem.map((x) => x.dedupeKey)).size, rem.length);

  const csv = await h.api.get(`exports/orders.csv?from=${today()}&to=${h.T.addDays(today(), 1)}`, t);
  assert.match(csv.headers['content-type'], /text\/csv/);
  assert.equal(csv.text.split('\r\n')[0], 'code,type,table,opened,closed,subtotal,discount,service,total,paid,status');
  assert.equal(csv.text.split('\r\n').length, 2);
  assert.equal((await h.api.get('exports/stock.csv', t)).text.split('\r\n')[0], 'ingredient,unit,on_hand,min,last_cost');
  assert.equal((await h.api.get(`exports/closeout.csv?date=${today()}`, t)).text.split('\r\n')[0], 'chỉ_tiêu,giá_trị');
  assert.match((await h.api.get('exports/revenue.csv?range=d7', t)).text, /^date,revenue,orders\r\n/);
});

test('catalog: delete rules, bulk price, unique labels, tombstone-free updatedSince, targets, rules', async () => {
  const { t, w } = await setup();
  h.expectErr(await h.api.post('tables', { areaId: w.area.id, label: 'A1', seats: 2 }, t), 409, 'duplicate');
  h.expectErr(await h.api.post('tables', { areaId: 'nope', label: 'Z', seats: 2 }, t), 400, 'validation_failed');
  const o = h.expectOk(await h.api.post(`tables/${w.t1.id}/open`, { party: 1 }, t), 201);
  const e1 = h.expectErr(await h.api.del(`tables/${w.t1.id}`, {}, t), 409, 'has_dependents');
  assert.equal(e1.details.orderId, o.id);
  h.expectErr(await h.api.del(`areas/${w.area.id}`, {}, t), 409, 'has_dependents');
  h.expectOk(await h.api.del(`tables/${w.t2.id}`, {}, t), 204);

  h.expectOk(await h.api.patch(`menu-items/${w.itemA.id}`, { price: 139000 }, t));
  const bp = h.expectOk(await h.api.post('menu-items/bulk-price', { groupId: w.group.id, percent: 5 }, t));
  assert.equal(bp.updated, 2);
  const items = h.expectOk(await h.api.get('menu-items', t)).items;
  assert.equal(items.find((i) => i.id === w.itemA.id).price, 146000); // 145 950 -> nearest thousand
  assert.equal(items.find((i) => i.id === w.itemB.id).price, 11000); // 10 500 -> half up
  h.expectOk(await h.api.post(`orders/${o.id}/lines`, { itemId: w.itemB.id, qty: 1 }, t), 201);
  assert.equal(h.expectOk(await h.api.get(`orders/${o.id}`, t)).lines[0].unitPrice, 11000);
  // deleting the item keeps the line (name and price were copied)
  h.expectOk(await h.api.del(`menu-items/${w.itemB.id}`, {}, t), 204);
  assert.equal(h.expectOk(await h.api.get(`orders/${o.id}`, t)).lines[0].name, 'Trà đá');
  // deleting the group deletes its items
  h.expectOk(await h.api.del(`menu-groups/${w.group.id}`, {}, t), 204);
  assert.equal(h.expectOk(await h.api.get('menu-items', t)).items.length, 0);

  const later = new Date(Date.now() + 1000).toISOString();
  assert.equal(h.expectOk(await h.api.get(`areas?updatedSince=${later}`, t)).items.length, 0);
  assert.equal(h.expectOk(await h.api.get('areas?updatedSince=2020-01-01T00:00:00Z', t)).items.length, 1);

  h.expectOk(await h.api.put('sales-targets/2026-11', { targetRevenue: 320000000 }, t));
  assert.equal(h.expectOk(await h.api.get('sales-targets/2026-11', t)).targetRevenue, 320000000);
  h.expectErr(await h.api.get('sales-targets/2026-13', t), 400, 'validation_failed');
  const prog = h.expectOk(await h.api.get('reports/month-progress', t));
  assert.equal(prog.month, today().slice(0, 7));

  h.expectErr(await h.api.put('shop/rules', { servicePct: 31 }, t), 400, 'validation_failed');
  assert.equal(h.expectOk(await h.api.put('shop/rules', { servicePct: 5 }, t)).roundTo, 1000);
  assert.equal(h.expectOk(await h.api.put('shop', { name: 'Quán A', timezone: 'Asia/Ho_Chi_Minh' }, t)).name, 'Quán A');
  h.expectErr(await h.api.put('shop', { timezone: 'Mars/Base' }, t), 400, 'validation_failed');
});

test('staff delete unlinks the deliverer; ingredient delete cleans recipe, lots and ledger', async () => {
  const { t, w } = await setup();
  const s = h.expectOk(await h.api.post('staff', { name: 'An', role: 'delivery' }, t), 201);
  const o = h.expectOk(await h.api.post('orders', { kind: 'delivery', customerName: 'A', phone: '0988000111', address: 'x', delivererId: s.id }, t), 201);
  assert.equal(o.delivererId, s.id);
  h.expectOk(await h.api.del(`staff/${s.id}`, {}, t), 204);
  assert.equal(h.expectOk(await h.api.get(`orders/${o.id}`, t)).delivererId, null);
  const ds = h.expectOk(await h.api.put(`orders/${o.id}/delivery-status`, { status: 'delivering' }, t));
  assert.equal(ds.deliveryStatus, 'delivering');
  h.expectErr(await h.api.put(`orders/${o.id}/delivery-status`, { status: 'nope' }, t), 400, 'validation_failed');

  h.expectOk(await h.api.put(`menu-items/${w.itemA.id}/recipe`, { lines: [{ ingredientId: w.beef.id, qty: 200 }] }, t));
  h.expectOk(await h.api.post('stock/receive', { ingredientId: w.beef.id, qty: 100, unitCost: 1 }, t), 201);
  h.expectOk(await h.api.del(`ingredients/${w.beef.id}`, {}, t), 204);
  assert.equal(await h.models.StockLot.countDocuments({}), 0);
  assert.equal(await h.models.StockMove.countDocuments({}), 0);
  assert.equal(h.expectOk(await h.api.get('menu-items', t)).items[0].hasRecipe, false);
});

test('cursor pagination on orders: no gaps, no repeats, nextCursor null at the end', async () => {
  const { t } = await setup();
  const ids = [];
  for (let i = 0; i < 5; i += 1) ids.push(h.expectOk(await h.api.post('orders', { kind: 'take', customerName: `K${i}` }, t), 201).id);
  const seen = [];
  let cursor = '';
  for (let n = 0; n < 5; n += 1) {
    const page = h.expectOk(await h.api.get(`orders?limit=2${cursor}`, t));
    seen.push(...page.items.map((o) => o.id));
    if (!page.nextCursor) break;
    cursor = `&cursor=${page.nextCursor}`;
  }
  assert.equal(seen.length, 5);
  assert.equal(new Set(seen).size, 5);
  assert.equal(h.expectOk(await h.api.get('orders?kind=dine', t)).items.length, 0);
  assert.equal(h.expectOk(await h.api.get('orders?q=k3', t)).items.length, 1);
  h.expectErr(await h.api.get('orders?cursor=%%%', t), 400, 'validation_failed');
});
