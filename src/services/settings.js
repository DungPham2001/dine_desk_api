/** Shop profile and rules (spec 3.2, 3.3): one document each. */
const { Setting } = require('../models');
const config = require('../config');
const V = require('../lib/validate');
const { invalid } = require('../lib/errors');
const { isoLocal } = require('../lib/time');

const SHOP_DEFAULT = { name: '', description: '', phone: '', address: '', openText: '', representative: '', businessRegText: '', timezone: config.timezone };
const RULES_DEFAULT = { servicePct: 0, roundTo: 1000, seatMinutes: 90, holdMinutes: 15, longSitMinutes: 120, reminderLeadMin: 30 };

async function load() {
  const rows = await Setting.find({ _id: { $in: ['shop', 'rules'] } }).lean();
  const by = Object.fromEntries(rows.map((r) => [r._id, r.value]));
  return { shop: { ...SHOP_DEFAULT, ...(by.shop || {}) }, rules: { ...RULES_DEFAULT, ...(by.rules || {}) } };
}

/** Everything a request needs to format times and compute money. */
async function context() {
  const { shop, rules } = await load();
  const tz = shop.timezone || config.timezone;
  return { shop, rules, tz, now: new Date(), iso: (d) => isoLocal(d, tz) };
}

const getShop = async () => (await load()).shop;
const getRules = async () => (await load()).rules;

const validTz = (tz) => {
  try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch { return false; }
};

async function putShop(body) {
  const b = V.body(body);
  const cur = await getShop();
  const next = { ...cur };
  for (const [k, max] of [['name', 120], ['description', 1000], ['phone', 30], ['address', 300], ['openText', 200], ['representative', 120], ['businessRegText', 300]]) {
    if (V.has(b, k)) next[k] = V.str(b, k, { max });
  }
  if (V.has(b, 'timezone')) {
    const tz = V.str(b, 'timezone', { required: true, max: 60 });
    if (!validTz(tz)) throw invalid('timezone', 'invalid_enum');
    next.timezone = tz;
  }
  await Setting.updateOne({ _id: 'shop' }, { $set: { value: next, updatedAt: new Date() } }, { upsert: true });
  return next;
}

async function putRules(body) {
  const b = V.body(body);
  const cur = await getRules();
  const next = {
    servicePct: V.int(b, 'servicePct', { min: 0, max: 30, def: cur.servicePct }),
    roundTo: V.int(b, 'roundTo', { min: 1, max: 1_000_000, def: cur.roundTo }),
    seatMinutes: V.int(b, 'seatMinutes', { min: 10, max: 1440, def: cur.seatMinutes }),
    holdMinutes: V.int(b, 'holdMinutes', { min: 0, max: 240, def: cur.holdMinutes }),
    longSitMinutes: V.int(b, 'longSitMinutes', { min: 10, max: 1440, def: cur.longSitMinutes }),
    reminderLeadMin: V.int(b, 'reminderLeadMin', { min: 0, max: 1440, def: cur.reminderLeadMin }),
  };
  await Setting.updateOne({ _id: 'rules' }, { $set: { value: next, updatedAt: new Date() } }, { upsert: true });
  return next;
}

module.exports = { context, getShop, getRules, putShop, putRules, SHOP_DEFAULT, RULES_DEFAULT };
