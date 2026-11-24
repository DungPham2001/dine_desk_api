/** Small input readers: each throws 400 validation_failed { field, reason } on the first problem. */
const { invalid } = require('./errors');
const { isDate } = require('./time');

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const body = (b) => (isObj(b) ? b : {});
const has = (o, k) => o[k] !== undefined;

function str(o, k, { required = false, max = 200, def } = {}) {
  const v = o[k];
  if (v === undefined || v === null || (typeof v === 'string' && !v.trim())) {
    if (required) throw invalid(k, 'required');
    return def !== undefined ? def : '';
  }
  if (typeof v !== 'string') throw invalid(k, 'invalid_type');
  const s = v.trim();
  if (s.length > max) throw invalid(k, 'too_long');
  return s;
}

function int(o, k, { required = false, min = 0, max = 1e12, def } = {}) {
  const v = o[k];
  if (v === undefined || v === null || v === '') {
    if (required) throw invalid(k, 'required');
    return def;
  }
  if (typeof v !== 'number' || !Number.isInteger(v)) throw invalid(k, 'invalid_type');
  if (v < min) throw invalid(k, `min_${min}`);
  if (v > max) throw invalid(k, `max_${max}`);
  return v;
}

function num(o, k, { required = false, min = 0, max = 1e12, def } = {}) {
  const v = o[k];
  if (v === undefined || v === null || v === '') {
    if (required) throw invalid(k, 'required');
    return def;
  }
  if (typeof v !== 'number' || !Number.isFinite(v)) throw invalid(k, 'invalid_type');
  if (v < min) throw invalid(k, `min_${min}`);
  if (v > max) throw invalid(k, `max_${max}`);
  return v;
}

function bool(o, k, { def } = {}) {
  const v = o[k];
  if (v === undefined || v === null) return def;
  if (typeof v !== 'boolean') throw invalid(k, 'invalid_type');
  return v;
}

function oneOf(o, k, values, { required = false, def } = {}) {
  const v = o[k];
  if (v === undefined || v === null || v === '') {
    if (required) throw invalid(k, 'required');
    return def;
  }
  if (!values.includes(v)) throw invalid(k, 'invalid_enum');
  return v;
}

function date(o, k, { required = false, def } = {}) {
  const v = o[k];
  if (v === undefined || v === null || v === '') {
    if (required) throw invalid(k, 'required');
    return v === null ? null : def;
  }
  if (typeof v !== 'string' || !isDate(v)) throw invalid(k, 'invalid_format');
  return v;
}

function datetime(o, k, { required = false, def } = {}) {
  const v = o[k];
  if (v === undefined || v === null || v === '') {
    if (required) throw invalid(k, 'required');
    return v === null ? null : def;
  }
  const d = typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v) ? new Date(v) : null;
  if (!d || Number.isNaN(d.getTime())) throw invalid(k, 'invalid_format');
  return d;
}

function email(o, k = 'email') {
  const v = typeof o[k] === 'string' ? o[k].trim().toLowerCase() : '';
  if (!v) throw invalid(k, 'required');
  if (v.length > 254 || !EMAIL.test(v)) throw invalid(k, 'invalid_format');
  return v;
}

/** 8..72 bytes (bcrypt), with upper-case, lower-case and a digit. */
function password(o, k) {
  const v = o[k];
  if (typeof v !== 'string' || !v) throw invalid(k, 'required');
  if (Buffer.byteLength(v, 'utf8') > 72 || v.length < 8 || !/\p{Lu}/u.test(v) || !/\p{Ll}/u.test(v) || !/\d/.test(v)) throw invalid(k, 'weak_password');
  return v;
}

function arr(o, k, { max = 500 } = {}) {
  const v = o[k];
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v)) throw invalid(k, 'invalid_type');
  if (v.length > max) throw invalid(k, 'too_long');
  return v;
}

const reason = (o, k = 'reason') => str(o, k, { max: 300 });

module.exports = { isObj, body, has, str, int, num, bool, oneOf, date, datetime, email, password, arr, reason };
