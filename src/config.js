require('dotenv').config();

const num = (v, d) => (v === undefined || v === '' || !Number.isFinite(Number(v)) ? d : Number(v));
const env = process.env.NODE_ENV || 'development';

const jwtSecret = process.env.JWT_SECRET || (env === 'production' ? '' : 'dinedesk-dev-only-secret-do-not-use-in-production');
if (!jwtSecret || (env === 'production' && jwtSecret.length < 32)) {
  throw new Error('JWT_SECRET (>= 32 chars) is required in production');
}

module.exports = {
  env,
  isTest: env === 'test',
  port: num(process.env.PORT, 4000),
  mongoUri: process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/dinedesk',
  corsOrigins: (process.env.CORS_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),
  /** Fallback timezone; the restaurant has its own `shop.timezone`. */
  timezone: process.env.TIMEZONE || 'Asia/Ho_Chi_Minh',
  publicBaseUrl: (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, ''),

  apiVersion: '1.0.0',
  minAppVersion: process.env.MIN_APP_VERSION || '1.0.0',
  latestAppVersion: process.env.LATEST_APP_VERSION || process.env.MIN_APP_VERSION || '1.0.0',

  /**
   * Open question 1 of the spec: with one restaurant shared by all admins, public sign-up would let anyone become an
   * admin. Default (a): register works only while there is no admin (first bootstrap); afterwards admins are added
   * with POST /admins. REGISTRATION_OPEN=true reopens it (review environments only).
   */
  registrationOpen: process.env.REGISTRATION_OPEN === 'true',

  jwt: { secret: jwtSecret, issuer: 'dinedesk-api', audience: 'dinedesk-app' },
  session: {
    accessTtlSec: num(process.env.ACCESS_TOKEN_MINUTES, 120) * 60, // 2 h (spec 4.1)
    refreshIdleSec: num(process.env.REFRESH_IDLE_MINUTES, 180) * 60, // sliding 3 h
    maxAgeSec: num(process.env.SESSION_MAX_HOURS, 24) * 3600, // absolute
    maxPerAccount: num(process.env.MAX_SESSIONS_PER_ACCOUNT, 10),
  },
  bcryptRounds: env === 'test' ? 4 : 10,
  resetCodeSec: num(process.env.RESET_CODE_MINUTES, 30) * 60,

  smtp: {
    host: env === 'test' ? '' : process.env.SMTP_HOST || '',
    port: num(process.env.SMTP_PORT, 587),
    secure: process.env.SMTP_SECURE === 'true',
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.SMTP_FROM || 'DineDesk <no-reply@example.com>',
  },

  rate: {
    enabled: process.env.RATE_LIMIT !== 'off' && env !== 'test',
    readPerMin: num(process.env.RATE_READ_PER_MIN, 600), // kitchen polls every 30 s from several devices
    writePerMin: num(process.env.RATE_WRITE_PER_MIN, 180),
    authPerMin: num(process.env.RATE_AUTH_PER_MIN, 10),
    registerPerHour: num(process.env.RATE_REGISTER_PER_HOUR, 5),
    banAfterViolations: num(process.env.RATE_BAN_AFTER, 30),
    banMinutes: num(process.env.RATE_BAN_MINUTES, 15),
  },
  // spec 1.8: 5 failures / 15 min / email -> 429
  login: { maxFailures: num(process.env.LOGIN_MAX_FAILURES, 5), lockSec: num(process.env.LOGIN_LOCK_MINUTES, 15) * 60 },
};
