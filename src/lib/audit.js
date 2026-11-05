const prisma = require('./prisma');

const IGNORED_FIELDS = new Set(['updatedAt', 'createdAt', 'passwordHash']);

function plain(obj) {
  if (obj === null || obj === undefined) return obj;
  const copy = JSON.parse(JSON.stringify(obj));
  if (copy && typeof copy === 'object' && !Array.isArray(copy)) delete copy.passwordHash;
  return copy;
}

function diff(before, after) {
  const b = plain(before) || {};
  const a = plain(after) || {};
  const changes = {};
  const keys = new Set([...Object.keys(b), ...Object.keys(a)]);
  for (const key of keys) {
    if (IGNORED_FIELDS.has(key)) continue;
    if (JSON.stringify(b[key]) !== JSON.stringify(a[key])) {
      changes[key] = { antes: b[key] ?? null, despues: a[key] ?? null };
    }
  }
  return changes;
}

/**
 * Registra una entrada en el historial de modificaciones (quién, qué, cuándo).
 * @param {object} client  prisma o cliente de transacción
 * @param {object} user    usuario que realiza la acción
 * @param {object} entry   { action, entity, entityId, summary, before, after, changes }
 */
async function logAudit(client, user, { action, entity, entityId, summary, before, after, changes }) {
  let data = changes;
  if (!data) {
    if (before && after) data = diff(before, after);
    else if (after) data = { creado: plain(after) };
    else if (before) data = { eliminado: plain(before) };
  }

  await (client || prisma).auditLog.create({
    data: {
      businessId: user.businessId,
      userId: user.id,
      userName: user.name,
      userRole: user.role,
      action,
      entity,
      entityId: entityId ? String(entityId) : null,
      summary,
      changes: data && Object.keys(data).length ? data : undefined,
    },
  });
}

module.exports = { logAudit, diff, plain };
