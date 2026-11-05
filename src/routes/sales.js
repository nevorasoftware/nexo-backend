const router = require('express').Router();
const prisma = require('../lib/prisma');
const { HttpError, int } = require('../lib/http');
const { logAudit } = require('../lib/audit');
const { requireRole } = require('../middleware/auth');
const { createSale } = require('../services/saleService');

const include = {
  items: true,
  user: { select: { id: true, name: true, avatarColor: true } },
  order: { select: { id: true, code: true } },
};

function parseDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function buildWhere(req) {
  const where = { businessId: req.user.businessId };
  const from = parseDate(req.query.from);
  const to = parseDate(req.query.to);
  if (from || to) {
    where.createdAt = {};
    if (from) where.createdAt.gte = from;
    if (to) where.createdAt.lt = to;
  }
  if (req.user.role === 'SELLER') where.userId = req.user.id;
  else if (req.query.userId) where.userId = String(req.query.userId);
  return where;
}

router.get('/', async (req, res) => {
  const where = buildWhere(req);
  const limit = Math.min(500, Math.max(1, int(req.query.limit, 200)));
  const [sales, agg] = await Promise.all([
    prisma.sale.findMany({ where, include, orderBy: { createdAt: 'desc' }, take: limit }),
    prisma.sale.aggregate({ where, _sum: { total: true, cost: true, profit: true }, _count: { _all: true } }),
  ]);
  res.json({
    sales,
    summary: {
      count: agg._count._all,
      total: Number(agg._sum.total || 0),
      cost: Number(agg._sum.cost || 0),
      profit: Number(agg._sum.profit || 0),
    },
  });
});

router.get('/:id', async (req, res) => {
  const where = { id: req.params.id, businessId: req.user.businessId };
  if (req.user.role === 'SELLER') where.userId = req.user.id;
  const sale = await prisma.sale.findFirst({ where, include });
  if (!sale) throw new HttpError(404, 'Venta no encontrada');
  res.json(sale);
});

router.post('/', requireRole('OWNER', 'EMPLOYEE'), async (req, res) => {
  const body = req.body || {};
  const sale = await prisma.$transaction(async (tx) => {
    const created = await createSale(tx, {
      businessId: req.user.businessId,
      userId: req.user.id,
      clientName: body.clientName,
      paymentMethod: body.paymentMethod,
      notes: body.notes,
      items: body.items,
    });
    await logAudit(tx, req.user, {
      action: 'CREATE',
      entity: 'Sale',
      entityId: created.id,
      summary: `Venta registrada por ${Number(created.total).toFixed(2)} (ganancia ${Number(created.profit).toFixed(2)})`,
      after: created,
    });
    return created;
  });
  res.status(201).json(sale);
});

// Anular venta: devuelve el stock de los productos
router.delete('/:id', requireRole('OWNER'), async (req, res) => {
  const sale = await prisma.sale.findFirst({
    where: { id: req.params.id, businessId: req.user.businessId },
    include,
  });
  if (!sale) throw new HttpError(404, 'Venta no encontrada');

  await prisma.$transaction(async (tx) => {
    for (const item of sale.items) {
      if (item.variantId) {
        await tx.productVariant.update({ where: { id: item.variantId }, data: { stock: { increment: item.quantity } } });
      }
    }
    await tx.sale.delete({ where: { id: sale.id } });
    await logAudit(tx, req.user, {
      action: 'DELETE',
      entity: 'Sale',
      entityId: sale.id,
      summary: `Venta por ${Number(sale.total).toFixed(2)} anulada (stock devuelto)`,
      before: sale,
    });
  });
  res.json({ ok: true });
});

module.exports = router;
