const router = require('express').Router();
const bcrypt = require('bcryptjs');
const prisma = require('../lib/prisma');
const { HttpError, str, required, publicUser } = require('../lib/http');
const { logAudit } = require('../lib/audit');
const { requireRole } = require('../middleware/auth');

const ROLES = ['OWNER', 'EMPLOYEE', 'SELLER'];
const ROLE_LABEL = { OWNER: 'Dueño', EMPLOYEE: 'Empleado', SELLER: 'Vendedor' };

router.use(requireRole('OWNER'));

async function findInBusiness(req) {
  const user = await prisma.user.findFirst({ where: { id: req.params.id, businessId: req.user.businessId } });
  if (!user) throw new HttpError(404, 'Usuario no encontrado');
  return user;
}

router.get('/', async (req, res) => {
  const users = await prisma.user.findMany({
    where: { businessId: req.user.businessId },
    orderBy: [{ active: 'desc' }, { createdAt: 'asc' }],
  });
  res.json(users.map(publicUser));
});

router.post('/', async (req, res) => {
  const body = req.body || {};
  required(body, ['name', 'email', 'password', 'role']);
  if (!ROLES.includes(body.role)) throw new HttpError(400, 'Rol inválido');
  if (String(body.password).length < 6) throw new HttpError(400, 'La contraseña debe tener al menos 6 caracteres');

  const email = String(body.email).trim().toLowerCase();
  if (await prisma.user.findUnique({ where: { email } })) throw new HttpError(409, 'Ese correo ya está registrado');

  const user = await prisma.user.create({
    data: {
      businessId: req.user.businessId,
      name: str(body.name),
      email,
      role: body.role,
      phone: str(body.phone),
      passwordHash: await bcrypt.hash(String(body.password), 10),
    },
  });
  await logAudit(prisma, req.user, {
    action: 'CREATE',
    entity: 'User',
    entityId: user.id,
    summary: `Usuario ${user.name} creado como ${ROLE_LABEL[user.role]}`,
    after: publicUser(user),
  });
  res.status(201).json(publicUser(user));
});

router.put('/:id', async (req, res) => {
  const body = req.body || {};
  const before = await findInBusiness(req);
  const data = {};

  if (body.name !== undefined) {
    data.name = str(body.name);
    if (!data.name) throw new HttpError(400, 'El nombre es requerido');
  }
  if (body.phone !== undefined) data.phone = str(body.phone);
  if (body.email !== undefined) {
    const email = String(body.email).trim().toLowerCase();
    if (email !== before.email) {
      if (await prisma.user.findUnique({ where: { email } })) throw new HttpError(409, 'Ese correo ya está registrado');
      data.email = email;
    }
  }
  if (body.role !== undefined) {
    if (!ROLES.includes(body.role)) throw new HttpError(400, 'Rol inválido');
    if (before.id === req.user.id && body.role !== 'OWNER') throw new HttpError(400, 'No puedes quitarte el rol de Dueño');
    data.role = body.role;
  }
  if (body.active !== undefined) {
    if (before.id === req.user.id && !body.active) throw new HttpError(400, 'No puedes desactivarte a ti mismo');
    data.active = Boolean(body.active);
  }
  if (body.password) {
    if (String(body.password).length < 6) throw new HttpError(400, 'La contraseña debe tener al menos 6 caracteres');
    data.passwordHash = await bcrypt.hash(String(body.password), 10);
  }

  const user = await prisma.user.update({ where: { id: before.id }, data });
  await logAudit(prisma, req.user, {
    action: 'UPDATE',
    entity: 'User',
    entityId: user.id,
    summary: `Usuario ${user.name} modificado${body.password ? ' (contraseña restablecida)' : ''}`,
    before,
    after: user,
  });
  res.json(publicUser(user));
});

// Desactivación (soft delete) para conservar historial
router.delete('/:id', async (req, res) => {
  const before = await findInBusiness(req);
  if (before.id === req.user.id) throw new HttpError(400, 'No puedes desactivarte a ti mismo');
  const user = await prisma.user.update({ where: { id: before.id }, data: { active: false } });
  await logAudit(prisma, req.user, {
    action: 'DELETE',
    entity: 'User',
    entityId: user.id,
    summary: `Usuario ${user.name} desactivado`,
    before,
    after: user,
  });
  res.json(publicUser(user));
});

module.exports = router;
