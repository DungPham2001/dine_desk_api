/** Cursor pagination (spec 1.4): `{ items, nextCursor }`, newest first on `field`, ties broken by _id. */
const { invalid } = require('./errors');

const encode = (v, id) => Buffer.from(JSON.stringify([v instanceof Date ? v.toISOString() : v, id])).toString('base64url');
function decode(cursor, isDate) {
  try {
    const [v, id] = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'));
    return [isDate ? new Date(v) : v, String(id)];
  } catch {
    throw invalid('cursor', 'invalid_format');
  }
}

const limitOf = (q) => {
  const n = Number.parseInt(q.limit, 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 200) : 50;
};

/** `dir` -1 = newest first (default), 1 = oldest first. */
async function paginate(Model, filter, query, { field = 'createdAt', dir = -1, isDate = true, present = (x) => x, select } = {}) {
  const limit = limitOf(query);
  const f = { ...filter };
  if (query.cursor) {
    const [v, id] = decode(query.cursor, isDate);
    const op = dir === -1 ? '$lt' : '$gt';
    const cond = { $or: [{ [field]: { [op]: v } }, { [field]: v, _id: { [op]: id } }] };
    f.$and = [...(f.$and || []), cond];
  }
  let q = Model.find(f).sort({ [field]: dir, _id: dir }).limit(limit + 1);
  if (select) q = q.select(select);
  const rows = await q.lean();
  const more = rows.length > limit;
  const page = more ? rows.slice(0, limit) : rows;
  const items = await present(page);
  return { items, nextCursor: more ? encode(page[page.length - 1][field], page[page.length - 1]._id) : null };
}

module.exports = { paginate, limitOf };
