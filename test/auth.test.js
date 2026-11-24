const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const h = require('./helpers');
const mailer = require('../src/lib/mailer');

before(h.start);
after(h.stop);
beforeEach(h.reset);

test('register bootstraps the first admin only; later sign-ups are closed', async () => {
  const a = await h.admin();
  assert.equal(a.login.expiresIn, 7200);
  assert.equal(a.login.account.email, 'admin@dinedesk.test');
  assert.equal(a.login.account.mustChangePassword, false);
  assert.ok(a.login.refreshToken);
  assert.equal(a.login.account.passwordHash, undefined);
  h.expectErr(await h.api.post('auth/register', { email: 'x@y.vn', name: 'X', password: h.PASSWORD }), 403, 'registration_closed');
});

test('register validation', async () => {
  h.expectErr(await h.api.post('auth/register', { email: 'nope', name: 'A', password: h.PASSWORD }), 400, 'validation_failed');
  h.expectErr(await h.api.post('auth/register', { email: 'a@b.vn', name: 'A', password: 'abc' }), 400, 'validation_failed');
  h.expectErr(await h.api.post('auth/register', { email: 'a@b.vn', password: h.PASSWORD }), 400, 'validation_failed');
  const ok = await h.api.post('auth/register', { email: 'A@B.vn', name: 'A', password: h.PASSWORD });
  assert.equal(h.expectOk(ok, 201).account.email, 'a@b.vn');
});

test('login: wrong credentials look the same, lockout after 5 failures', async () => {
  await h.admin();
  h.expectOk(await h.api.post('auth/login', { email: 'admin@dinedesk.test', password: h.PASSWORD }));
  h.expectErr(await h.api.post('auth/login', { email: 'nobody@dinedesk.test', password: h.PASSWORD }), 401, 'invalid_credentials');
  for (let i = 0; i < 5; i += 1) h.expectErr(await h.api.post('auth/login', { email: 'admin@dinedesk.test', password: 'Sai12345' }), 401, 'invalid_credentials');
  h.expectErr(await h.api.post('auth/login', { email: 'admin@dinedesk.test', password: h.PASSWORD }), 429, 'rate_limited');
});

test('refresh rotates; reusing the old token revokes the session', async () => {
  const a = await h.admin();
  const r1 = h.expectOk(await h.api.post('auth/refresh', { refreshToken: a.login.refreshToken }));
  assert.notEqual(r1.refreshToken, a.login.refreshToken);
  h.expectOk(await h.api.get('me', r1.accessToken));
  h.expectErr(await h.api.post('auth/refresh', { refreshToken: a.login.refreshToken }), 401, 'unauthorized');
  h.expectErr(await h.api.get('me', r1.accessToken), 401, 'unauthorized'); // session revoked by the reuse
});

test('missing / garbage token is 401 unauthorized', async () => {
  h.expectErr(await h.api.get('shop'), 401, 'unauthorized');
  h.expectErr(await h.api.get('shop', 'abc.def.ghi'), 401, 'unauthorized');
});

test('forgot + reset: code by email, one use, signs out every device', async () => {
  const a = await h.admin();
  h.expectErr(await h.api.post('auth/reset', { token: 'ABCD-EFGH', newPassword: 'Moi12345' }), 400, 'reset_invalid');
  const same = await h.api.post('auth/forgot', { email: 'nobody@dinedesk.test' });
  assert.equal(same.status, 202);
  assert.equal(same.body.status, 'accepted');
  h.expectOk(await h.api.post('auth/forgot', { email: 'admin@dinedesk.test' }), 202);
  const mail = mailer.testOutbox.filter((m) => m.kind === 'reset_code').pop();
  assert.equal(mail.to, 'admin@dinedesk.test');
  const code = /([A-Z2-9]{4}-[A-Z2-9]{4})/.exec(mail.text)[1];
  h.expectErr(await h.api.post('auth/reset', { token: code, newPassword: 'weak' }), 400, 'validation_failed');
  h.expectOk(await h.api.post('auth/reset', { token: code.toLowerCase(), newPassword: 'Moi12345' }), 204);
  h.expectErr(await h.api.post('auth/reset', { token: code, newPassword: 'Khac12345' }), 400, 'reset_invalid');
  h.expectErr(await h.api.get('me', a.token), 401, 'unauthorized');
  h.expectErr(await h.api.post('auth/login', { email: 'admin@dinedesk.test', password: h.PASSWORD }), 401, 'invalid_credentials');
  h.expectOk(await h.api.post('auth/login', { email: 'admin@dinedesk.test', password: 'Moi12345' }));
});

