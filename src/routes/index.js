/**
 * /v1 routes (spec 4). Public: health, auth/register|login|refresh|forgot|reset. Everything else needs a Bearer token;
 * accounts with a temporary password only reach change-password, logout and GET /me.
 * Money-writing and order-creating commands are wrapped with `Idempotency-Key` (lib/idempotency.js).
 */
const express = require('express');
const mongoose = require('mongoose');
const config = require('../config');
const { asyncHandler } = require('../lib/errors');
const { authenticate, authenticateLoose, resolve } = require('../middleware/auth');
const { idempotent } = require('../lib/idempotency');
const accounts = require('../services/accounts');
const settings = require('../services/settings');
const catalog = require('../services/catalog');
const stock = require('../services/stock');
const orders = require('../services/orders');
const bookings = require('../services/bookings');
const shifts = require('../services/shifts');
const reports = require('../services/reports');
const audit = require('../services/audit');
const { AdminAction } = require('../models');
const { paginate } = require('../lib/page');
const T = require('../lib/time');

const r = express.Router();
const h = asyncHandler;

/** Loads the restaurant context (timezone, rules) once per request. */
const withCtx = (fn, status) => h(async (req, res) => {
  const ctx = await settings.context();
  const out = await fn(req, ctx);
  if (out === undefined) return res.status(204).end();
  return res.status(status || 200).json(out);
});
const done = (fn) => h(async (req, res) => { await fn(req); res.status(204).end(); });
/** fn returns { status, body }, run once per Idempotency-Key. */
const idem = (scope, fn) => h(async (req, res) => {
  const ctx = await settings.context();
  const out = await idempotent(req, scope, () => fn(req, ctx));
  res.status(out.status).json(out.body);
});
const csvOut = (name, fn) => h(async (req, res) => {
  const ctx = await settings.context();
  res.set('Content-Type', 'text/csv; charset=utf-8').set('Content-Disposition', `attachment; filename="${name}"`).send(await fn(req.query, ctx));
});

// ---------- public ----------

r.get('/health', (_req, res) => {
  const up = mongoose.connection.readyState === 1;
  res.status(up ? 200 : 503).json({ status: up ? 'ok' : 'degraded', apiVersion: config.apiVersion, minAppVersion: config.minAppVersion });
});

r.post('/auth/register', h(async (req, res) => res.status(201).json(await accounts.register(req.body, { lang: req.lang }))));
r.post('/auth/login', h(async (req, res) => res.json(await accounts.login(req.body))));
r.post('/auth/refresh', h(async (req, res) => res.json(await accounts.refresh(req.body))));
r.post('/auth/forgot', h(async (req, res) => res.status(202).json(await accounts.forgot(req.body, { lang: req.lang }))));
r.post('/auth/reset', done((req) => accounts.reset(req.body, { lang: req.lang })));
// Bearer is optional on logout: an expired access token must not prevent signing out with the refresh token.
r.post('/auth/logout', done(async (req) => {
  let auth = null;
  if (req.get('authorization')) auth = await resolve(req).catch(() => null);
  await accounts.logout(req.body, auth);
}));

// ---------- signed in, even with a temporary password ----------

r.post('/auth/change-password', authenticateLoose, done((req) => accounts.changePassword(req.auth, req.body, { lang: req.lang })));
r.get('/me', authenticateLoose, h(async (req, res) => res.json(accounts.present(req.auth.account))));

// ---------- signed in ----------

r.use(authenticate);

r.patch('/me', h(async (req, res) => res.json(await accounts.updateMe(req.auth, req.body))));
r.delete('/me', done((req) => accounts.deleteAccount(req.auth, req.body)));
r.get('/admins', h(async (_req, res) => res.json(await accounts.listAdmins())));
r.post('/admins', h(async (req, res) => res.status(201).json(await accounts.createAdmin(req.auth, req.body))));
r.post('/admins/:id/reset-password', h(async (req, res) => res.json(await accounts.resetAdminPassword(req.auth, req.params.id, req.body))));
r.post('/admins/:id/revoke', done((req) => accounts.revokeAdmin(req.auth, req.params.id)));

