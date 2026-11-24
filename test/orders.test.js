const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const h = require('./helpers');

before(h.start);
after(h.stop);
beforeEach(h.reset);

async function setup(rules = {}) {
  const a = await h.admin();
  const w = await h.world(a.token);
  if (Object.keys(rules).length) h.expectOk(await h.api.put('shop/rules', rules, a.token));
  return { a, t: a.token, w };
}
const openTable = async (t, tableId, party = 2) => h.expectOk(await h.api.post(`tables/${tableId}/open`, { party }, t), 201);
const addLine = async (t, orderId, itemId, qty = 1, extra = {}) => h.expectOk(await h.api.post(`orders/${orderId}/lines`, { itemId, qty, ...extra }, t), 201);

test('money: discount, service, rounding half-up, roundAdjust (5.1)', async () => {
  const { t, w } = await setup({ servicePct: 10, roundTo: 1000 });
  const o = await openTable(t, w.t1.id);
  assert.equal(o.serviceOn, true);
  assert.match(o.code, /^B\d{3}$/);
  let ord = await addLine(t, o.id, w.itemA.id, 2, { options: ['Lớn'] });
  assert.equal(ord.lines[0].unitPrice, 154000);
  ord = await addLine(t, o.id, w.itemB.id, 1);
  ord = h.expectOk(await h.api.post(`orders/${o.id}/discounts`, { label: 'Giảm', amount: 17500 }, t), 201);
  assert.deepEqual(
    { s: ord.totals.subtotal, d: ord.totals.discountTotal, f: ord.totals.serviceFee, r: ord.totals.rawTotal, ra: ord.totals.roundAdjust, tot: ord.totals.total, due: ord.totals.due },
    { s: 318000, d: 17500, f: 30050, r: 330550, ra: 450, tot: 331000, due: 331000 },
  );
  h.expectErr(await h.api.post(`orders/${o.id}/discounts`, { label: 'Lớn', amount: 100000 }, t), 422, 'reason_required');
  h.expectOk(await h.api.post(`orders/${o.id}/discounts`, { label: 'Lớn', amount: 100000, reason: 'Khách quen' }, t), 201);
  assert.equal((await h.api.get('audit-log', t)).body.items[0].action, 'big_discount');
});

test('roundTo = 1 keeps the raw total; service applies to dine only', async () => {
  const { t, w } = await setup({ servicePct: 10, roundTo: 1 });
  const take = h.expectOk(await h.api.post('orders', { kind: 'take', customerName: 'A', phone: '0988111222' }, t), 201);
  assert.match(take.code, /^M\d{3}$/);
  const o = await addLine(t, take.id, w.itemB.id, 3);
  assert.equal(o.totals.serviceFee, 0);
  assert.equal(o.totals.total, 30000);
  h.expectErr(await h.api.post('orders', { kind: 'delivery', customerName: 'A' }, t), 400, 'validation_failed');
});

test('order numbers are shared across kinds within the day', async () => {
  const { t, w } = await setup();
  const a = await openTable(t, w.t1.id);
  const b = h.expectOk(await h.api.post('orders', { kind: 'take' }, t), 201);
  const c = h.expectOk(await h.api.post('orders', { kind: 'delivery', customerName: 'X', phone: '0988000111', address: '1 Lê Lợi' }, t), 201);
  assert.deepEqual([a.number, b.number, c.number], [1, 2, 3]);
  assert.deepEqual([a.code, b.code, c.code], ['B001', 'M002', 'G003']);
  assert.equal(c.deliveryStatus, 'received');
});

