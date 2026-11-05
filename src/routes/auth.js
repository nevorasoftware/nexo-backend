const router = require('express').Router();
const bcrypt = require('bcryptjs');
const prisma = require('../lib/prisma');
const { HttpError, str, required, publicUser } = require('../lib/http');
const { logAudit } = require('../lib/audit');
const { signToken, authenticate } = require('../middleware/auth');

// Registro: crea un negocio nuevo y su usuario Dueño
router.post('/register', async (req, res) => {
  const body = req.body || {};
  required(body, ['businessName', 'name', 'email', 'password']);
  if (String(body.password).length < 6) throw new HttpError(400, 'La contraseña debe tener al menos 6 caracteres');

  const email = String(body.email).trim().toLowerCase();
  const exists = await prisma.user.findUnique({ where: { email } });
  if (exists) throw new HttpError(409, 'Ese correo ya está registrado');

  const passwordHash = await bcrypt.hash(String(body.password), 10);

  const { user, business } = await prisma.$transaction(async (tx) => {
    const business = await tx.business.create({
      data: { name: str(body.businessName), currency: (str(body.currency) || 'USD').toUpperCase() },
    });
    const user = await tx.user.create({
      data: { businessId: business.id, name: str(body.name), email, passwordHash, role: 'OWNER' },
    });
    await logAudit(tx, user, {
      action: 'CREATE',
      entity: 'Business',
      entityId: business.id,
      summary: `Negocio "${business.name}" creado por ${user.name}`,
      after: business,
    });
    return { user, business };
  });

  res.status(201).json({ token: signToken(user), user: publicUser(user), business });
});

router.post('/login', async (req, res) => {
  const body = req.body || {};
  required(body, ['email', 'password']);
  const email = String(body.email).trim().toLowerCase();

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || !(await bcrypt.compare(String(body.password), user.passwordHash))) {
    throw new HttpError(401, 'Correo o contraseña incorrectos');
  }
  if (!user.active) throw new HttpError(403, 'Tu usuario está desactivado. Contacta al dueño del negocio.');

  const updated = await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
  const business = await prisma.business.findUnique({ where: { id: user.businessId } });
  await logAudit(prisma, user, {
    action: 'LOGIN',
    entity: 'User',
    entityId: user.id,
    summary: `${user.name} inició sesión`,
    changes: {},
  });

  res.json({ token: signToken(updated), user: publicUser(updated), business });
});

router.get('/me', authenticate, async (req, res) => {
  const business = await prisma.business.findUnique({ where: { id: req.user.businessId } });
  res.json({ user: publicUser(req.user), business });
});

// Personalización del perfil propio
router.put('/me', authenticate, async (req, res) => {
  const body = req.body || {};
  const before = req.user;
  const data = {};

  for (const field of ['name', 'phone', 'bio', 'avatarUrl', 'avatarColor']) {
    if (body[field] !== undefined) data[field] = str(body[field]);
  }
  if (data.name === null) throw new HttpError(400, 'El nombre es requerido');
  if (data.avatarColor === null) delete data.avatarColor;

  if (body.newPassword) {
    if (String(body.newPassword).length < 6) throw new HttpError(400, 'La nueva contraseña debe tener al menos 6 caracteres');
    const ok = await bcrypt.compare(String(body.currentPassword || ''), before.passwordHash);
    if (!ok) throw new HttpError(400, 'La contraseña actual no es correcta');
    data.passwordHash = await bcrypt.hash(String(body.newPassword), 10);
  }

  const user = await prisma.user.update({ where: { id: before.id }, data });
  await logAudit(prisma, user, {
    action: 'UPDATE',
    entity: 'User',
    entityId: user.id,
    summary: `${user.name} actualizó su perfil${body.newPassword ? ' (incluye contraseña)' : ''}`,
    before,
    after: user,
  });

  res.json({ user: publicUser(user) });
});

module.exports = router;