r.get('/shop', withCtx((_q, ctx) => ctx.shop));
r.put('/shop', h(async (req, res) => res.json(await settings.putShop(req.body))));
r.get('/shop/rules', withCtx((_q, ctx) => ctx.rules));
r.put('/shop/rules', h(async (req, res) => res.json(await settings.putRules(req.body))));

/** list/create/get/patch/delete for a crud resource. */
function mount(path, c, extra = {}) {
  r.get(path, withCtx((req, ctx) => (extra.list ? extra.list(req.query, ctx) : c.list(req.query, ctx))));
  r.post(path, withCtx((req, ctx) => c.create(req.body, ctx, req.auth), 201));
  r.get(`${path}/:id`, withCtx((req, ctx) => c.get(req.params.id, ctx)));
  r.patch(`${path}/:id`, withCtx((req, ctx) => c.patch(req.params.id, req.body, ctx, req.auth)));
  r.delete(`${path}/:id`, done((req) => c.remove(req.params.id, req.auth)));
}

mount('/areas', catalog.areas);
mount('/tables', catalog.tables);
r.post('/tables/:id/open', idem('table-open', async (req, ctx) => orders.openTableEndpoint(req.auth, req.params.id, req.body, ctx)));
r.post('/tables/:id/clean', withCtx(async (req, ctx) => catalog.presentTable(await bookings.cleanTable(req.params.id), ctx)));
r.get('/floor', withCtx((_q, ctx) => bookings.floor(ctx)));

mount('/menu-groups', catalog.groups);
r.post('/menu-items/bulk-price', h(async (req, res) => res.json(await catalog.bulkPrice(req.auth, req.body))));
mount('/menu-items', catalog.items);
r.get('/menu-items/:id/recipe', h(async (req, res) => res.json(await catalog.getRecipe(req.params.id))));
r.put('/menu-items/:id/recipe', withCtx((req, ctx) => catalog.setRecipe(req.params.id, req.body, ctx)));
r.get('/menu-items/:id/cost', h(async (req, res) => res.json(await catalog.itemCost(req.params.id))));

// ---------- orders ----------

r.post('/orders', idem('order-create', (req, ctx) => orders.createOrder(req.auth, req.body, ctx)));
r.get('/orders', withCtx((req, ctx) => orders.list(req.query, ctx)));
r.get('/orders/:id', withCtx((req, ctx) => orders.get(req.params.id, ctx)));
r.patch('/orders/:id', withCtx((req, ctx) => orders.patch(req.params.id, req, ctx)));
r.post('/orders/:id/lines', withCtx((req, ctx) => orders.addLine(req.params.id, req, ctx), 201));
r.patch('/orders/:id/lines/:lineId', withCtx((req, ctx) => orders.patchLine(req.params.id, req.params.lineId, req, ctx)));
r.delete('/orders/:id/lines/:lineId', withCtx((req, ctx) => orders.deleteLine(req.params.id, req.params.lineId, req, ctx)));
r.post('/orders/:id/lines/:lineId/cancel', withCtx((req, ctx) => orders.cancelLine(req.auth, req.params.id, req.params.lineId, req, ctx)));
r.post('/orders/:id/lines/:lineId/comp', withCtx((req, ctx) => orders.compLine(req.auth, req.params.id, req.params.lineId, req, ctx)));
for (const step of ['start', 'done', 'served']) {
  r.post(`/orders/:id/lines/:lineId/${step}`, withCtx((req, ctx) => orders.kitchenStep(req.params.id, req.params.lineId, step, ctx)));
}
r.post('/orders/:id/fire', withCtx((req, ctx) => orders.fire(req.params.id, req, ctx)));
r.post('/orders/:id/move', withCtx((req, ctx) => orders.moveTable(req.auth, req.params.id, req, ctx)));
r.post('/orders/:id/merge', withCtx((req, ctx) => orders.mergeOrders(req.auth, req.params.id, req, ctx)));
r.post('/orders/:id/discounts', withCtx((req, ctx) => orders.addDiscount(req.auth, req.params.id, req, ctx), 201));
r.delete('/orders/:id/discounts/:discountId', withCtx((req, ctx) => orders.removeDiscount(req.params.id, req.params.discountId, req, ctx)));
r.post('/orders/:id/apply-promo', withCtx((req, ctx) => orders.applyPromo(req.params.id, req, ctx)));
r.post('/orders/:id/payments', idem('order-pay', async (req, ctx) => ({ status: 201, body: await orders.addPayment(req.auth, req.params.id, req, ctx) })));
r.delete('/orders/:id/payments/:paymentId', withCtx((req, ctx) => orders.removePayment(req.params.id, req.params.paymentId, req, ctx)));
r.post('/orders/:id/close', idem('order-close', async (req, ctx) => ({ status: 200, body: await orders.close(req.auth, req.params.id, req, ctx) })));
r.post('/orders/:id/cancel', withCtx((req, ctx) => orders.cancel(req.auth, req.params.id, req, ctx)));
r.post('/orders/:id/reopen', withCtx((req, ctx) => orders.reopen(req.auth, req.params.id, req, ctx)));
r.post('/orders/:id/refund', idem('order-refund', async (req, ctx) => ({ status: 201, body: await orders.refund(req.auth, req.params.id, req, ctx) })));
r.put('/orders/:id/delivery-status', withCtx((req, ctx) => orders.setDeliveryStatus(req.params.id, req, ctx)));

