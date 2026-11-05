const router = require('express').Router();
const prisma = require('../lib/prisma');
const { int, round2 } = require('../lib/http');

const DAY = 86400000;

// tzOffset = minutos devueltos por Date.prototype.getTimezoneOffset() en el navegador
function localDayStart(date, off) {
  const localMs = date.getTime() - off * 60000;
  return new Date(Math.floor(localMs / DAY) * DAY + off * 60000);
}
function localMonthStart(date, off) {
  const local = new Date(date.getTime() - off * 60000);
  return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), 1) + off * 60000);
}
function localKey(date, off) {
  return new Date(date.getTime() - off * 60000).toISOString().slice(0, 10);
}

async function sumSales(where) {
  const agg = await prisma.sale.aggregate({
    where,
    _sum: { total: true, cost: true, profit: true },
    _count: { _all: true },
  });
  return {
    count: agg._count._all,
    total: Number(agg._sum.total || 0),
    cost: Number(agg._sum.cost || 0),
    profit: Number(agg._sum.profit || 0),
  };
}

router.get('/', async (req, res) => {
  const off = Math.max(-840, Math.min(840, int(req.query.tzOffset, 0)));
  const now = new Date();
  const todayStart = localDayStart(now, off);
  const monthStart = localMonthStart(now, off);
  const weekStart = new Date(todayStart.getTime() - 6 * DAY);
  const businessId = req.user.businessId;
  const isSeller = req.user.role === 'SELLER';

  const saleScope = { businessId, ...(isSeller ? { userId: req.user.id } : {}) };
  const orderScope = { businessId, ...(isSeller ? { sellerId: req.user.id } : {}) };

  const [today, month, weekSales, ordersGrouped, recentOrders] = await Promise.all([
    sumSales({ ...saleScope, createdAt: { gte: todayStart } }),
    sumSales({ ...saleScope, createdAt: { gte: monthStart } }),
    prisma.sale.findMany({
      where: { ...saleScope, createdAt: { gte: weekStart } },
      select: { createdAt: true, total: true, profit: true },
    }),
    prisma.order.groupBy({ by: ['status'], where: orderScope, _count: { _all: true } }),
    prisma.order.findMany({
      where: orderScope,
      orderBy: { createdAt: 'desc' },
      take: 5,
      include: { seller: { select: { id: true, name: true } } },
    }),
  ]);

  // Serie de los últimos 7 días
  const series = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(weekStart.getTime() + i * DAY);
    series.push({ date: localKey(d, off), total: 0, profit: 0 });
  }
  const byKey = Object.fromEntries(series.map((s) => [s.date, s]));
  for (const s of weekSales) {
    const bucket = byKey[localKey(s.createdAt, off)];
    if (bucket) {
      bucket.total = round2(bucket.total + Number(s.total));
      bucket.profit = round2(bucket.profit + Number(s.profit));
    }
  }

  const orders = { PENDING: 0, AT_HQ: 0, COMPLETED: 0, CANCELLED: 0 };
  for (const g of ordersGrouped) orders[g.status] = g._count._all;

  const response = { today, month, series, orders, recentOrders };

  if (!isSeller) {
    const thirtyDaysAgo = new Date(todayStart.getTime() - 29 * DAY);
    const [topItems, lowStock, recentSales] = await Promise.all([
      prisma.saleItem.groupBy({
        by: ['name', 'type'],
        where: { sale: { businessId, createdAt: { gte: thirtyDaysAgo } } },
        _sum: { subtotal: true, quantity: true },
        orderBy: { _sum: { subtotal: 'desc' } },
        take: 5,
      }),
      prisma.productVariant.findMany({
        where: { active: true, stock: { lte: 5 }, product: { businessId, active: true } },
        include: { product: { select: { id: true, name: true } } },
        orderBy: { stock: 'asc' },
        take: 8,
      }),
      prisma.sale.findMany({
        where: { businessId },
        orderBy: { createdAt: 'desc' },
        take: 6,
        include: { user: { select: { id: true, name: true } }, items: { select: { name: true, quantity: true } } },
      }),
    ]);
    response.topItems = topItems.map((t) => ({
      name: t.name,
      type: t.type,
      quantity: t._sum.quantity || 0,
      total: Number(t._sum.subtotal || 0),
    }));
    response.lowStock = lowStock;
    response.recentSales = recentSales;
  }

  res.json(response);
});

module.exports = router;
