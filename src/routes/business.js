const router = require('express').Router();
const prisma = require('../lib/prisma');
const { HttpError, str } = require('../lib/http');
const { logAudit } = require('../lib/audit');
const { requireRole } = require('../middleware/auth');

router.get('/', async (req, res) => {
  const business = await prisma.business.findUnique({ where: { id: req.user.businessId } });
  res.json(business);
});

router.put('/', requireRole('OWNER'), async (req, res) => {
  const body = req.body || {};
  const before = await prisma.business.findUnique({ where: { id: req.user.businessId } });

  const data = {};
  for (const field of ['name', 'phone', 'address', 'logoUrl']) {
    if (body[field] !== undefined) data[field] = str(body[field]);
  }
  if (data.name === null) throw new HttpError(400, 'El nombre del negocio es requerido');
  if (body.currency !== undefined) {
    const currency = (str(body.currency) || '').toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) throw new HttpError(400, 'La moneda debe ser un código de 3 letras (ej. USD, MXN, COP)');
    data.currency = currency;
  }

  const business = await prisma.business.update({ where: { id: before.id }, data });
  await logAudit(prisma, req.user, {
    action: 'UPDATE',
    entity: 'Business',
    entityId: business.id,
    summary: `Datos del negocio actualizados`,
    before,
    after: business,
  });
  res.json(business);
});

module.exports = router;
