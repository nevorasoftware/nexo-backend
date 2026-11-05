# nexo-backend

API REST de **Nexo**, sistema de gestión de ventas, servicios e inventario para salones de belleza.

**Stack:** Node.js 20, Express 5, Prisma 5 y PostgreSQL. Se despliega en Railway con Dockerfile.

## Variables de entorno

| Variable       | Descripción                                                  |
| -------------- | ------------------------------------------------------------ |
| `DATABASE_URL` | Conexión a PostgreSQL (`${{Postgres.DATABASE_URL}}` en Railway) |
| `JWT_SECRET`   | Secreto para firmar los tokens                                |
| `PORT`         | Puerto HTTP (Railway lo inyecta)                              |
| `CORS_ORIGIN`  | *(Opcional)* URL(s) del frontend separadas por coma           |

## Scripts

- `npm run build`: `prisma generate`
- `npm start`: `prisma migrate deploy && node src/index.js` (aplica migraciones y arranca)

## Roles

- **OWNER (Dueño):** acceso total, equipo, historial y configuración del negocio.
- **EMPLOYEE (Empleado):** ventas, inventario y gestión de pedidos en Casa Matriz.
- **SELLER (Vendedor digital):** crea pedidos y consulta el catálogo y sus pedidos.

## Endpoints principales (`/api`)

| Método | Ruta | Descripción |
| ------ | ---- | ----------- |
| POST | `/auth/register` | Crea el negocio y el usuario Dueño |
| POST | `/auth/login` | Inicio de sesión |
| GET/PUT | `/auth/me` | Perfil propio |
| GET/PUT | `/business` | Datos del negocio |
| CRUD | `/users` | Equipo (solo Dueño) |
| CRUD | `/products` | Productos con variantes; `PATCH /products/variants/:id/stock` ajusta el stock |
| CRUD | `/services` | Servicios |
| GET/POST/DELETE | `/sales` | Ventas con total, costo y ganancia neta |
| GET/POST/PUT | `/orders` | Pedidos de vendedores; `PATCH /orders/:id/status` cambia el estado |
| GET | `/dashboard?tzOffset=` | Resumen diario y mensual |
| GET | `/audit` | Historial de modificaciones |
| GET | `/health` | Healthcheck |

### Flujo de pedidos

`PENDING` (Vendedor) → `AT_HQ` (Casa Matriz) → `COMPLETED` (Cliente final). Al completarse un pedido se genera la venta automáticamente y se descuenta el inventario. El pedido también puede pasar a `CANCELLED` (cancelado).
