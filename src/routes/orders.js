const router = require('express').Router();
const prisma = require('../lib/prisma');
const { HttpError, str, required, round2 } = require('../lib/http');
const { logAudit } = require('../lib/audit');
const { buildItems, createSale } = require('../services/saleService');

/**
 * Flujo de Vendedores Digitales:
 *   Vendedor crea pedido (PENDING) -> Casa Matriz lo recibe (AT_HQ) -> se entrega al Cliente Final (COMPLETED)
 *   Al completarse se genera automáticamente la venta y se descuenta el inventario.
 */
const STATUS_LABEL = { PENDING: 'Pendiente', AT_HQ: 'En Matriz', COMPLETED: 'Completado', CANCELLED: 'Cancelado' };
const TRANSITIONS = {
  PENDING: ['AT_HQ', 'CANCELLED'],
  AT_HQ: ['COMPLETED', 'CANCELLED'],
  COMPLETED: [],
  CANCELLED: [],
};

const include = {
  items: true,
  seller: { select: { id: true, name: true, avatarColor: true, phone: true } },
  sale: { select: { id: true, total: true, profit: true, createdAt: true } },
};

async function findOrder(req) {
  const where = { id: req.params.id, businessId: req.user.businessId };
  if (req.user.role === 'SELLER') where.sellerId = req.user.id;
  const order = await prisma.order.findFirst({ where, include });
  if (!order) throw new HttpError(404, 'Pedido no encontrado');
  return order;
}

function generateCode() {
  const rand = Math.random().toString(36).slice(2, 5).toUpperCase();
  return `PED-${Date.now().toString(36).toUpperCase()}${rand}`;
}

router.get('/', async (req, res) => {
  const where = { businessId: req.user.businessId };
  if (req.user.role === 'SELLER') where.sellerId = req.user.id;
  else if (req.query.sellerId) where.sellerId = String(req.query.sellerId);
  if (req.query.status && STATUS_LABEL[req.query.status]) where.status = req.query.status;

  const [orders, grouped] = await Promise.all([
    prisma.order.findMany({ where, include, orderBy: { createdAt: 'desc' }, take: 300 }),
    prisma.order.groupBy({
      by: ['status'],
      where: { businessId: where.businessId, ...(where.sellerId ? { sellerId: where.sellerId } : {}) },
      _count: { _all: true },
    }),
  ]);

  const counts = { PENDING: 0, AT_HQ: 0, COMPLETED: 0, CANCELLED: 0 };
  for (const g of grouped) counts[g.status] = g._count._all;
  res.json({ orders, counts });
});

router.get('/:id', async (req, res) => {
  const order = await findOrder(req);
  const history = await prisma.auditLog.findMany({
    where: { businessId: req.user.businessId, entity: 'Order', entityId: order.id },
    orderBy: { createdAt: 'asc' },
  });
  res.json({ ...order, history });
});

router.post('/', async (req, res) => {
  const body = req.body || {};
  required(body, ['customerName']);

  const order = await prisma.$transaction(async (tx) => {
    const items = await buildItems(tx, req.user.businessId, body.items, { allowCustom: false, allowPriceOverride: false });
    const total = round2(items.reduce((acc, i) => acc + i.subtotal, 0));
    const created = await tx.order.create({
      data: {
        businessId: req.user.businessId,
        sellerId: req.user.id,
        code: generateCode(),
        customerName: str(body.customerName),
        customerPhone: str(body.customerPhone),
        customerAddress: str(body.customerAddress),
        notes: str(body.notes),
        total,
        items: {
          create: items.map((i) => ({
            type: i.type,
            variantId: i.variantId,
            serviceId: i.serviceId,
            name: i.name,
            quantity: i.quantity,
            unitPrice: i.unitPrice,
            subtotal: i.subtotal,
          })),
        },
      },
      include,
    });
    await logAudit(tx, req.user, {
      action: 'CREATE',
      entity: 'Order',
      entityId: created.id,
      summary: `Pedido ${created.code} creado para ${created.customerName} (${STATUS_LABEL.PENDING})`,
      after: created,
    });
    return created;
  });

  res.status(201).json(order);
});

// Editar datos del cliente / notas mientras el pedido está pendiente
router.put('/:id', async (req, res) => {
  const body = req.body || {};
  const before = await findOrder(req);
  if (before.status !== 'PENDING') throw new HttpError(400, 'Solo se pueden editar pedidos pendientes');

  const data = {};
  for (const field of ['customerName', 'customerPhone', 'customerAddress', 'notes']) {
    if (body[field] !== undefined) data[field] = str(body[field]);
  }
  if (data.customerName === null) throw new HttpError(400, 'El nombre del cliente es requerido');

  const order = await prisma.order.update({ where: { id: before.id }, data, include });
  await logAudit(prisma, req.user, {
    action: 'UPDATE',
    entity: 'Order',
    entityId: order.id,
    summary: `Pedido ${order.code} modificado`,
    before,
    after: order,
  });
  res.json(order);
});

router.patch('/:id/status', async (req, res) => {
  const body = req.body || {};
  const status = String(body.status || '');
  const order = await findOrder(req);

  if (!STATUS_LABEL[status]) throw new HttpError(400, 'Estado inválido');
  if (!TRANSITIONS[order.status].includes(status)) {
    throw new HttpError(400, `No se puede pasar de "${STATUS_LABEL[order.status]}" a "${STATUS_LABEL[status]}"`);
  }
  // El vendedor solo puede cancelar sus pedidos pendientes; la Casa Matriz gestiona el resto
  if (req.user.role === 'SELLER' && !(order.status === 'PENDING' && status === 'CANCELLED')) {
    throw new HttpError(403, 'Solo la Casa Matriz puede avanzar el estado del pedido');
  }

  const note = str(body.note);
  const updated = await prisma.$transaction(async (tx) => {
    let saleId = null;
    if (status === 'COMPLETED') {
      const sale = await createSale(tx, {
        businessId: order.businessId,
        userId: order.sellerId,
        orderId: order.id,
        clientName: order.customerName,
        paymentMethod: body.paymentMethod,
        notes: `Pedido ${order.code}`,
        allowPriceOverride: true,
        items: order.items.map((i) => ({
          type: i.type,
          variantId: i.variantId,
          serviceId: i.serviceId,
          quantity: i.quantity,
          unitPrice: Number(i.unitPrice),
        })),
      });
      saleId = sale.id;
    }

    const result = await tx.order.update({
      where: { id: order.id },
      data: { status, completedAt: status === 'COMPLETED' ? new Date() : order.completedAt },
      include,
    });

    await logAudit(tx, req.user, {
      action: 'STATUS',
      entity: 'Order',
      entityId: order.id,
      summary: `Pedido ${order.code}: ${STATUS_LABEL[order.status]} → ${STATUS_LABEL[status]}${note ? ` — ${note}` : ''}`,
      changes: { status: { antes: order.status, despues: status }, nota: note, ventaGenerada: saleId },
    });
    return result;
  });

  res.json(updated);
});

module.exports = router;