test('lines: required option, merge of draft lines, unavailable item, price is frozen', async () => {
  const { t, w } = await setup();
  const o = await openTable(t, w.t1.id);
  const r = await h.api.post(`orders/${o.id}/lines`, { itemId: w.itemA.id, qty: 1 }, t);
  h.expectErr(r, 422, 'validation_failed');
  let ord = await addLine(t, o.id, w.itemA.id, 1, { options: ['Lớn', 'Cay'], extra: 999999 }); // client `extra` is ignored
  assert.equal(ord.lines[0].unitPrice, 154000);
  ord = await addLine(t, o.id, w.itemA.id, 2, { options: ['Cay', 'Lớn'] });
  assert.equal(ord.lines.length, 1);
  assert.equal(ord.lines[0].qty, 3);
  h.expectOk(await h.api.patch(`menu-items/${w.itemA.id}`, { price: 200000 }, t));
  assert.equal((await h.api.get(`orders/${o.id}`, t)).body.lines[0].unitPrice, 154000);
  h.expectOk(await h.api.patch(`menu-items/${w.itemB.id}`, { status: 'out' }, t));
  h.expectErr(await h.api.post(`orders/${o.id}/lines`, { itemId: w.itemB.id, qty: 1 }, t), 422, 'item_unavailable');
});

test('fire, kitchen board and line transitions', async () => {
  const { t, w } = await setup();
  const o = await openTable(t, w.t1.id);
  await addLine(t, o.id, w.itemA.id, 1, { options: ['Vừa'] });
  await addLine(t, o.id, w.itemB.id, 2);
  assert.equal(h.expectOk(await h.api.get('kitchen', t)).items.length, 0);
  const f = h.expectOk(await h.api.post(`orders/${o.id}/fire`, {}, t));
  assert.equal(f.fired, 2);
  const k = h.expectOk(await h.api.get('kitchen?station=kitchen', t));
  assert.equal(k.items.length, 1);
  assert.equal(k.items[0].tableLabel, 'A1');
  assert.ok(k.serverTime);
  const lineId = k.items[0].lineId;
  h.expectErr(await h.api.post(`orders/${o.id}/lines/${lineId}/done`, {}, t), 422, 'invalid_state');
  h.expectOk(await h.api.post(`orders/${o.id}/lines/${lineId}/start`, {}, t));
  const done = h.expectOk(await h.api.post(`orders/${o.id}/lines/${lineId}/done`, {}, t));
  assert.ok(done.lines.find((l) => l.id === lineId).doneAt);
  h.expectErr(await h.api.patch(`orders/${o.id}/lines/${lineId}`, { qty: 3 }, t), 422, 'invalid_state');
  h.expectOk(await h.api.post(`orders/${o.id}/lines/${lineId}/served`, {}, t));
  assert.equal(h.expectOk(await h.api.get('kitchen?station=kitchen', t)).items.length, 0); // served dishes leave the board
  assert.equal(h.expectOk(await h.api.get('kitchen?station=bar', t)).items.length, 1);
});

