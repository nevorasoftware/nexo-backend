const router = require('express').Router();
const prisma = require('../lib/prisma');
const { int, str } = require('../lib/http');
const { requireRole } = require('../middleware/auth');

router.use(requireRole('OWNER'));

// Historial de modificaciones: quién, qué y cuándo
router.get('/', async (req, res) => {
  const page = Math.max(1, int(req.query.page, 1));
  const pageSize = Math.min(100, Math.max(5, int(req.query.pageSize, 30)));
  const where = { businessId: req.user.businessId };

  const entity = str(req.query.entity);
  const action = str(req.query.action);
  const userId = str(req.query.userId);
  const q = str(req.query.q);
  if (entity) where.entity = entity;
  if (action) where.action = action;
  if (userId) where.userId = userId;
  if (q) where.summary = { contains: q, mode: 'insensitive' };

  const [items, total] = await Promise.all([
    prisma.auditLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.auditLog.count({ where }),
  ]);

  res.json({ items, total, page, pages: Math.max(1, Math.ceil(total / pageSize)) });
});

module.exports = router;
