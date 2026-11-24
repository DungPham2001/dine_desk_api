/** AdminAction journal (spec 3.13): only the server writes here. Never put allergy, phone, passwords or tokens in `note`. */
const { AdminAction } = require('../models');
const { uuid } = require('../lib/util');

/** `auth` = req.auth or { accountId, name }. */
async function log(auth, action, targetType, targetId, note = '', opts = {}) {
  await AdminAction.create([{
    _id: uuid(), adminId: auth?.accountId || null, adminName: auth?.name || 'system', action, targetType, targetId: targetId || null, note: String(note || '').slice(0, 300), at: new Date(),
  }], opts.session ? { session: opts.session } : undefined);
}

module.exports = { log };