test('payments and close: checks in order, tip is outside due, table lifecycle', async () => {
  const { t, w } = await setup();
  const o = await openTable(t, w.t1.id);
  h.expectErr(await h.api.post(`orders/${o.id}/close`, {}, t), 422, 'empty_order');
  await addLine(t, o.id, w.itemB.id, 2); // 20 000
  h.expectErr(await h.api.post(`orders/${o.id}/close`, {}, t), 422, 'draft_lines_pending');
  h.expectOk(await h.api.post(`orders/${o.id}/fire`, {}, t));
  h.expectErr(await h.api.post(`orders/${o.id}/close`, {}, t), 422, 'payment_incomplete');
  h.expectErr(await h.api.post(`orders/${o.id}/payments`, { kind: 'pay', method: 'cash', amount: 25000 }, t), 422, 'validation_failed');
  h.expectErr(await h.api.post(`orders/${o.id}/payments`, { kind: 'pay', method: 'free', amount: 5000 }, t), 422, 'reason_required');
  let ord = h.expectOk(await h.api.post(`orders/${o.id}/payments`, { kind: 'pay', method: 'cash', amount: 12000 }, t), 201);
  assert.equal(ord.totals.due, 8000);
  ord = h.expectOk(await h.api.post(`orders/${o.id}/payments`, { kind: 'tip', method: 'cash', amount: 5000 }, t), 201);
  assert.equal(ord.totals.due, 8000);
  assert.equal(ord.totals.tips, 5000);
  ord = h.expectOk(await h.api.post(`orders/${o.id}/payments`, { kind: 'pay', method: 'free', amount: 8000, note: 'Quà tặng' }, t), 201);
  assert.equal(ord.totals.due, 0);
  let floor = h.expectOk(await h.api.get('floor', t));
  assert.equal(floor.tables.find((x) => x.label === 'A1').status, 'billing');
  // removing a payment sends the table back to busy
  const freePay = ord.payments.find((p) => p.method === 'free');
  h.expectOk(await h.api.del(`orders/${o.id}/payments/${freePay.id}`, {}, t));
  assert.equal(h.expectOk(await h.api.get('floor', t)).tables.find((x) => x.label === 'A1').status, 'busy');
  h.expectOk(await h.api.post(`orders/${o.id}/payments`, { kind: 'pay', method: 'transfer', amount: 8000 }, t), 201);
  ord = h.expectOk(await h.api.post(`orders/${o.id}/close`, {}, t));
  assert.equal(ord.status, 'closed');
  assert.ok(ord.closedAt);
  floor = h.expectOk(await h.api.get('floor', t));
  const a1 = floor.tables.find((x) => x.label === 'A1');
  assert.equal(a1.status, 'cleaning');
  assert.equal(a1.order, null);
  h.expectOk(await h.api.post(`tables/${w.t1.id}/clean`, {}, t));
  assert.equal(h.expectOk(await h.api.get('floor', t)).tables.find((x) => x.label === 'A1').status, 'free');
  h.expectErr(await h.api.post(`orders/${o.id}/payments`, { kind: 'pay', method: 'cash', amount: 1 }, t), 422, 'invalid_state');
});

test('table in use, move, merge, cancel', async () => {
  const { t, w } = await setup();
  const a = await openTable(t, w.t1.id, 2);
  const err = h.expectErr(await h.api.post(`tables/${w.t1.id}/open`, { party: 2 }, t), 409, 'table_in_use');
  assert.equal(err.details.orderId, a.id);
  const moved = h.expectOk(await h.api.post(`orders/${a.id}/move`, { toTableId: w.t2.id }, t));
  assert.equal(moved.tableLabel, 'A2');
  const free = h.expectOk(await h.api.get('floor', t));
  assert.equal(free.tables.find((x) => x.label === 'A1').status, 'free');
  assert.equal(free.tables.find((x) => x.label === 'A2').status, 'busy');

  const b = await openTable(t, w.t3.id, 3);
  await addLine(t, a.id, w.itemB.id, 1);
  await addLine(t, b.id, w.itemB.id, 2);
  h.expectOk(await h.api.post(`orders/${a.id}/discounts`, { label: 'x', amount: 1000 }, t), 201);
  const merged = h.expectOk(await h.api.post(`orders/${a.id}/merge`, { intoOrderId: b.id }, t));
  assert.equal(merged.id, b.id);
  assert.equal(merged.party, 5);
  assert.equal(merged.lines.length, 2);
  assert.equal(merged.discounts.length, 1);
  const src = h.expectOk(await h.api.get(`orders/${a.id}`, t));
  assert.equal(src.status, 'cancelled');
  assert.equal(src.lines.length, 0);
  assert.equal(h.expectOk(await h.api.get('floor', t)).tables.find((x) => x.label === 'A2').status, 'cleaning');

  h.expectErr(await h.api.post(`orders/${b.id}/cancel`, {}, t), 422, 'reason_required');
  const c = h.expectOk(await h.api.post(`orders/${b.id}/cancel`, { reason: 'Khách bỏ về' }, t));
  assert.equal(c.status, 'cancelled');
  assert.equal(h.expectOk(await h.api.get('floor', t)).tables.find((x) => x.label === 'A3').status, 'free');
});

