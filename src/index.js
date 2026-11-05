const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const prisma = require('./lib/prisma');
const { authenticate } = require('./middleware/auth');

if (!process.env.JWT_SECRET) {
  console.error('❌ Falta la variable de entorno JWT_SECRET');
  process.exit(1);
}

const app = express();
app.set('trust proxy', 1);

// CORS: CORS_ORIGIN puede ser una lista separada por comas. Si no se define, se permite cualquier origen.
const origins = (process.env.CORS_ORIGIN || '')
  .split(',')
  .map((o) => o.trim().replace(/\/$/, ''))
  .filter(Boolean);
app.use(cors({ origin: origins.length ? origins : true }));
app.use(helmet());
app.use(express.json({ limit: '1mb' }));
app.use(morgan(process.env.NODE_ENV === 'production' ? 'tiny' : 'dev'));

app.get('/', (req, res) => res.json({ name: 'Nexo API', status: 'ok' }));
app.get('/api/health', async (req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ status: 'ok', db: 'ok', time: new Date().toISOString() });
  } catch {
    res.status(503).json({ status: 'error', db: 'unreachable' });
  }
});

app.use('/api/auth', require('./routes/auth'));
app.use('/api/business', authenticate, require('./routes/business'));
app.use('/api/users', authenticate, require('./routes/users'));
app.use('/api/products', authenticate, require('./routes/products'));
app.use('/api/services', authenticate, require('./routes/services'));
app.use('/api/sales', authenticate, require('./routes/sales'));
app.use('/api/orders', authenticate, require('./routes/orders'));
app.use('/api/dashboard', authenticate, require('./routes/dashboard'));
app.use('/api/audit', authenticate, require('./routes/audit'));

app.use((req, res) => res.status(404).json({ error: 'Ruta no encontrada' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err.status && err.status < 500) {
    return res.status(err.status).json({ error: err.message, details: err.details });
  }
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'JSON inválido' });
  if (err.code === 'P2002') return res.status(409).json({ error: 'Registro duplicado' });
  if (err.code === 'P2025') return res.status(404).json({ error: 'Registro no encontrado' });
  console.error(err);
  res.status(500).json({ error: 'Error interno del servidor' });
});

const PORT = Number(process.env.PORT) || 3000;
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`🌸 Nexo API escuchando en el puerto ${PORT}`);
});

const shutdown = async () => {
  server.close();
  await prisma.$disconnect();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
