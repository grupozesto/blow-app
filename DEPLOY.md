# 🚀 Deploy DeliveryApp v3 — Guía completa

## Servicios necesarios (todos gratuitos para empezar)

| Servicio | Para qué | Costo |
|---|---|---|
| Railway | Servidor Node.js + PostgreSQL | ~$25/mes en producción |
| Cloudinary | Fotos de productos | Gratis hasta 25GB |
| MercadoPago | Pagos | Sin costo fijo (cobra % por transacción) |

---

## Paso 1 — Subir código a GitHub

1. Crear cuenta en github.com
2. Crear repositorio nuevo (privado o público)
3. Subir todos los archivos del ZIP

---

## Paso 2 — Crear proyecto en Railway

1. Ir a railway.app → "Start a New Project"
2. Conectar con GitHub → elegir tu repositorio
3. Railway detecta Node.js automáticamente y hace el deploy

---

## Paso 3 — Agregar PostgreSQL

1. En tu proyecto de Railway → "+ New" → "Database" → "PostgreSQL"
2. Railway crea la base de datos y agrega `DATABASE_URL` automáticamente
3. ¡Listo! Las tablas se crean solas al iniciar la app

---

## Paso 4 — Configurar Cloudinary (fotos de productos)

1. Crear cuenta en cloudinary.com (plan gratuito)
2. En el Dashboard copiar la "API Environment variable" (empieza con `cloudinary://`)
3. En Railway → tu servicio → Variables → agregar:
   - `CLOUDINARY_URL` = (el valor que copiaste)

---

## Paso 5 — Configurar MercadoPago

1. Ir a mercadopago.com.uy → Tu negocio → Credenciales
2. Copiar el **Access Token de producción** (empieza con `APP_USR-`)
3. En Railway → Variables → agregar:
   - `MP_ACCESS_TOKEN` = APP_USR-tu-token

### Configurar webhook:
1. En MercadoPago → Tu negocio → Webhooks
2. URL: `https://TU-APP.railway.app/api/webhooks/mp`
3. Eventos: seleccionar "Pagos"

---

## Paso 6 — Variables de entorno en Railway

En Railway → tu servicio → Variables, agregar:

```
JWT_SECRET          = (genera 40+ caracteres aleatorios, ej: openssl rand -base64 32)
APP_URL             = https://TU-APP.railway.app
PLATFORM_FEE_PERCENT= 10
MP_ACCESS_TOKEN     = APP_USR-...
CLOUDINARY_URL      = cloudinary://...
```

`DATABASE_URL` ya fue agregada automáticamente por Railway en el Paso 3.

---

## Paso 7 — Crear cuenta Admin

Hacer una petición POST a tu app:

```
POST https://TU-APP.railway.app/api/admin/setup
Content-Type: application/json

{
  "name": "Tu Nombre",
  "email": "admin@tuapp.com",
  "password": "contraseña-segura"
}
```

Podés hacerlo con Postman, Insomnia, o desde la terminal:
```bash
curl -X POST https://TU-APP.railway.app/api/admin/setup \
  -H "Content-Type: application/json" \
  -d '{"name":"Admin","email":"admin@tuapp.com","password":"mipassword"}'
```

Después ingresás al panel admin en: `https://TU-APP.railway.app/admin`

---

## Tarjetas de prueba MercadoPago (sandbox)

Para probar pagos sin dinero real, usar token de **prueba** (empieza con `TEST-`):

| Tarjeta | Número | CVV | Vencimiento |
|---|---|---|---|
| Visa aprobada | 4509953566233704 | 123 | 11/25 |
| Mastercard aprobada | 5031755734530604 | 123 | 11/25 |
| Rechazada | 4000000000000002 | 123 | 11/25 |

---

## Verificar que todo funciona

Ir a: `https://TU-APP.railway.app/health`

Debería responder:
```json
{
  "status": "ok",
  "db": "postgres",
  "mp": true,
  "cloudinary": true
}
```

---

## Costos estimados en producción

- **Railway Pro**: ~$20/mes (servidor siempre activo)
- **Railway PostgreSQL**: ~$5/mes
- **Cloudinary**: Gratis hasta 25GB de almacenamiento
- **MercadoPago**: Sin costo fijo, cobra ~3.49% + IVA por transacción
- **Total**: ~$25/mes + comisión de pagos