test('version: If-Match conflict returns the current order; appends need no version', async () => {
  const { t, w } = await setup();
  const o = await openTable(t, w.t1.id);
  const v0 = o.version;
  await addLine(t, o.id, w.itemB.id, 1); // append: version moves on without the client knowing
  const r = await h.api.patch(`orders/${o.id}`, { note: 'Ít đá' }, t, { 'If-Match': String(v0) });
  const body = h.expectErr(r, 409, 'version_conflict');
  assert.equal(body.details.current.lines.length, 1);
  const ok = await h.api.patch(`orders/${o.id}`, { note: 'Ít đá' }, t, { 'If-Match': `"${body.details.current.version}"` });
  assert.equal(h.expectOk(ok).note, 'Ít đá');
  const viaBody = await h.api.patch(`orders/${o.id}`, { note: 'x', version: 1 }, t);
  h.expectErr(viaBody, 409, 'version_conflict');
  // two devices add lines at the same time: both survive
  await Promise.all([addLine(t, o.id, w.itemB.id, 1, { note: 'a' }), addLine(t, o.id, w.itemB.id, 1, { note: 'b' }), addLine(t, o.id, w.itemB.id, 1, { note: 'c' })]);
  assert.equal(h.expectOk(await h.api.get(`orders/${o.id}`, t)).lines.length, 4);
});

test('Idempotency-Key: same key = same order, other body = 422, payment is not doubled', async () => {
  const { t, w } = await setup();
  const key = '11111111-1111-4111-8111-111111111111';
  const body = { kind: 'take', customerName: 'A', phone: '0988111222' };
  const a = h.expectOk(await h.api.post('orders', body, t, { 'Idempotency-Key': key }), 201);
  const b = h.expectOk(await h.api.post('orders', body, t, { 'Idempotency-Key': key }), 201);
  assert.equal(a.id, b.id);
  assert.equal(await h.models.Order.countDocuments({}), 1);
  h.expectErr(await h.api.post('orders', { kind: 'take', customerName: 'Khác' }, t, { 'Idempotency-Key': key }), 422, 'idempotency_key_reused');

  await addLine(t, a.id, w.itemB.id, 2);
  h.expectOk(await h.api.post(`orders/${a.id}/fire`, {}, t));
  const pk = '22222222-2222-4222-8222-222222222222';
  const p1 = h.expectOk(await h.api.post(`orders/${a.id}/payments`, { kind: 'pay', method: 'cash', amount: 20000 }, t, { 'Idempotency-Key': pk }), 201);
  const p2 = h.expectOk(await h.api.post(`orders/${a.id}/payments`, { kind: 'pay', method: 'cash', amount: 20000 }, t, { 'Idempotency-Key': pk }), 201);
  assert.equal(p1.payments.length, 1);
  assert.equal(p2.payments.length, 1);
  const ck = '33333333-3333-4333-8333-333333333333';
  h.expectOk(await h.api.post(`orders/${a.id}/close`, {}, t, { 'Idempotency-Key': ck }));
  h.expectOk(await h.api.post(`orders/${a.id}/close`, {}, t, { 'Idempotency-Key': ck })); // replay, not 422 invalid_state
});

