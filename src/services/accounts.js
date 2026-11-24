/**
 * Accounts, sessions, password flows and admins (spec 4.1, 4.2). One role: admin; all admins are equal.
 * Forgot / reset password works like the sibling apps: a one-time code is e-mailed (30 min), reset signs out every device.
 */
const { Account, Session, PasswordReset, Setting } = require('../models');
const config = require('../config');
const { AppError, unauthorized, forbidden, conflict, notFound, business, invalid } = require('../lib/errors');
const { uuid, sha256, humanCode, normalizeCode } = require('../lib/util');
const V = require('../lib/validate');
const password = require('../lib/password');
const attempts = require('../lib/attempts');
const mailer = require('../lib/mailer');
const tokens = require('./tokens');
const audit = require('./audit');

const LANGS = ['vi', 'en'];

const present = (a) => ({
  id: a._id, email: a.email, name: a.name, phone: a.phone || '', language: a.language, mustChangePassword: !!a.mustChangePassword,
  createdAt: new Date(a.createdAt).toISOString(), updatedAt: new Date(a.updatedAt).toISOString(),
});
const loadAccount = (id) => Account.findById(id).lean();

async function authResponse(account) {
  const t = await tokens.openSession(account);
  return { ...t, mustChangePassword: !!account.mustChangePassword, account: present(account) };
}

async function createAccount({ email, name, plain, phone = '', language = 'vi', mustChange = false }) {
  const now = new Date();
  const doc = {
    _id: uuid(), email, passwordHash: await password.hash(plain), name, phone, language: LANGS.includes(language) ? language : 'vi',
    mustChangePassword: mustChange, passwordChangedAt: now, createdAt: now, updatedAt: now,
  };
  try {
    await Account.create(doc);
  } catch (err) {
    if (err.code === 11000) throw conflict('email_taken');
    throw err;
  }
  return doc;
}

// ---------- register / login ----------

/** POST /auth/register. Open question 1: only while the system has no admin (REGISTRATION_OPEN=true reopens it). */
async function register(body, { lang }) {
  const b = V.body(body);
  const mail = V.email(b);
  const name = V.str(b, 'name', { required: true, max: 100 });
  const plain = V.password(b, 'password');
  let locked = false;
  if (!config.registrationOpen) {
    if (await Account.estimatedDocumentCount() > 0) throw forbidden('registration_closed');
    try {
      await Setting.create({ _id: 'bootstrap', value: { at: new Date() } }); // one winner when two sign-ups race
      locked = true;
    } catch (err) {
      if (err.code === 11000) throw forbidden('registration_closed');
      throw err;
    }
  } else if (await Account.exists({ email: mail })) throw conflict('email_taken');
  try {
    const doc = await createAccount({ email: mail, name, plain, language: lang });
    return await authResponse(doc);
  } catch (err) {
    if (locked) await Setting.deleteOne({ _id: 'bootstrap' });
    throw err;
  }
}

async function checkCredentials(mail, plain) {
  const account = await Account.findOne({ email: mail }).lean();
  const lockKey = account ? account._id : `login:${mail}`;
  await attempts.assertNotLocked('login', lockKey);
  if (!(await password.verify(plain, account?.passwordHash))) {
    await attempts.recordFailure('login', lockKey);
    throw unauthorized('invalid_credentials');
  }
  await attempts.clearFailures('login', lockKey);
  return account;
}

async function login(body) {
  const b = V.body(body);
  const mail = V.email(b);
  if (typeof b.password !== 'string' || !b.password) throw invalid('password', 'required');
  const account = await checkCredentials(mail, b.password);
  Account.updateOne({ _id: account._id }, { $set: { lastLoginAt: new Date() } }).catch(() => {});
  return authResponse(account);
}

async function refresh(body) {
  const { account, tokens: t } = await tokens.refresh(V.body(body).refreshToken, loadAccount);
  return { ...t, mustChangePassword: !!account.mustChangePassword, account: present(account) };
}

