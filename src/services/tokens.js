/**
 * Sessions and tokens (spec 4.1).
 * - access token: JWT HS256, 2 h, claims sub (account), sid (session). Never trusted alone: every request re-reads
 *   the session and the account, so logout, revoke and password reset take effect at once.
 * - refresh token: "<sessionId>.<random>", only its sha256 is stored, rotated on every use (reuse revokes the session).
 *   Sliding idle window (3 h), absolute cap (24 h): the app drops its session after ~1 h in background anyway.
 */
const jwt = require('jsonwebtoken');
const config = require('../config');
const { Session } = require('../models');
const { uuid, sha256, randomToken } = require('../lib/util');
const { unauthorized } = require('../lib/errors');

const S = config.session;

function signAccess(account, session) {
  const now = Math.floor(Date.now() / 1000);
  const exp = Math.min(now + S.accessTtlSec, Math.floor(session.absoluteExpiresAt.getTime() / 1000));
  const token = jwt.sign(
    { sub: account._id, sid: session._id, iat: now, exp },
    config.jwt.secret,
    { algorithm: 'HS256', issuer: config.jwt.issuer, audience: config.jwt.audience },
  );
  return { token, ttl: exp - now };
}

const bundle = (account, session, refreshToken) => {
  const access = signAccess(account, session);
  return { accessToken: access.token, refreshToken, expiresIn: Math.max(0, access.ttl) };
};

const newRefresh = (sessionId) => `${sessionId}.${randomToken(32)}`;
const idleUntil = (absolute) => new Date(Math.min(Date.now() + S.refreshIdleSec * 1000, absolute.getTime()));

async function openSession(account) {
  const now = new Date();
  const _id = uuid();
  const refreshToken = newRefresh(_id);
  const absoluteExpiresAt = new Date(now.getTime() + S.maxAgeSec * 1000);
  const session = await Session.create({
    _id,
    accountId: account._id,
    refreshHash: sha256(refreshToken),
    refreshExpiresAt: idleUntil(absoluteExpiresAt),
    absoluteExpiresAt,
    createdAt: now,
    lastSeenAt: now,
    expireAt: new Date(absoluteExpiresAt.getTime() + 7 * 86400000),
  });
  const active = await Session.find({ accountId: account._id, revokedAt: null, absoluteExpiresAt: { $gt: now } }).sort({ lastSeenAt: -1 }).select('_id').lean();
  const extra = active.slice(S.maxPerAccount).map((x) => x._id);
  if (extra.length) await Session.updateMany({ _id: { $in: extra } }, { $set: { revokedAt: now, revokeReason: 'too_many_sessions' } });
  return bundle(account, session.toObject(), refreshToken);
}

/** Exchanges a refresh token for a new pair (rotation + reuse detection). Returns { tokens, accountId }. */
async function refresh(refreshToken, loadAccount) {
  const raw = typeof refreshToken === 'string' ? refreshToken : '';
  const sessionId = raw.split('.')[0];
  if (!sessionId || !raw.includes('.')) throw unauthorized('unauthorized');
  const hash = sha256(raw);
  const now = new Date();

  const session = await Session.findById(sessionId).lean();
  if (!session || session.revokedAt) throw unauthorized('unauthorized');
  if (session.prevRefreshHash && hash === session.prevRefreshHash) {
    await Session.updateOne({ _id: sessionId }, { $set: { revokedAt: now, revokeReason: 'refresh_reused' } });
    throw unauthorized('unauthorized');
  }
  if (hash !== session.refreshHash) throw unauthorized('unauthorized');
  if (session.absoluteExpiresAt <= now || session.refreshExpiresAt <= now) {
    await Session.updateOne({ _id: sessionId }, { $set: { revokedAt: now, revokeReason: 'expired' } });
    throw unauthorized('unauthorized');
  }
  const account = await loadAccount(session.accountId);
  if (!account) throw unauthorized('unauthorized');

  const next = newRefresh(sessionId);
  const updated = await Session.findOneAndUpdate(
    { _id: sessionId, refreshHash: hash, revokedAt: null },
    { $set: { refreshHash: sha256(next), prevRefreshHash: hash, refreshExpiresAt: idleUntil(session.absoluteExpiresAt), lastSeenAt: now } },
    { new: true },
  ).lean();
  if (!updated) {
    await Session.updateOne({ _id: sessionId }, { $set: { revokedAt: now, revokeReason: 'refresh_reused' } });
    throw unauthorized('unauthorized');
  }
  return { account, tokens: bundle(account, updated, next) };
}

/** An expired access token answers `token_expired` (the app refreshes once); anything else invalid is `unauthorized`. */
function verifyAccess(token) {
  try {
    return jwt.verify(token, config.jwt.secret, { algorithms: ['HS256'], issuer: config.jwt.issuer, audience: config.jwt.audience });
  } catch (err) {
    throw unauthorized(err?.name === 'TokenExpiredError' ? 'token_expired' : 'unauthorized');
  }
}

const revoke = (filter, reason) => Session.updateMany({ ...filter, revokedAt: null }, { $set: { revokedAt: new Date(), revokeReason: reason } });

module.exports = { openSession, refresh, verifyAccess, revoke };