test('change-password: wrong old password is 422 wrong_password; other devices signed out', async () => {
  const a = await h.admin();
  const other = h.expectOk(await h.api.post('auth/login', { email: 'admin@dinedesk.test', password: h.PASSWORD }));
  h.expectErr(await h.api.post('auth/change-password', { oldPassword: 'Sai12345', newPassword: 'Moi12345' }, a.token), 422, 'wrong_password');
  h.expectOk(await h.api.post('auth/change-password', { oldPassword: h.PASSWORD, newPassword: 'Moi12345' }, a.token), 204);
  h.expectOk(await h.api.get('me', a.token));
  h.expectErr(await h.api.get('me', other.accessToken), 401, 'unauthorized');
});

test('admins: temp password blocks everything but change-password / me / logout; last admin is protected', async () => {
  const a = await h.admin();
  const created = h.expectOk(await h.api.post('admins', { email: 'b@dinedesk.test', name: 'Bao', tempPassword: 'Tam12345' }, a.token), 201);
  assert.equal(created.mustChangePassword, true);
  h.expectErr(await h.api.post('admins', { email: 'B@dinedesk.test', name: 'Bao', tempPassword: 'Tam12345' }, a.token), 409, 'email_taken');
  const b = h.expectOk(await h.api.post('auth/login', { email: 'b@dinedesk.test', password: 'Tam12345' }));
  assert.equal(b.mustChangePassword, true);
  assert.equal(h.expectOk(await h.api.get('me', b.accessToken)).mustChangePassword, true);
  h.expectErr(await h.api.get('shop', b.accessToken), 403, 'password_change_required');
  h.expectOk(await h.api.post('auth/change-password', { oldPassword: 'Tam12345', newPassword: 'Moi12345' }, b.accessToken), 204);
  h.expectOk(await h.api.get('shop', b.accessToken));

  // reset by another admin: temp again + every token of that admin dies
  h.expectOk(await h.api.post(`admins/${created.id}/reset-password`, { tempPassword: 'Tam54321' }, a.token));
  h.expectErr(await h.api.get('me', b.accessToken), 401, 'unauthorized');

  h.expectErr(await h.api.post(`admins/${a.account.id}/revoke`, {}, a.token), 403, 'forbidden');
  h.expectOk(await h.api.post(`admins/${created.id}/revoke`, {}, a.token), 204);
  h.expectErr(await h.api.post(`admins/${a.account.id}/revoke`, {}, a.token), 409, 'last_admin');
  h.expectErr(await h.api.del('me', { password: h.PASSWORD }, a.token), 409, 'last_admin');
});

test('DELETE /me: wrong password 422, real delete when another admin exists', async () => {
  const a = await h.admin();
  h.expectOk(await h.api.post('admins', { email: 'b@dinedesk.test', name: 'Bao', tempPassword: 'Tam12345' }, a.token), 201);
  h.expectErr(await h.api.del('me', { password: 'Sai12345' }, a.token), 422, 'wrong_password');
  h.expectOk(await h.api.del('me', { password: h.PASSWORD }, a.token), 204);
  assert.equal(await h.models.Account.countDocuments({}), 1);
});

test('health is public and the old app gets 426', async () => {
  const hl = h.expectOk(await h.api.get('health'));
  assert.equal(hl.status, 'ok');
  assert.ok(hl.minAppVersion);
  const res = await h.api.get('health', null, { 'X-App-Version': '0.0.1' });
  assert.equal(res.status, 200); // health is never blocked
  const a = await h.admin();
  h.expectErr(await h.api.get('shop', a.token, { 'X-App-Version': '0.0.1' }), 426, 'upgrade_required');
});
