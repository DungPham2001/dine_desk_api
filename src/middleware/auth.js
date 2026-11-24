/**
 * Identity comes only from the access token. The session and the account are re-read on every request, so logout,
 * password reset and revoked admins take effect immediately. Every admin has the same rights.
 *
 * - expired access token             -> 401 token_expired (the app refreshes once)
 * - session revoked / unknown        -> 401 unauthorized
 * - mustChangePassword = true        -> 403 password_change_required (except change-password, logout, GET /me)
 */
const { Account, Session } = require('../models');
const { verifyAccess } = require('../services/tokens');
const { asyncHandler, unauthorized, forbidden } = require('../lib/errors');

const TOUCH_MS = 5 * 60 * 1000;

async function resolve(req) {
  const m = /^Bearer\s+(\S+)$/i.exec(req.get('authorization') || '');
  if (!m) throw unauthorized('unauthorized');
  const claims = verifyAccess(m[1]);
  const [session, account] = await Promise.all([Session.findById(claims.sid).lean(), Account.findById(claims.sub).lean()]);
  if (!account || !session || session.accountId !== claims.sub) throw unauthorized('unauthorized');
  if (session.revokedAt || session.absoluteExpiresAt <= new Date()) throw unauthorized('unauthorized');
  if (Date.now() - new Date(session.lastSeenAt).getTime() > TOUCH_MS) {
    Session.updateOne({ _id: session._id }, { $set: { lastSeenAt: new Date() } }).catch(() => {});
  }
  return { accountId: account._id, account, sessionId: session._id, name: account.name };
}

/** Normal endpoints. */
const authenticate = asyncHandler(async (req, _res, next) => {
  req.auth = await resolve(req);
  if (req.auth.account.mustChangePassword) throw forbidden('password_change_required');
  next();
});

/** change-password, logout, GET /me: allowed while the temporary password is still in place. */
const authenticateLoose = asyncHandler(async (req, _res, next) => {
  req.auth = await resolve(req);
  next();
});

module.exports = { authenticate, authenticateLoose, resolve };
