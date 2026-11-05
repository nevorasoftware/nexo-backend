const jwt = require('jsonwebtoken');
const prisma = require('../lib/prisma');
const { HttpError } = require('../lib/http');

function signToken(user) {
  return jwt.sign(
    { sub: user.id, bid: user.businessId, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );
}

async function authenticate(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) throw new HttpError(401, 'No autenticado');

  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    throw new HttpError(401, 'Sesión inválida o expirada');
  }

  const user = await prisma.user.findUnique({ where: { id: payload.sub } });
  if (!user || !user.active) throw new HttpError(401, 'Usuario inactivo o inexistente');

  req.user = user;
  next();
}

const requireRole = (...roles) => (req, res, next) => {
  if (!req.user || !roles.includes(req.user.role)) {
    return next(new HttpError(403, 'No tienes permiso para realizar esta acción'));
  }
  next();
};

module.exports = { signToken, authenticate, requireRole };
