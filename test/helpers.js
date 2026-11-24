process.env.NODE_ENV = 'test';
const fs = require('fs');
// Tests never read the developer's .env (real SMTP, cron secret, Atlas URI): blank every key it defines.
try {
  for (const k of Object.keys(require('dotenv').parse(fs.readFileSync(require('path').join(__dirname, '..', '.env'))))) {
    if (!(k in process.env)) process.env[k] = '';
  }
} catch { /* no .env */ }
// Offline machines: reuse a locally installed mongod instead of downloading one.
if (!process.env.MONGOMS_SYSTEM_BINARY && fs.existsSync('/opt/homebrew/bin/mongod')) {
  process.env.MONGOMS_SYSTEM_BINARY = '/opt/homebrew/bin/mongod';
  process.env.MONGOMS_VERSION = process.env.MONGOMS_VERSION || '9.0.4';
}

const mongoose = require('mongoose');
const request = require('supertest');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

const app = require('../src/app');
const models = require('../src/models');
const T = require('../src/lib/time');

let rs;

async function start() {
  rs = await MongoMemoryReplSet.create({ replSet: { count: 1, configSettings: { electionTimeoutMillis: 10000 } } });
  mongoose.set('strictQuery', true);
  await mongoose.connect(rs.getUri());
  for (const name of mongoose.modelNames()) await mongoose.model(name).syncIndexes();
}
async function stop() {
  await mongoose.disconnect();
  await rs.stop();
}
async function reset() {
  for (const c of await mongoose.connection.db.collections()) await c.deleteMany({});
}

const bearer = (token) => (token ? { Authorization: `Bearer ${token}` } : {});
const withHeaders = (req, token, headers) => { const r = req.set(bearer(token)); return headers ? r.set(headers) : r; };
const api = {
  get: (p, token, headers) => withHeaders(request(app).get(`/v1/${p}`), token, headers),
  post: (p, body, token, headers) => withHeaders(request(app).post(`/v1/${p}`), token, headers).send(body || {}),
  put: (p, body, token, headers) => withHeaders(request(app).put(`/v1/${p}`), token, headers).send(body || {}),
  patch: (p, body, token, headers) => withHeaders(request(app).patch(`/v1/${p}`), token, headers).send(body || {}),
  del: (p, body, token, headers) => withHeaders(request(app).delete(`/v1/${p}`), token, headers).send(body || {}),
};

const PASSWORD = 'Matkhau123';

const expectOk = (res, status = 200) => {
  if (res.status !== status) throw new Error(`${res.req?.method} ${res.req?.path} -> ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
};
const expectErr = (res, status, code) => {
  if (res.status !== status || res.body.code !== code) throw new Error(`${res.req?.method} ${res.req?.path} -> ${res.status} ${JSON.stringify(res.body)} (wanted ${status} ${code})`);
  return res.body;
};

/** Bootstraps the first admin through the API: { token, login, account }. */
async function admin(email = 'admin@dinedesk.test', name = 'Admin Test') {
  const login = expectOk(await api.post('auth/register', { email, name, password: PASSWORD }), 201);
  return { token: login.accessToken, login, account: login.account };
}

/** A small restaurant: area, 3 tables, a group, 2 items, 1 ingredient with a recipe on item A. */
async function world(token) {
  const area = expectOk(await api.post('areas', { name: 'Tầng 1' }, token), 201);
  const t1 = expectOk(await api.post('tables', { areaId: area.id, label: 'A1', seats: 4 }, token), 201);
  const t2 = expectOk(await api.post('tables', { areaId: area.id, label: 'A2', seats: 2 }, token), 201);
  const t3 = expectOk(await api.post('tables', { areaId: area.id, label: 'A3', seats: 6 }, token), 201);
  const group = expectOk(await api.post('menu-groups', { name: 'Món chính' }, token), 201);
  const itemA = expectOk(await api.post('menu-items', {
    groupId: group.id, code: 'M01', name: 'Bò lúc lắc', price: 139000, station: 'kitchen',
    options: [{ name: 'Size', required: true, multi: false, choices: [{ name: 'Vừa', extra: 0 }, { name: 'Lớn', extra: 15000 }] }, { name: 'Vị', required: false, multi: true, choices: [{ name: 'Cay', extra: 0 }] }],
  }, token), 201);
  const itemB = expectOk(await api.post('menu-items', { groupId: group.id, code: 'M02', name: 'Trà đá', price: 10000, station: 'bar' }, token), 201);
  const beef = expectOk(await api.post('ingredients', { name: 'Thịt bò', unit: 'g', minQty: 1000 }, token), 201);
  return { area, t1, t2, t3, group, itemA, itemB, beef };
}

const VN_NOON = () => T.today();

module.exports = { start, stop, reset, api, app, request, models, PASSWORD, expectOk, expectErr, admin, world, VN_NOON, T };
