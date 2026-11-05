const { HttpError, num, int, str, round2 } = require('../lib/http');

/**
 * Normaliza y valida los ítems de una venta/pedido contra la base de datos.
 * Tipos: PRODUCT (variantId), SERVICE (serviceId), CUSTOM (name, unitPrice, unitCost).
 */
async function buildItems(tx, businessId, items, { allowCustom = true, allowPriceOverride = true } = {}) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new HttpError(400, 'Agrega al menos un producto o servicio');
  }

  const result = [];
  for (const raw of items) {
    const quantity = Math.max(1, int(raw.quantity, 1));
    const type = String(raw.type || '').toUpperCase();
    const hasOverride = allowPriceOverride && raw.unitPrice !== undefined && raw.unitPrice !== null && raw.unitPrice !== '';

    if (type === 'PRODUCT') {
      if (!raw.variantId) throw new HttpError(400, 'Falta el producto (variantId)');
      const variant = await tx.productVariant.findFirst({
        where: { id: String(raw.variantId), product: { businessId } },
        include: { product: true },
      });
      if (!variant) throw new HttpError(400, 'Producto no encontrado');
      result.push({
        type,
        variantId: variant.id,
        serviceId: null,
        name: variant.name === 'Única' ? variant.product.name : `${variant.product.name} - ${variant.name}`,
        quantity,
        unitPrice: hasOverride ? num(raw.unitPrice) : Number(variant.price),
        unitCost: Number(variant.cost),
      });
    } else if (type === 'SERVICE') {
      if (!raw.serviceId) throw new HttpError(400, 'Falta el servicio (serviceId)');
      const service = await tx.service.findFirst({ where: { id: String(raw.serviceId), businessId } });
      if (!service) throw new HttpError(400, 'Servicio no encontrado');
      result.push({
        type,
        variantId: null,
        serviceId: service.id,
        name: service.name,
        quantity,
        unitPrice: hasOverride ? num(raw.unitPrice) : Number(service.price),
        unitCost: Number(service.cost),
      });
    } else if (type === 'CUSTOM' && allowCustom) {
      const name = str(raw.name);
      if (!name) throw new HttpError(400, 'La venta libre necesita una descripción');
      result.push({
        type,
        variantId: null,
        serviceId: null,
        name,
        quantity,
        unitPrice: num(raw.unitPrice),
        unitCost: num(raw.unitCost),
      });
    } else {
      throw new HttpError(400, `Tipo de ítem inválido: ${type || '(vacío)'}`);
    }
  }

  return result.map((item) => {
    if (item.unitPrice < 0 || item.unitCost < 0) throw new HttpError(400, 'Los montos no pueden ser negativos');
    const unitPrice = round2(item.unitPrice);
    const unitCost = round2(item.unitCost);
    return { ...item, unitPrice, unitCost, subtotal: round2(unitPrice * item.quantity) };
  });
}

/**
 * Crea una venta dentro de una transacción: valida stock, descuenta inventario
 * y calcula total, costo y ganancia neta.
 */
async function createSale(tx, { businessId, userId, orderId = null, clientName, paymentMethod, notes, items, allowPriceOverride = true }) {
  const built = await buildItems(tx, businessId, items, { allowCustom: true, allowPriceOverride });

  // Validar y descontar stock de productos
  const qtyByVariant = {};
  for (const item of built) {
    if (item.variantId) qtyByVariant[item.variantId] = (qtyByVariant[item.variantId] || 0) + item.quantity;
  }
  for (const [variantId, qty] of Object.entries(qtyByVariant)) {
    const variant = await tx.productVariant.findUnique({ where: { id: variantId }, include: { product: true } });
    if (variant.stock < qty) {
      throw new HttpError(400, `Stock insuficiente para "${variant.product.name} - ${variant.name}" (disponible: ${variant.stock})`);
    }
    await tx.productVariant.update({ where: { id: variantId }, data: { stock: { decrement: qty } } });
  }

  const total = round2(built.reduce((acc, i) => acc + i.subtotal, 0));
  const cost = round2(built.reduce((acc, i) => acc + i.unitCost * i.quantity, 0));
  const profit = round2(total - cost);

  return tx.sale.create({
    data: {
      businessId,
      userId,
      orderId,
      clientName: str(clientName),
      paymentMethod: str(paymentMethod) || 'EFECTIVO',
      notes: str(notes),
      total,
      cost,
      profit,
      items: {
        create: built.map((i) => ({
          type: i.type,
          variantId: i.variantId,
          serviceId: i.serviceId,
          name: i.name,
          quantity: i.quantity,
          unitPrice: i.unitPrice,
          unitCost: i.unitCost,
          subtotal: i.subtotal,
        })),
      },
    },
    include: { items: true, user: { select: { id: true, name: true } } },
  });
}

module.exports = { buildItems, createSale };