async function logout(body, auth) {
  const rt = typeof body?.refreshToken === 'string' ? body.refreshToken : '';
  if (rt.includes('.')) {
    const [sid] = rt.split('.');
    await Session.updateOne({ _id: sid, refreshHash: sha256(rt), revokedAt: null }, { $set: { revokedAt: new Date(), revokeReason: 'logout' } });
  }
  if (auth) await tokens.revoke({ _id: auth.sessionId, accountId: auth.accountId }, 'logout');
}

// ---------- forgot / reset / change ----------

/** POST /auth/forgot { email }: always the same answer, whether the email exists or not. */
async function forgot(body, { lang }) {
  const mail = V.email(V.body(body));
  const out = { status: 'accepted' };
  if ((await attempts.bump(`forgot|${sha256(mail)}`, 3600)) > 3) return out;
  const account = await Account.findOne({ email: mail }).lean();
  if (!account) return out;
  const code = humanCode(8);
  await PasswordReset.updateMany({ accountId: account._id, usedAt: null }, { $set: { usedAt: new Date() } });
  await PasswordReset.create({ _id: uuid(), accountId: account._id, codeHash: sha256(code), expiresAt: new Date(Date.now() + config.resetCodeSec * 1000) });
  const sent = await mailer.sendResetCode(account.email, code, lang || account.language, account.name);
  if (!sent && !mailer.enabled() && config.env !== 'production') out.devToken = mailer.pretty(code);
  return out;
}

/** POST /auth/reset { token, newPassword }: signs out every device and clears mustChangePassword. */
async function reset(body, { lang } = {}) {
  const b = V.body(body);
  const code = typeof b.token === 'string' ? b.token : '';
  if (!code) throw invalid('token', 'required');
  const plain = V.password({ newPassword: b.newPassword ?? b.password }, 'newPassword');
  const now = new Date();
  const r = await PasswordReset.findOneAndUpdate({ codeHash: sha256(normalizeCode(code)), usedAt: null, expiresAt: { $gt: now } }, { $set: { usedAt: now } }, { new: true }).lean();
  if (!r) throw new AppError(400, 'reset_invalid');
  const account = await Account.findOneAndUpdate({ _id: r.accountId }, { $set: { passwordHash: await password.hash(plain), mustChangePassword: false, passwordChangedAt: now, updatedAt: now } }, { new: true }).lean();
  await tokens.revoke({ accountId: r.accountId }, 'password_reset');
  if (account) {
    await Promise.all([attempts.clearFailures('login', account._id), attempts.clearFailures('confirm', account._id)]);
    await mailer.sendPasswordChanged(account, { via: 'reset', lang });
  }
}

/** Password re-check for sensitive actions: counts toward a lock. Wrong -> 422 wrong_password. */
async function confirmPassword(account, plain) {
  await attempts.assertNotLocked('confirm', account._id);
  if (typeof plain !== 'string' || !(await password.verify(plain, account.passwordHash))) {
    await attempts.recordFailure('confirm', account._id);
    throw business('wrong_password');
  }
  await attempts.clearFailures('confirm', account._id);
}

/** POST /auth/change-password { oldPassword, newPassword } -> 204. Other devices are signed out. */
async function changePassword(auth, body, { lang } = {}) {
  const b = V.body(body);
  if (typeof b.oldPassword !== 'string' || !b.oldPassword) throw invalid('oldPassword', 'required');
  const plain = V.password(b, 'newPassword');
  await confirmPassword(auth.account, b.oldPassword);
  if (b.oldPassword === plain) throw business('same_password');
  const now = new Date();
  await Account.updateOne({ _id: auth.accountId }, { $set: { passwordHash: await password.hash(plain), mustChangePassword: false, passwordChangedAt: now, updatedAt: now } });
  await tokens.revoke({ accountId: auth.accountId, _id: { $ne: auth.sessionId } }, 'password_changed');
  await mailer.sendPasswordChanged(auth.account, { via: 'change', lang });
}