r.get('/kitchen', withCtx((req, ctx) => orders.kitchen(req.query, ctx)));

// ---------- stock ----------

mount('/ingredients', catalog.ingredients);
r.get('/stock-lots', h(async (req, res) => res.json(await stock.listLots(req.query))));
r.patch('/stock-lots/:id', h(async (req, res) => res.json(await stock.patchLot(req.params.id, req.body))));
r.delete('/stock-lots/:id', done((req) => stock.deleteLot(req.auth, req.params.id)));
r.get('/stock-moves', withCtx((req, ctx) => stock.listMoves(req.query, ctx)));
r.post('/stock/receive', h(async (req, res) => res.status(201).json(await stock.receive(req.body))));
r.post('/stock/waste', h(async (req, res) => res.status(201).json(await stock.waste(req.auth, req.body))));
r.post('/stock/stocktake', h(async (req, res) => res.json(await stock.stocktake(req.auth, req.body))));
r.get('/stock/reorder-suggestions', withCtx((_q, ctx) => stock.reorderSuggestions(ctx)));

mount('/suppliers', catalog.suppliers);
r.get('/purchases', withCtx((req, ctx) => stock.listPurchases(req.query, ctx)));
r.post('/purchases', idem('purchase', (req, ctx) => stock.createPurchase(req.auth, req.body, ctx)));
r.get('/purchases/:id', withCtx((req, ctx) => stock.getPurchase(req.params.id, ctx)));
r.put('/purchases/:id', withCtx((req, ctx) => stock.updatePurchase(req.auth, req.params.id, req.body, ctx)));
r.delete('/purchases/:id', done((req) => stock.deletePurchase(req.auth, req.params.id)));

// ---------- people, promos, staff ----------

r.post('/customers/:id/merge', withCtx((req, ctx) => catalog.mergeCustomers(req.auth, req.params.id, req.body, ctx)));
mount('/customers', catalog.customers, { list: (q, ctx) => catalog.listCustomers(q, ctx) });
mount('/promotions', catalog.promotions);
mount('/staff', catalog.staff);
mount('/expenses', catalog.expenses);
r.get('/sales-targets/:month', h(async (req, res) => res.json(await catalog.getTarget(req.params.month))));
r.put('/sales-targets/:month', h(async (req, res) => res.json(await catalog.putTarget(req.params.month, req.body))));

// ---------- bookings ----------

