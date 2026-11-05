const router = require('express').Router();
const prisma = require('../lib/prisma');
const { HttpError, num, int, str, required } = require('../lib/http');
const { logAudit } = require('../lib/audit');
const { requireRole } = require('../middleware/auth');

const include = { variants: { where: { active: true }, orderBy: { createdAt: 'asc' } } };

function normalizeVariant(v = {}) {
  const variant = {
    name: str(v.name) || 'Única',
    sku: str(v.sku),
    price: num(v.price),
    cost: num(v.cost),
    stock: int(v.stock, 0),
  };
  if (variant.price < 0 || variant.cost < 0) throw new HttpError(400, 'Precio y costo no pueden ser negativos');
  return variant;
}

async function findProduct(req) {
  const product = await prisma.product.findFirst({
    where: { id: req.params.id, businessId: req.user.businessId },
    include,
  });
  if (!product) throw new HttpError(404, 'Producto no encontrado');
  return product;
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
  const products = await prisma.product.findMany({ where, include, orderBy: { name: 'asc' } });
  res.json(products);
});

router.get('/:id', async (req, res) => {
  res.json(await findProduct(req));
});

router.post('/', requireRole('OWNER', 'EMPLOYEE'), async (req, res) => {
  const body = req.body || {};
  required(body, ['name']);
  const variants = Array.isArray(body.variants) && body.variants.length
    ? body.variants.map(normalizeVariant)
    : [normalizeVariant({ name: 'Única', price: body.price, cost: body.cost, stock: body.stock })];

  const product = await prisma.product.create({
    data: {
      businessId: req.user.businessId,
      name: str(body.name),
      description: str(body.description),
      category: str(body.category),
      imageUrl: str(body.imageUrl),
      variants: { create: variants },
    },
    include,
  });

  await logAudit(prisma, req.user, {
    action: 'CREATE',
    entity: 'Product',
    entityId: product.id,
    summary: `Producto "${product.name}" creado con ${product.variants.length} variante(s)`,
    after: product,
  });
  res.status(201).json(product);
});

router.put('/:id', requireRole('OWNER', 'EMPLOYEE'), async (req, res) => {
  const body = req.body || {};
  const before = await findProduct(req);

  const data = {};
  for (const field of ['name', 'description', 'category', 'imageUrl']) {
    if (body[field] !== undefined) data[field] = str(body[field]);
  }
  if (data.name === null) throw new HttpError(400, 'El nombre es requerido');

  await prisma.$transaction(async (tx) => {
    await tx.product.update({ where: { id: before.id }, data });

    if (Array.isArray(body.variants)) {
      if (body.variants.length === 0) throw new HttpError(400, 'El producto debe tener al menos una variante');
      const keepIds = [];
      for (const raw of body.variants) {
        const v = normalizeVariant(raw);
        const existing = raw.id ? before.variants.find((x) => x.id === raw.id) : null;
        if (existing) {
          await tx.productVariant.update({ where: { id: existing.id }, data: v });
          keepIds.push(existing.id);
        } else {
          const created = await tx.productVariant.create({ data: { ...v, productId: before.id } });
          keepIds.push(created.id);
        }
      }
      // Las variantes removidas se desactivan para conservar el historial de ventas
      await tx.productVariant.updateMany({
        where: { productId: before.id, id: { notIn: keepIds } },
        data: { active: false },
      });
    }
  });

  const after = await prisma.product.findUnique({ where: { id: before.id }, include });
  await logAudit(prisma, req.user, {
    action: 'UPDATE',
    entity: 'Product',
    entityId: after.id,
    summary: `Producto "${after.name}" modificado`,
    before,
    after,
  });
  res.json(after);
});

// Ajuste rápido de stock de una variante (entrada / salida de inventario)
router.patch('/variants/:variantId/stock', requireRole('OWNER', 'EMPLOYEE'), async (req, res) => {
  const body = req.body || {};
  const delta = int(body.delta, 0);
  if (!delta) throw new HttpError(400, 'Indica una cantidad distinta de cero');

  const variant = await prisma.productVariant.findFirst({
    where: { id: req.params.variantId, product: { businessId: req.user.businessId } },
    include: { product: true },
  });
  if (!variant) throw new HttpError(404, 'Variante no encontrada');
  if (variant.stock + delta < 0) throw new HttpError(400, `El stock no puede quedar negativo (actual: ${variant.stock})`);

  const updated = await prisma.productVariant.update({
    where: { id: variant.id },
    data: { stock: { increment: delta } },
  });
  await logAudit(prisma, req.user, {
    action: 'STOCK',
    entity: 'Product',
    entityId: variant.productId,
    summary: `Stock de "${variant.product.name} - ${variant.name}": ${variant.stock} → ${updated.stock}${str(body.reason) ? ` (${str(body.reason)})` : ''}`,
    changes: { stock: { antes: variant.stock, despues: updated.stock }, motivo: str(body.reason) },
  });
  res.json(updated);
});

router.delete('/:id', requireRole('OWNER'), async (req, res) => {
  const before = await findProduct(req);
  await prisma.product.update({ where: { id: before.id }, data: { active: false } });
  await logAudit(prisma, req.user, {
    action: 'DELETE',
    entity: 'Product',
    entityId: before.id,
    summary: `Producto "${before.name}" eliminado`,
    before,
  });
  res.json({ ok: true });
});

module.exports = router;