test('stock: FEFO on close, tolerant of negative, waste on cancelled cooked dish, reopen restores', async () => {
  const { t, w } = await setup();
  h.expectOk(await h.api.put(`menu-items/${w.itemA.id}/recipe`, { lines: [{ ingredientId: w.beef.id, qty: 200 }] }, t));
  // no stock yet -> dish is unavailable
  const list = h.expectOk(await h.api.get('menu-items', t)).items.find((i) => i.id === w.itemA.id);
  assert.deepEqual([list.available, list.unavailableReason], [false, 'stock']);
  h.expectErr(await h.api.post('orders', { kind: 'take' }, t).then(async (r) => h.api.post(`orders/${r.body.id}/lines`, { itemId: w.itemA.id, qty: 1, options: ['Vừa'] }, t)), 422, 'item_unavailable');

  const later = h.T.addDays(h.T.today(), 10);
  const sooner = h.T.addDays(h.T.today(), 2);
  h.expectOk(await h.api.post('stock/receive', { ingredientId: w.beef.id, qty: 500, unitCost: 300, expiry: later }, t), 201);
  h.expectOk(await h.api.post('stock/receive', { ingredientId: w.beef.id, qty: 300, unitCost: 260, expiry: sooner }, t), 201);
  const o = await openTable(t, w.t1.id);
  await addLine(t, o.id, w.itemA.id, 2, { options: ['Vừa'] }); // 400 g
  await addLine(t, o.id, w.itemA.id, 1, { options: ['Lớn'] }); // 200 g
  h.expectOk(await h.api.post(`orders/${o.id}/fire`, {}, t));
  const lines = (await h.api.get(`orders/${o.id}`, t)).body.lines;
  const cooked = lines.find((l) => l.unitPrice === 139000);
  const cancelled = lines.find((l) => l.unitPrice === 154000);
  for (const step of ['start', 'done']) h.expectOk(await h.api.post(`orders/${o.id}/lines/${cooked.id}/${step}`, {}, t));
  for (const step of ['start', 'done']) h.expectOk(await h.api.post(`orders/${o.id}/lines/${cancelled.id}/${step}`, {}, t));
  // cancelling a cooked line writes waste immediately (200 g) and it is not deducted again at close
  h.expectErr(await h.api.post(`orders/${o.id}/lines/${cancelled.id}/cancel`, {}, t), 422, 'reason_required');
  h.expectOk(await h.api.post(`orders/${o.id}/lines/${cancelled.id}/cancel`, { reason: 'Khách đổi món' }, t));
  const hand = async () => (await h.api.get('ingredients', t)).body.items.find((i) => i.id === w.beef.id).onHand;
  assert.equal(await hand(), 600);
  const full = (await h.api.get(`orders/${o.id}`, t)).body;
  h.expectOk(await h.api.post(`orders/${o.id}/payments`, { kind: 'pay', method: 'cash', amount: full.totals.due }, t), 201);
  h.expectOk(await h.api.post(`orders/${o.id}/close`, {}, t));
  assert.equal(await hand(), 200); // 800 - 200 waste - 400 sale
  const lots = h.expectOk(await h.api.get(`stock-lots?ingredientId=${w.beef.id}`, t)).items;
  const byExpiry = Object.fromEntries(lots.map((l) => [l.expiry, l.remaining]));
  assert.equal(byExpiry[sooner], 0); // 300 g used first: 200 waste + 100 of the sale
  assert.equal(byExpiry[later], 200); // the remaining 300 g of the sale came from the later lot
  const moves = h.expectOk(await h.api.get(`stock-moves?ingredientId=${w.beef.id}&kinds=sale,waste`, t)).items;
  assert.deepEqual(moves.map((m) => m.kind).sort(), ['sale', 'waste']);

  // reopen: stock goes back, closing again deducts once more
  h.expectOk(await h.api.post(`orders/${o.id}/reopen`, {}, t));
  assert.equal(await hand(), 600);
  assert.equal(h.expectOk(await h.api.get('floor', t)).tables.find((x) => x.label === 'A1').status, 'busy');
  h.expectOk(await h.api.post(`orders/${o.id}/close`, {}, t));
  assert.equal(await hand(), 200);
});

