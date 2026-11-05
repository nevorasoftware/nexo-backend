class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

const num = (value, def = 0) => {
  if (value === null || value === undefined || value === '') return def;
  const n = Number(value);
  return Number.isFinite(n) ? n : def;
};

const int = (value, def = 0) => {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : def;
};

const str = (value) => {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s.length ? s : null;
};

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

function required(obj, fields) {
  const source = obj || {};
  const missing = fields.filter((f) => str(source[f]) === null);
  if (missing.length) {
    throw new HttpError(400, `Campos requeridos: ${missing.join(', ')}`);
  }
}

function publicUser(user) {
  if (!user) return null;
  // eslint-disable-next-line no-unused-vars
  const { passwordHash, ...rest } = user;
  return rest;
}

module.exports = { HttpError, num, int, str, round2, required, publicUser };