// ---------- me ----------

async function updateMe(auth, body) {
  const b = V.body(body);
  const set = {};
  if (V.has(b, 'name')) set.name = V.str(b, 'name', { required: true, max: 100 });
  if (V.has(b, 'phone')) set.phone = V.str(b, 'phone', { max: 30 });
  if (V.has(b, 'language')) set.language = V.oneOf(b, 'language', LANGS, { required: true });
  set.updatedAt = new Date();
  await Account.updateOne({ _id: auth.accountId }, { $set: set });
  return present(await loadAccount(auth.accountId));
}

/** DELETE /me { password }: real deletion; the name stays only as text in old AdminAction / openedBy records. */
async function deleteAccount(auth, body) {
  await confirmPassword(auth.account, V.body(body).password);
  if ((await Account.countDocuments({ _id: { $ne: auth.accountId } })) === 0) throw conflict('last_admin');
  await audit.log(auth, 'account_deleted', 'account', auth.accountId, auth.account.email);
  await Session.deleteMany({ accountId: auth.accountId });
  await PasswordReset.deleteMany({ accountId: auth.accountId });
  await Account.deleteOne({ _id: auth.accountId });
}

/** Public web form: email + password. The last admin cannot be deleted (409 last_admin). */
async function deleteByCredentials(body) {
  const b = V.body(body);
  const mail = V.email(b);
  const account = await checkCredentials(mail, b.password);
  return deleteAccount({ accountId: account._id, account, name: account.name }, { password: b.password });
}

// ---------- admins ----------

async function listAdmins() {
  const rows = await Account.find({}).sort({ createdAt: 1 }).lean();
  return { items: rows.map((a) => ({ ...present(a), lastLoginAt: a.lastLoginAt ? new Date(a.lastLoginAt).toISOString() : null })) };
}

async function createAdmin(auth, body) {
  const b = V.body(body);
  const mail = V.email(b);
  const name = V.str(b, 'name', { required: true, max: 100 });
  const plain = V.password(b, 'tempPassword');
  if (await Account.exists({ email: mail })) throw conflict('email_taken');
  const doc = await createAccount({ email: mail, name, plain, mustChange: true });
  await audit.log(auth, 'admin_added', 'account', doc._id, mail);
  return present(doc);
}

async function targetAdmin(id) {
  const t = await Account.findById(id).lean();
  if (!t) throw notFound();
  return t;
}

async function resetAdminPassword(auth, id, body) {
  const target = await targetAdmin(id);
  const plain = V.password(V.body(body), 'tempPassword');
  const now = new Date();
  await Account.updateOne({ _id: id }, { $set: { passwordHash: await password.hash(plain), mustChangePassword: true, passwordChangedAt: now, updatedAt: now } });
  await tokens.revoke({ accountId: id }, 'password_reset');
  await Promise.all([attempts.clearFailures('login', id), attempts.clearFailures('confirm', id)]);
  await audit.log(auth, 'admin_password_reset', 'account', id, target.email);
  return present(await loadAccount(id));
}

async function revokeAdmin(auth, id) {
  const target = await targetAdmin(id);
  if ((await Account.countDocuments({ _id: { $ne: id } })) === 0) throw conflict('last_admin');
  if (target._id === auth.accountId) throw forbidden('forbidden');
  await audit.log(auth, 'admin_revoked', 'account', id, target.email);
  await Session.deleteMany({ accountId: id });
  await PasswordReset.deleteMany({ accountId: id });
  await Account.deleteOne({ _id: id });
}

module.exports = {
  present, register, login, refresh, logout, forgot, reset, changePassword, confirmPassword, updateMe, deleteAccount, deleteByCredentials,
  listAdmins, createAdmin, resetAdminPassword, revokeAdmin,
};