test('stocktake / waste / lot delete / purchase edit keep the ledger consistent', async () => {
  const { t, w } = await setup();
  const supplier = h.expectOk(await h.api.post('suppliers', { name: 'Chợ đầu mối' }, t), 201);
  const p = h.expectOk(await h.api.post('purchases', { supplierId: supplier.id, method: 'cash', lines: [{ ingredientId: w.beef.id, qty: 5000, unitCost: 255, expiry: h.T.addDays(h.T.today(), 5) }] }, t, { 'Idempotency-Key': 'k-1' }), 201);
  assert.equal(p.total, 1275000);
  const ing = async () => (await h.api.get('ingredients', t)).body.items.find((i) => i.id === w.beef.id);
  assert.deepEqual([(await ing()).onHand, (await ing()).lastCost], [5000, 255]);
  h.expectErr(await h.api.post('stock/waste', { ingredientId: w.beef.id, qty: 300 }, t), 422, 'reason_required');
  h.expectOk(await h.api.post('stock/waste', { ingredientId: w.beef.id, qty: 300, reason: 'Hỏng' }, t), 201);
  h.expectOk(await h.api.post('stock/stocktake', { ingredientId: w.beef.id, countedQty: 4000 }, t)); // -700
  assert.equal((await ing()).onHand, 4000);
  h.expectOk(await h.api.post('stock/stocktake', { ingredientId: w.beef.id, countedQty: 4500 }, t)); // +500 without a lot
  assert.equal((await ing()).onHand, 4500);
  // editing the purchase undoes the old lots (-received) and applies the new ones
  h.expectOk(await h.api.put(`purchases/${p.id}`, { supplierId: supplier.id, method: 'cash', lines: [{ ingredientId: w.beef.id, qty: 1000, unitCost: 260 }] }, t));
  assert.equal((await ing()).onHand, 4500 - 5000 + 1000);
  h.expectOk(await h.api.del(`purchases/${p.id}`, {}, t), 204);
  assert.equal((await ing()).onHand, 4500 - 5000);
  assert.equal((await h.api.get('stock-lots', t)).body.items.length, 0);
  const sug = h.expectOk(await h.api.get('stock/reorder-suggestions', t));
  assert.equal(sug.enoughData, false);
});

test('promotions: validity, minimum, limit and release on removal', async () => {
  const { t, w } = await setup();
  h.expectOk(await h.api.post('promotions', { code: 'hello10', kind: 'percent', value: 10, minAmount: 50000, limit: 1 }, t), 201);
  h.expectErr(await h.api.post('promotions', { code: 'HELLO10', kind: 'percent', value: 10 }, t), 409, 'duplicate');
  const o = await openTable(t, w.t1.id);
  await addLine(t, o.id, w.itemB.id, 2);
  h.expectErr(await h.api.post(`orders/${o.id}/apply-promo`, { code: 'NOPE' }, t), 422, 'promo_invalid');
  h.expectErr(await h.api.post(`orders/${o.id}/apply-promo`, { code: 'hello10' }, t), 422, 'promo_min_amount');
  await addLine(t, o.id, w.itemB.id, 4);
  const applied = h.expectOk(await h.api.post(`orders/${o.id}/apply-promo`, { code: 'HELLO10' }, t));
  assert.equal(applied.discounts[0].label, 'Mã HELLO10');
  assert.equal(applied.discounts[0].amount, 6000);
  const o2 = await openTable(t, w.t2.id);
  await addLine(t, o2.id, w.itemB.id, 6);
  h.expectErr(await h.api.post(`orders/${o2.id}/apply-promo`, { code: 'HELLO10' }, t), 422, 'promo_invalid'); // limit reached
  h.expectOk(await h.api.del(`orders/${o.id}/discounts/${applied.discounts[0].id}`, {}, t));
  h.expectOk(await h.api.post(`orders/${o2.id}/apply-promo`, { code: 'HELLO10' }, t)); // released
  const promos = h.expectOk(await h.api.get('promotions', t)).items;
  assert.equal(promos[0].used, 1);
});

