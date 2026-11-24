/** Generic CRUD for the simple catalogs: parse -> write -> present. `updatedSince` supports light syncing (spec 1.4). */
const { uuid } = require('../lib/util');
const { notFound, invalid, conflict } = require('../lib/errors');
const V = require('../lib/validate');

function crud(Model, { parse, present, presentMany, filter, beforeDelete, afterWrite, sort = { createdAt: 1, _id: 1 } }) {
  const many = presentMany || (async (rows, ctx) => rows.map((r) => present(r, ctx)));
  const one = async (row, ctx) => (await many([row], ctx))[0];

  return {
    async list(q, ctx) {
      const f = filter ? await filter(q, ctx) : {};
      if (q.updatedSince) {
        const d = new Date(q.updatedSince);
        if (Number.isNaN(d.getTime())) throw invalid('updatedSince', 'invalid_format');
        f.updatedAt = { $gt: d };
      }
      const rows = await Model.find(f).sort(sort).lean();
      return { items: await many(rows, ctx) };
    },
    async create(body, ctx, auth) {
      const b = V.body(body);
      const fields = await parse(b, true, null);
      const now = new Date();
      // The app may send its own id (offline-safe creates, stable references between new records)
      const given = typeof b.id === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(b.id) ? b.id : null;
      if (given && (await Model.exists({ _id: given }))) throw conflict('duplicate', { field: 'id' });
      const doc = { _id: given || uuid(), ...fields, createdAt: now, updatedAt: now };
      await Model.create(doc);
      if (afterWrite) await afterWrite(doc, null, auth);
      return one(doc, ctx);
    },
    async get(id, ctx) {
      const row = await Model.findById(id).lean();
      if (!row) throw notFound();
      return one(row, ctx);
    },
    async patch(id, body, ctx, auth) {
      const cur = await Model.findById(id).lean();
      if (!cur) throw notFound();
      const fields = await parse(V.body(body), false, cur);
      await Model.updateOne({ _id: id }, { $set: { ...fields, updatedAt: new Date() } });
      const row = await Model.findById(id).lean();
      if (afterWrite) await afterWrite(row, cur, auth);
      return one(row, ctx);
    },
    async remove(id, auth) {
      const cur = await Model.findById(id).lean();
      if (!cur) throw notFound();
      if (beforeDelete) await beforeDelete(cur, auth);
      await Model.deleteOne({ _id: id });
    },
  };
}

/** Picks only the keys present in the body (PATCH) or all of them (create). */
function pick(b, create, readers) {
  const out = {};
  for (const [key, read] of Object.entries(readers)) if (create || V.has(b, key)) out[key] = read(b, create);
  return out;
}

module.exports = { crud, pick };
