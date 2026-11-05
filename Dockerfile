FROM node:20-slim

# Prisma necesita OpenSSL en tiempo de ejecución
RUN apt-get update -y \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci --omit=dev

COPY . .
RUN npx prisma generate

EXPOSE 3000

# Ejecuta "prisma migrate deploy && node src/index.js"
CMD ["npm", "start"]