test('customers: phone match links orders, points on close, phone_taken, merge', async () => {
  const { t, w } = await setup();
  const c = h.expectOk(await h.api.post('customers', { name: 'Chị Hương', phone: '0988 123 456', allergy: 'Hải sản' }, t), 201);
  const dup = h.expectErr(await h.api.post('customers', { name: 'Khác', phone: '+84988123456' }, t), 409, 'phone_taken');
  assert.equal(dup.details.customerId, c.id);
  const o = h.expectOk(await h.api.post(`tables/${w.t1.id}/open`, { party: 2, phone: '0988123456' }, t), 201);
  assert.equal(o.customerId, c.id);
  assert.equal(o.customerName, 'Chị Hương');
  assert.equal(o.allergy, 'Hải sản');
  h.expectOk(await h.api.patch(`menu-items/${w.itemB.id}`, { price: 100000 }, t));
  await addLine(t, o.id, w.itemB.id, 3);
  h.expectOk(await h.api.post(`orders/${o.id}/fire`, {}, t));
  h.expectOk(await h.api.post(`orders/${o.id}/payments`, { kind: 'pay', method: 'cash', amount: 300000 }, t), 201);
  h.expectOk(await h.api.post(`orders/${o.id}/close`, {}, t));
  const after = h.expectOk(await h.api.get(`customers/${c.id}`, t));
  assert.deepEqual([after.points, after.visits, after.totalSpent], [30, 1, 300000]);
  const other = h.expectOk(await h.api.post('customers', { name: 'Hương 2', phone: '0912000111' }, t), 201);
  const merged = h.expectOk(await h.api.post(`customers/${c.id}/merge`, { dropId: other.id }, t));
  assert.equal(merged.id, c.id);
  assert.equal((await h.api.get('customers', t)).body.items.length, 1);
  assert.equal((await h.api.get('customers?q=huong', t)).body.items.length, 1);
  h.expectOk(await h.api.del(`customers/${c.id}`, {}, t), 204);
  assert.equal((await h.api.get(`orders/${o.id}`, t)).body.customerName, 'Chị Hương');
});

test('refund and reopen are audited; refund cannot exceed what was paid', async () => {
  const { t, w } = await setup();
  const o = h.expectOk(await h.api.post('orders', { kind: 'take' }, t), 201);
  await addLine(t, o.id, w.itemB.id, 5);
  h.expectOk(await h.api.post(`orders/${o.id}/fire`, {}, t));
  h.expectOk(await h.api.post(`orders/${o.id}/payments`, { kind: 'pay', method: 'cash', amount: 50000 }, t), 201);
  h.expectErr(await h.api.post(`orders/${o.id}/refund`, { amount: 1000, method: 'cash', reason: 'x' }, t), 422, 'invalid_state'); // still open
  h.expectOk(await h.api.post(`orders/${o.id}/close`, {}, t));
  h.expectErr(await h.api.post(`orders/${o.id}/refund`, { amount: 1000, method: 'cash' }, t), 422, 'reason_required');
  h.expectErr(await h.api.post(`orders/${o.id}/refund`, { amount: 60000, method: 'cash', reason: 'Quá' }, t), 422, 'validation_failed');
  const r = h.expectOk(await h.api.post(`orders/${o.id}/refund`, { amount: 20000, method: 'cash', reason: 'Món lỗi' }, t, { 'Idempotency-Key': 'rf-1' }), 201);
  assert.equal(r.totals.refunded, 20000);
  h.expectOk(await h.api.post(`orders/${o.id}/refund`, { amount: 20000, method: 'cash', reason: 'Món lỗi' }, t, { 'Idempotency-Key': 'rf-1' }), 201);
  assert.equal((await h.api.get(`orders/${o.id}`, t)).body.totals.refunded, 20000);
  const log = (await h.api.get('audit-log', t)).body.items.map((a) => a.action);
  assert.ok(log.includes('refund'));
});
