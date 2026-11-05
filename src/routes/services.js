const router = require('express').Router();
const prisma = require('../lib/prisma');
const { HttpError, num, int, str, required } = require('../lib/http');
const { logAudit } = require('../lib/audit');
const { requireRole } = require('../middleware/auth');

function readService(body, partial = false) {
  const data = {};
  for (const field of ['name', 'description', 'category']) {
    if (!partial || body[field] !== undefined) data[field] = str(body[field]);
  }
  if (!partial || body.price !== undefined) data.price = num(body.price);
  if (!partial || body.cost !== undefined) data.cost = num(body.cost);
  if (!partial || body.durationMin !== undefined) data.durationMin = Math.max(0, int(body.durationMin, 60));
  if ('name' in data && !data.name) throw new HttpError(400, 'El nombre es requerido');
  if (data.price < 0 || data.cost < 0) throw new HttpError(400, 'Precio y costo no pueden ser negativos');
  return data;
}

async function findService(req) {
  const service = await prisma.service.findFirst({ where: { id: req.params.id, businessId: req.user.businessId } });
  if (!service) throw new HttpError(404, 'Servicio no encontrado');
  return service;
}

router.get('/', async (req, res) => {
  const q = str(req.query.q);
  const where = { businessId: req.user.businessId };
  if (req.query.all !== '1') where.active = true;
  if (q) {
    where.OR = [
      { name: { contains: q, mode: 'insensitive' } },
      { category: { contains: q, mode: 'insensitive' } },
    ];
  }
  res.json(await prisma.service.findMany({ where, orderBy: { name: 'asc' } }));
});

router.get('/:id', async (req, res) => {
  res.json(await findService(req));
});

router.post('/', requireRole('OWNER', 'EMPLOYEE'), async (req, res) => {
  const body = req.body || {};
  required(body, ['name', 'price']);
  const service = await prisma.service.create({
    data: { ...readService(body), businessId: req.user.businessId },
  });
  await logAudit(prisma, req.user, {
    action: 'CREATE',
    entity: 'Service',
    entityId: service.id,
    summary: `Servicio "${service.name}" creado`,
    after: service,
  });
  res.status(201).json(service);
});

router.put('/:id', requireRole('OWNER', 'EMPLOYEE'), async (req, res) => {
  const before = await findService(req);
  const service = await prisma.service.update({ where: { id: before.id }, data: readService(req.body || {}, true) });
  await logAudit(prisma, req.user, {
    action: 'UPDATE',
    entity: 'Service',
    entityId: service.id,
    summary: `Servicio "${service.name}" modificado`,
    before,
    after: service,
  });
  res.json(service);
});

router.delete('/:id', requireRole('OWNER'), async (req, res) => {
  const before = await findService(req);
  await prisma.service.update({ where: { id: before.id }, data: { active: false } });
  await logAudit(prisma, req.user, {
    action: 'DELETE',
    entity: 'Service',
    entityId: before.id,
    summary: `Servicio "${before.name}" eliminado`,
    before,
  });
  res.json({ ok: true });
});

module.exports = router;