r.get('/bookings/availability', withCtx((req, ctx) => bookings.availability(req.query, ctx)));
r.get('/bookings', withCtx((req, ctx) => bookings.list(req.query, ctx)));
r.post('/bookings', idem('booking', (req, ctx) => bookings.create(req.body, ctx)));
r.patch('/bookings/:id', withCtx((req, ctx) => bookings.patch(req.params.id, req.body, ctx)));
r.delete('/bookings/:id', done((req) => bookings.remove(req.auth, req.params.id)));
r.post('/bookings/:id/status', withCtx((req, ctx) => bookings.setStatus(req.auth, req.params.id, req.body, ctx)));
r.post('/bookings/:id/arrive', withCtx((req, ctx) => bookings.arrive(req.auth, req.params.id, ctx)));
r.get('/wait-list', withCtx((_q, ctx) => bookings.listWait(ctx)));
r.post('/wait-list', withCtx((req, ctx) => bookings.addWait(req.body, ctx), 201));
r.delete('/wait-list/:id', done((req) => bookings.removeWait(req.params.id)));

// ---------- shifts / cash ----------

r.get('/shifts/current', withCtx((_q, ctx) => shifts.getCurrent(ctx)));
r.post('/shifts/open', idem('shift-open', (req, ctx) => shifts.open(req.auth, req.body, ctx)));
r.post('/shifts/close', withCtx((req, ctx) => shifts.close(req.auth, req.body, ctx)));
r.get('/shifts', withCtx((req, ctx) => shifts.list(req.query, ctx)));
r.get('/cash-entries', withCtx((req, ctx) => shifts.listEntries(req.query, ctx)));
r.post('/cash-entries', idem('cash-entry', (req, ctx) => shifts.addEntry(req.body, ctx)));
r.delete('/cash-entries/:id', done((req) => shifts.removeEntry(req.params.id)));
r.get('/day-close', withCtx((req, ctx) => reports.dayClose(req.query, ctx)));

// ---------- dashboard / reports ----------

r.get('/dashboard/summary', withCtx((req, ctx) => reports.dashboardSummary(req.query, ctx)));
r.get('/dashboard/revenue-series', withCtx((req, ctx) => reports.revenueSeries(req.query, ctx)));
r.get('/dashboard/peaks', withCtx((req, ctx) => reports.peaks(req.query, ctx)));
r.get('/dashboard/items', withCtx(async (req, ctx) => ({ items: await reports.itemsReport(req.query, ctx) })));
r.get('/dashboard/today-glance', withCtx((_q, ctx) => reports.todayGlance(ctx)));
r.get('/reports/profit-loss', withCtx((req, ctx) => reports.profitLoss(req.query, ctx)));
r.get('/reports/item-margins', withCtx(async () => ({ items: await reports.itemMargins() })));
r.get('/reports/month-progress', withCtx((_q, ctx) => reports.monthProgress(ctx)));

r.get('/search', withCtx((req, ctx) => reports.search(req.query, ctx)));
r.get('/reminders', withCtx((req, ctx) => reports.reminders(req.query, ctx)));

r.get('/exports/orders.csv', csvOut('orders.csv', reports.exportOrders));
r.get('/exports/revenue.csv', csvOut('revenue.csv', reports.exportRevenue));
r.get('/exports/stock.csv', csvOut('stock.csv', reports.exportStock));
r.get('/exports/closeout.csv', csvOut('closeout.csv', reports.exportCloseout));

r.get('/audit-log', withCtx(async (req, ctx) => {
  const f = {};
  const range = {};
  if (req.query.from) range.$gte = T.localToUtc(String(req.query.from), '00:00', ctx.tz);
  if (req.query.to) range.$lt = T.localToUtc(String(req.query.to), '00:00', ctx.tz);
  if (Object.keys(range).length) f.at = range;
  return paginate(AdminAction, f, req.query, {
    field: 'at',
    present: (rows) => rows.map((a) => ({ id: a._id, adminId: a.adminId, adminName: a.adminName, action: a.action, targetType: a.targetType, targetId: a.targetId, note: a.note, at: ctx.iso(a.at) })),
  });
}));

void audit;
module.exports = r;
