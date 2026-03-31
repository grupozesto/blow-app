// ════════════════════════════════════════════════
//  Blow — Backend v3.0
//  Node.js + Express + PostgreSQL + Cloudinary + MercadoPago + WebSockets
// ════════════════════════════════════════════════
require('dotenv').config();
// Resend email via HTTPS (no SMTP needed)
const express      = require('express');
const cors         = require('cors');
const bcrypt       = require('bcryptjs');
const jwt          = require('jsonwebtoken');
const { v4: uuid } = require('uuid');
function safeJson(val, def=[]) { try { return typeof val==='string' ? JSON.parse(val) : (val||def); } catch { return def; } }
function calcPromoDiscount(promo, items, cartTotal) {
  const now = new Date();
  if (promo.min_order_amount > 0 && cartTotal < promo.min_order_amount) return 0;
  if (promo.type === 'percent_off') return Math.round(cartTotal * promo.value / 100);
  if (promo.type === 'free_delivery') return 0; // handled in checkout
  if (promo.type === 'fixed_off') return Math.min(promo.value, cartTotal);
  if (promo.type === 'category_percent') return 0; // complex, handled client-side
  if (promo.type === 'bogo') return 0; // handled client-side
  if (promo.type === 'combo') return 0; // handled client-side
  return 0;
}
const path         = require('path');
const http         = require('http');
const { Pool }     = require('pg');

const app    = express();
app.set('trust proxy', 1); // Railway runs behind a proxy
const server = http.createServer(app);
const PORT   = process.env.PORT || 3000;
const JWT_SECRET   = process.env.JWT_SECRET || 'dev_secret_cambiar_en_prod';
const PLATFORM_FEE_DEFAULT = parseFloat(process.env.PLATFORM_FEE_PERCENT || 0) / 100;
async function getPlatformFee() {
  try {
    const row = await q1("SELECT value FROM app_settings WHERE key='platform_fee_percent'");
    if (row) return parseFloat(JSON.parse(row.value)) / 100;
  } catch(e) {}
  return PLATFORM_FEE_DEFAULT;
}
const APP_URL      = (process.env.APP_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');

// ── Plan único ────────────────────────────────
let PLAN_PRICE = 2990; // $UYU por mes — se puede cambiar desde admin
async function loadPlanPrice() {
  try {
    const r1 = await q1("SELECT value FROM app_settings WHERE key='registration_fee'", []);
    if (r1) { const v = parseFloat(JSON.parse(r1.value)); PLAN_PRICE = isNaN(v) ? 2990 : v; return; }
    const r2 = await q1("SELECT value FROM app_settings WHERE key='plan_price'", []);
    if (r2) { const v = parseFloat(JSON.parse(r2.value)); PLAN_PRICE = isNaN(v) ? 2990 : v; }
  } catch(e) {}
}
const BLOW_PLUS_PRICE = 990;  // $UYU por mes — Blow+ negocio
const BLOW_PLUS_USER_PRICE = 200; // $UYU por mes — Blow+ cliente
const PLANS = {
  active: {
    name: 'Activo',
    price: PLAN_PRICE,
    features: [
      'Productos ilimitados',
      'Recibir pedidos online',
      'Panel de gestión completo',
      'Fotos en productos',
      'Estadísticas de ventas',
      'Soporte incluido',
    ],
  },
};

// ── WebSockets ─────────────────────────────────
const { WebSocketServer } = require('ws');
const wss     = new WebSocketServer({ server });
const clients = new Map();
wss.on('connection', ws => {
  ws.on('message', msg => {
    try {
      const { token } = JSON.parse(msg);
      const u = jwt.verify(token, JWT_SECRET);
      clients.set(u.id, ws);
      ws.userId = u.id;
    } catch {}
  });
  ws.on('close', () => { if (ws.userId) clients.delete(ws.userId); });
});
function notify(userId, payload) {
  const ws = clients.get(userId);
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(payload));
}

// ── PostgreSQL ─────────────────────────────────
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: (process.env.DATABASE_URL || '').includes('railway') || process.env.DB_SSL === 'true'
    ? { rejectUnauthorized: false } : false,
});

const q  = (text, params) => db.query(text, params);
const q1 = async (text, params) => { const r = await db.query(text, params); return r.rows[0] || null; };
const qa = async (text, params) => { const r = await db.query(text, params); return r.rows; };

// ── Init DB schema ─────────────────────────────
async function initDB() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL, phone TEXT DEFAULT '',
      password TEXT NOT NULL, role TEXT DEFAULT 'customer',
      address TEXT DEFAULT '', city TEXT DEFAULT '', department TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS businesses (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL, category TEXT NOT NULL,
      address TEXT DEFAULT '', phone TEXT DEFAULT '',
      logo_emoji TEXT DEFAULT '🏪', delivery_cost INTEGER DEFAULT 50,
      is_open BOOLEAN DEFAULT TRUE, plan TEXT DEFAULT 'starter',
      rating REAL DEFAULT 4.5, delivery_time TEXT DEFAULT '20-35',
      city TEXT DEFAULT '', department TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS product_categories (
      id TEXT PRIMARY KEY, business_id TEXT NOT NULL, parent_id TEXT,
      name TEXT NOT NULL, sort_order INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY, business_id TEXT NOT NULL, category_id TEXT,
      emoji TEXT DEFAULT '🍽️', name TEXT NOT NULL,
      description TEXT DEFAULT '', price REAL NOT NULL,
      is_available BOOLEAN DEFAULT TRUE, created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS product_photos (
      id TEXT PRIMARY KEY, product_id TEXT NOT NULL,
      url TEXT NOT NULL, cloudinary_id TEXT,
      sort_order INTEGER DEFAULT 0, created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS product_variants (
      id TEXT PRIMARY KEY, product_id TEXT NOT NULL,
      group_name TEXT NOT NULL, option_name TEXT NOT NULL,
      price_delta REAL DEFAULT 0, sort_order INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY, customer_id TEXT NOT NULL,
      business_id TEXT NOT NULL, delivery_id TEXT,
      status TEXT DEFAULT 'pending', subtotal REAL NOT NULL,
      delivery_fee REAL DEFAULT 0, total REAL NOT NULL,
      address TEXT DEFAULT '', mp_payment_id TEXT, mp_status TEXT,
      business_amount REAL DEFAULT 0, delivery_amount REAL DEFAULT 0,
      platform_amount REAL DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS order_items (
      id TEXT PRIMARY KEY, order_id TEXT NOT NULL, product_id TEXT,
      name TEXT NOT NULL, emoji TEXT DEFAULT '🍽️',
      price REAL NOT NULL, quantity INTEGER DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS wallets (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL UNIQUE,
      owner_type TEXT NOT NULL, balance REAL DEFAULT 0,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS transactions (
      id TEXT PRIMARY KEY, wallet_id TEXT NOT NULL,
      type TEXT NOT NULL, amount REAL NOT NULL,
      description TEXT, order_id TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS withdrawals (
      id TEXT PRIMARY KEY, wallet_id TEXT NOT NULL,
      owner_id TEXT NOT NULL, owner_name TEXT NOT NULL,
      email TEXT DEFAULT '', amount REAL NOT NULL,
      method TEXT NOT NULL, destination TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      created_at TIMESTAMPTZ DEFAULT NOW(), processed_at TIMESTAMPTZ
    );
    CREATE TABLE IF NOT EXISTS user_addresses (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL,
      label TEXT NOT NULL, full_address TEXT NOT NULL,
      city TEXT NOT NULL, department TEXT DEFAULT '',
      lat REAL, lng REAL, is_active BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY, value TEXT,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS pending_registrations (
      id TEXT PRIMARY KEY,
      data JSONB NOT NULL,
      mp_preference_id TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      expires_at TIMESTAMPTZ DEFAULT NULL
    );
    CREATE TABLE IF NOT EXISTS subscriptions (
      id TEXT PRIMARY KEY,
      business_id TEXT NOT NULL UNIQUE,
      owner_id TEXT NOT NULL,
      plan TEXT NOT NULL DEFAULT 'active',
      status TEXT NOT NULL DEFAULT 'active',
      mp_subscription_id TEXT,
      mp_preapproval_id TEXT,
      current_period_start TIMESTAMPTZ DEFAULT NOW(),
      current_period_end TIMESTAMPTZ,
      cancelled_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS business_categories (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      emoji TEXT DEFAULT '🏪',
      sort_order INTEGER DEFAULT 0,
      is_active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS subscription_plans (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      price REAL NOT NULL DEFAULT 0,
      description TEXT DEFAULT '',
      features TEXT DEFAULT '[]',
      is_active BOOLEAN DEFAULT TRUE,
      sort_order INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS features TEXT DEFAULT '[]';
    ALTER TABLE businesses ADD COLUMN IF NOT EXISTS offers_delivery BOOLEAN DEFAULT TRUE;
    ALTER TABLE businesses ADD COLUMN IF NOT EXISTS offers_pickup BOOLEAN DEFAULT FALSE;
    ALTER TABLE businesses ADD COLUMN IF NOT EXISTS custom_delivery_cost INTEGER DEFAULT NULL;
    ALTER TABLE products ADD COLUMN IF NOT EXISTS discount_percent INTEGER DEFAULT 0;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS fulfillment_type TEXT DEFAULT 'delivery';
    ALTER TABLE businesses ADD COLUMN IF NOT EXISTS cover_url TEXT DEFAULT NULL;
    ALTER TABLE businesses ADD COLUMN IF NOT EXISTS logo_url TEXT DEFAULT NULL;
    ALTER TABLE businesses ADD COLUMN IF NOT EXISTS description TEXT DEFAULT '';
    ALTER TABLE businesses ADD COLUMN IF NOT EXISTS tags TEXT DEFAULT '[]';
    ALTER TABLE products ADD COLUMN IF NOT EXISTS photo_url TEXT DEFAULT NULL;
    ALTER TABLE products ADD COLUMN IF NOT EXISTS is_featured BOOLEAN DEFAULT FALSE;
    ALTER TABLE businesses ADD COLUMN IF NOT EXISTS blow_plus BOOLEAN DEFAULT FALSE;
    ALTER TABLE businesses ADD COLUMN IF NOT EXISTS blow_plus_since TIMESTAMPTZ DEFAULT NULL;
    ALTER TABLE businesses ADD COLUMN IF NOT EXISTS blow_plus_expires TIMESTAMPTZ DEFAULT NULL;
    ALTER TABLE businesses ADD COLUMN IF NOT EXISTS blow_plus_mp_id TEXT DEFAULT NULL;
    ALTER TABLE businesses ADD COLUMN IF NOT EXISTS blow_plus_free_delivery BOOLEAN DEFAULT FALSE;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS blow_plus BOOLEAN DEFAULT FALSE;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS blow_plus_since TIMESTAMPTZ DEFAULT NULL;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS blow_plus_expires TIMESTAMPTZ DEFAULT NULL;
    CREATE TABLE IF NOT EXISTS promotions (
      id TEXT PRIMARY KEY,
      business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      value REAL NOT NULL DEFAULT 0,
      min_order_amount REAL DEFAULT 0,
      category_id TEXT DEFAULT NULL,
      combo_products TEXT DEFAULT '[]',
      combo_price REAL DEFAULT 0,
      code TEXT DEFAULT NULL,
      requires_code BOOLEAN DEFAULT FALSE,
      is_active BOOLEAN DEFAULT TRUE,
      starts_at TIMESTAMPTZ DEFAULT NULL,
      ends_at TIMESTAMPTZ DEFAULT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS email_verifications (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      code TEXT NOT NULL,
      data JSONB NOT NULL,
      expires_at TIMESTAMPTZ DEFAULT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS coupons (
      id TEXT PRIMARY KEY,
      code TEXT UNIQUE NOT NULL,
      description TEXT,
      discount_type TEXT NOT NULL DEFAULT 'percent',
      discount_value NUMERIC NOT NULL DEFAULT 10,
      min_order NUMERIC DEFAULT 0,
      max_uses INTEGER DEFAULT NULL,
      uses_count INTEGER DEFAULT 0,
      per_user INTEGER DEFAULT 1,
      business_id TEXT REFERENCES businesses(id) ON DELETE CASCADE,
      created_by TEXT NOT NULL,
      expires_at TIMESTAMPTZ DEFAULT NULL,
      active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS coupon_uses (
      id TEXT PRIMARY KEY,
      coupon_id TEXT REFERENCES coupons(id) ON DELETE CASCADE,
      user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
      order_id TEXT,
      used_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS help_messages (
      id TEXT PRIMARY KEY,
      user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      user_name TEXT,
      user_email TEXT,
      message TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      admin_reply TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    ALTER TABLE promotions ADD COLUMN IF NOT EXISTS blow_plus_only BOOLEAN DEFAULT FALSE;
    ALTER TABLE promo_banners ADD COLUMN IF NOT EXISTS banner_type TEXT DEFAULT 'hero';
    ALTER TABLE promo_banners ADD COLUMN IF NOT EXISTS image_url TEXT DEFAULT '';
    ALTER TABLE users ADD COLUMN IF NOT EXISTS phone TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT;

    CREATE TABLE IF NOT EXISTS user_coupons (
      id TEXT PRIMARY KEY,
      user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
      coupon_id TEXT REFERENCES coupons(id) ON DELETE CASCADE,
      assigned_by TEXT NOT NULL,
      assigned_at TIMESTAMPTZ DEFAULT NOW(),
      used BOOLEAN DEFAULT FALSE,
      used_at TIMESTAMPTZ,
      UNIQUE(user_id, coupon_id)
    );

    CREATE TABLE IF NOT EXISTS featured_slots (
      id TEXT PRIMARY KEY,
      business_id TEXT REFERENCES businesses(id) ON DELETE CASCADE,
      custom_image TEXT,
      custom_title TEXT,
      sort_order INTEGER DEFAULT 0,
      active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS favorites (
      id TEXT PRIMARY KEY,
      user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
      product_id TEXT REFERENCES products(id) ON DELETE CASCADE,
      business_id TEXT REFERENCES businesses(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(user_id, product_id)
    );

    CREATE TABLE IF NOT EXISTS order_reviews (
      id TEXT PRIMARY KEY,
      order_id TEXT UNIQUE REFERENCES orders(id) ON DELETE CASCADE,
      business_id TEXT REFERENCES businesses(id) ON DELETE CASCADE,
      user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
      rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
      comment TEXT DEFAULT '',
      owner_reply TEXT DEFAULT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS order_messages (
      id TEXT PRIMARY KEY,
      order_id TEXT REFERENCES orders(id) ON DELETE CASCADE,
      sender_id TEXT REFERENCES users(id) ON DELETE CASCADE,
      body TEXT NOT NULL,
      read_at TIMESTAMPTZ DEFAULT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS support_messages (
      id TEXT PRIMARY KEY,
      user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
      sender_id TEXT REFERENCES users(id) ON DELETE CASCADE,
      body TEXT NOT NULL,
      is_admin BOOLEAN DEFAULT FALSE,
      read_at TIMESTAMPTZ DEFAULT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS business_subcategories (
      id TEXT PRIMARY KEY,
      category_id TEXT REFERENCES business_categories(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      emoji TEXT DEFAULT '🍽️',
      image_url TEXT DEFAULT NULL,
      sort_order INTEGER DEFAULT 0,
      is_active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS category_banners (
      id TEXT PRIMARY KEY,
      category_id TEXT REFERENCES business_categories(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      subtitle TEXT DEFAULT '',
      bg_color TEXT DEFAULT '#FA0050',
      image_url TEXT DEFAULT NULL,
      link_business_id TEXT REFERENCES businesses(id) ON DELETE SET NULL,
      sort_order INTEGER DEFAULT 0,
      active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS category_featured (
      id TEXT PRIMARY KEY,
      category_id TEXT REFERENCES business_categories(id) ON DELETE CASCADE,
      business_id TEXT REFERENCES businesses(id) ON DELETE CASCADE,
      sort_order INTEGER DEFAULT 0,
      active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    ALTER TABLE users ADD COLUMN IF NOT EXISTS banned BOOLEAN DEFAULT FALSE;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS ban_reason TEXT DEFAULT '';

    CREATE TABLE IF NOT EXISTS promo_banners (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      subtitle TEXT DEFAULT '',
      highlight TEXT DEFAULT '',
      emoji TEXT DEFAULT '🍔',
      image_url TEXT DEFAULT '',
      bg_color TEXT DEFAULT '#FA0050',
      link TEXT DEFAULT '',
      sort_order INTEGER DEFAULT 0,
      active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  // Seed default categories if none exist
  const catCount = await q1('SELECT COUNT(*) as c FROM business_categories',[]);
  if (parseInt(catCount.c) === 0) {
    const defaultCats = [
      {id:'cat-food',name:'Restaurantes',emoji:'🍔',sort_order:1},
      {id:'cat-market',name:'Mercados',emoji:'🛒',sort_order:2},
      {id:'cat-pharmacy',name:'Farmacias',emoji:'💊',sort_order:3},
      {id:'cat-drinks',name:'Bebidas',emoji:'🥤',sort_order:4},
      {id:'cat-desserts',name:'Postres',emoji:'🍰',sort_order:5},
      {id:'cat-cafe',name:'Café',emoji:'☕',sort_order:6},
    ];
    for (const c of defaultCats)
      await q('INSERT INTO business_categories (id,name,emoji,sort_order) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING',[c.id,c.name,c.emoji,c.sort_order]);
  }
  // Seed default subscription plan if none
  const planCount = await q1('SELECT COUNT(*) as c FROM subscription_plans',[]);
  if (parseInt(planCount.c) === 0)
    await q("INSERT INTO subscription_plans (id,name,price,description,sort_order) VALUES ('plan-default','Plan Activo',2990,'Acceso completo a la plataforma',1) ON CONFLICT DO NOTHING",[]);
  console.log('✅ PostgreSQL — tablas listas');
}

// ── Cloudinary ────────────────────────────────
let cloudinary = null;
try {
  cloudinary = require('cloudinary').v2;
  const hasConfig = process.env.CLOUDINARY_URL ||
    (process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET);
  if (hasConfig) {
    if (process.env.CLOUDINARY_URL) {
      cloudinary.config({ cloudinary_url: process.env.CLOUDINARY_URL });
    } else {
      cloudinary.config({
        cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
        api_key:    process.env.CLOUDINARY_API_KEY,
        api_secret: process.env.CLOUDINARY_API_SECRET,
      });
    }
    console.log('✅ Cloudinary listo');
  } else {
    console.warn('⚠️  Cloudinary no configurado — fotos no disponibles');
    cloudinary = null;
  }
} catch(e) { console.warn('⚠️  cloudinary no instalado'); cloudinary = null; }

async function uploadPhoto(base64Data, mimeType) {
  if (!cloudinary) throw new Error('Cloudinary no configurado. Agregá las variables CLOUDINARY_* en Railway.');
  const dataUri = `data:${mimeType};base64,${base64Data}`;
  const result  = await cloudinary.uploader.upload(dataUri, {
    folder: 'blow/products',
    transformation: [{ width:800, height:800, crop:'limit', quality:'auto:good' }]
  });
  return { url: result.secure_url, cloudinary_id: result.public_id };
}
async function deletePhoto(cloudinaryId) {
  if (cloudinary && cloudinaryId) {
    try { await cloudinary.uploader.destroy(cloudinaryId); } catch {}
  }
}

// ── MercadoPago ───────────────────────────────
let mp = null;
try {
  mp = require('mercadopago');
  if (process.env.MP_ACCESS_TOKEN && process.env.MP_ACCESS_TOKEN.startsWith('APP_USR-')) {
    mp.configure({ access_token: process.env.MP_ACCESS_TOKEN });
    console.log('✅ MercadoPago listo');
  } else { console.warn('⚠️  MP_ACCESS_TOKEN no configurado'); }
} catch(e) { console.warn('⚠️  mercadopago no instalado'); }

// ── Middlewares ───────────────────────────────

// 🔒 Cargar paquetes de seguridad de forma segura
let helmet = null;
try { helmet = require('helmet'); } catch(e) { console.warn('⚠️  helmet no instalado'); }
let rateLimit = null;
try { rateLimit = require('express-rate-limit'); } catch(e) { console.warn('⚠️  express-rate-limit no instalado'); }

// 🔒 Helmet — cabeceras de seguridad HTTP
if (helmet) app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));

// 🔒 Forzar HTTPS en producción
app.use((req, res, next) => {
  if (process.env.NODE_ENV === 'production' && req.headers['x-forwarded-proto'] !== 'https') {
    return res.redirect(301, 'https://' + req.headers.host + req.url);
  }
  next();
});

// 🔒 Rate limiting
if (rateLimit) {
  const generalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, max: 100,
    message: { error: 'Demasiadas solicitudes. Intentá de nuevo en 15 minutos.' },
    standardHeaders: true, legacyHeaders: false,
    validate: { xForwardedForHeader: false },
  });
  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, max: 10,
    message: { error: 'Demasiados intentos. Esperá 15 minutos antes de intentar de nuevo.' },
    standardHeaders: true, legacyHeaders: false,
    validate: { xForwardedForHeader: false },
  });
  app.use('/api/', generalLimiter);
  app.use('/api/auth/', authLimiter);
}

app.use(cors({ origin: process.env.NODE_ENV === 'production' ? ['https://blow.uy', 'https://www.blow.uy', 'https://blow-app-production.up.railway.app'] : '*' }));
app.use(express.json({ limit: '5mb' })); // reducido de 20mb a 5mb
app.use(express.static(path.join(__dirname, 'public')));

// ── Helpers ───────────────────────────────────
const sign = u => jwt.sign({ id:u.id, name:u.name, email:u.email, role:u.role }, JWT_SECRET, { expiresIn:'7d' });
function auth(req, res, next) {
  const h = req.headers.authorization;
  if (!h || !h.startsWith('Bearer ')) return res.status(401).json({ error:'Token requerido' });
  try { req.user = jwt.verify(h.split(' ')[1], JWT_SECRET); next(); }
  catch { res.status(401).json({ error:'Token inválido' }); }
}
const role = (...roles) => (req, res, next) =>
  roles.includes(req.user && req.user.role) ? next() : res.status(403).json({ error:`Rol requerido: ${roles.join('/')}` });

async function getWallet(ownerId, ownerType) {
  let w = await q1('SELECT * FROM wallets WHERE owner_id=$1', [ownerId]);
  if (!w) {
    const id = uuid();
    await q('INSERT INTO wallets (id,owner_id,owner_type,balance) VALUES ($1,$2,$3,0)', [id, ownerId, ownerType]);
    w = await q1('SELECT * FROM wallets WHERE id=$1', [id]);
  }
  return w;
}
async function credit(ownerId, ownerType, amount, desc, orderId) {
  const w = await getWallet(ownerId, ownerType);
  await q('UPDATE wallets SET balance=balance+$1,updated_at=NOW() WHERE id=$2', [amount, w.id]);
  await q('INSERT INTO transactions (id,wallet_id,type,amount,description,order_id) VALUES ($1,$2,$3,$4,$5,$6)',
    [uuid(), w.id, 'credit', amount, desc, orderId||null]);
}
async function getProductFull(pid) {
  const p = await q1('SELECT * FROM products WHERE id=$1', [pid]);
  if (!p) return null;
  p.photos   = await qa('SELECT id,url,sort_order FROM product_photos WHERE product_id=$1 ORDER BY sort_order', [pid]);
  p.variants = await qa('SELECT * FROM product_variants WHERE product_id=$1 ORDER BY group_name,sort_order', [pid]);
  return p;
}

// ════════════════════════════════════════════════
//  AUTH
// ════════════════════════════════════════════════
// Step 1 — send verification code
// ── Input sanitization ───────────────────────────
function sanitize(str, maxLen=500) {
  if (typeof str !== 'string') return '';
  return str.trim().slice(0, maxLen);
}
function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 200;
}

// ── Email sender via Resend ───────────────────────
async function sendEmail(to, subject, html) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) { console.warn('RESEND_API_KEY no configurado'); return false; }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'Blow <noreply@blow.uy>', to, subject, html })
    });
    const data = await res.json();
    if (!res.ok) { console.error('Resend error:', data); return false; }
    console.log('✅ Email enviado a', to);
    return true;
  } catch(e) { console.error('Email error:', e.message); return false; }
}

app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, email, phone='', password } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error:'Nombre, email y contraseña son obligatorios' });
    if (password.length < 6) return res.status(400).json({ error:'La contraseña debe tener al menos 6 caracteres' });
    const emailLow = email.toLowerCase().trim();
    if (await q1('SELECT id FROM users WHERE email=$1', [emailLow])) return res.status(409).json({ error:'Este email ya está registrado' });

    // Generate 6-digit code
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const id = uuid();
    const hashed = await bcrypt.hash(password, 10);
    // Delete previous pending for same email
    await q('DELETE FROM email_verifications WHERE email=$1', [emailLow]);
    await q('INSERT INTO email_verifications (id,email,code,data) VALUES ($1,$2,$3,$4)',
      [id, emailLow, code, JSON.stringify({ name:name.trim(), email:emailLow, phone, password:hashed })]);

    const emailSent = await sendEmail(emailLow, 'Tu código de verificación — Blow',
      `<div style="font-family:sans-serif;max-width:400px;margin:0 auto;padding:32px;">
        <h2 style="color:#FA0050;">⚡ Blow</h2>
        <p>Hola <strong>${name}</strong>, tu código de verificación es:</p>
        <div style="font-size:40px;font-weight:900;letter-spacing:8px;color:#FA0050;text-align:center;padding:24px;background:#fff5f7;border-radius:12px;margin:20px 0;">${code}</div>
        <p style="color:#888;font-size:13px;">Válido por 15 minutos. Si no creaste esta cuenta ignorá este mensaje.</p>
      </div>`);

    if (emailSent) {
      res.status(200).json({ pending: true, message:'Código enviado a ' + emailLow });
    } else {
      // SMTP not configured — auto-verify (dev/demo mode)
      await q('DELETE FROM email_verifications WHERE email=$1', [emailLow]);
      const uid = uuid();
      const data = { name:name.trim(), email:emailLow, phone, password:hashed };
      await q('INSERT INTO users (id,name,email,phone,password,role) VALUES ($1,$2,$3,$4,$5,$6)',
        [uid, data.name, data.email, data.phone, data.password, 'customer']);
      const user = { id:uid, name:data.name, email:data.email, role:'customer' };
      res.status(201).json({ token:sign(user), user });
    }
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// Step 2 — verify code
app.post('/api/auth/verify-email', async (req, res) => {
  try {
    const { email, code } = req.body;
    const emailLow = email.toLowerCase().trim();
    const row = await q1('SELECT * FROM email_verifications WHERE email=$1 AND expires_at > NOW()', [emailLow]);
    if (!row) return res.status(400).json({ error:'Código expirado o no encontrado. Intentá registrarte de nuevo.' });
    if (row.code !== code.trim()) return res.status(400).json({ error:'Código incorrecto' });
    const data = row.data;
    const id = uuid();
    await q('INSERT INTO users (id,name,email,phone,password,role) VALUES ($1,$2,$3,$4,$5,$6)',
      [id, data.name, data.email, data.phone||'', data.password, 'customer']);
    await q('DELETE FROM email_verifications WHERE email=$1', [emailLow]);
    const user = { id, name:data.name, email:data.email, role:'customer' };
    res.status(201).json({ token:sign(user), user });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error:'Email y contraseña requeridos' });
    if (typeof email !== 'string' || email.length > 200) return res.status(400).json({ error:'Email inválido' });
    if (typeof password !== 'string' || password.length > 200) return res.status(400).json({ error:'Contraseña inválida' });
    const emailLow = email.toLowerCase().trim();
    const u = await q1('SELECT * FROM users WHERE email=$1', [emailLow]);
    if (!u || !(await bcrypt.compare(password, u.password))) {
      console.warn(`⚠️  Login fallido: ${emailLow} — IP: ${req.ip}`);
      return res.status(401).json({ error:'Email o contraseña incorrectos' });
    }
    res.json({ token:sign(u), user:{ id:u.id, name:u.name, email:u.email, role:u.role } });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

app.get('/api/auth/me', auth, async (req, res) => {
  const u = await q1('SELECT id,name,email,phone,role,address,city,department FROM users WHERE id=$1', [req.user.id]);
  if (!u) return res.json({ error:'No encontrado' });
  u.addresses = await qa('SELECT * FROM user_addresses WHERE user_id=$1 ORDER BY is_active DESC,created_at DESC', [req.user.id]);
  res.json(u);
});

app.patch('/api/auth/me', auth, async (req, res) => {
  const { name, phone, address, city, department } = req.body;
  await q('UPDATE users SET name=COALESCE($1,name),phone=COALESCE($2,phone),address=COALESCE($3,address),city=COALESCE($4,city),department=COALESCE($5,department) WHERE id=$6',
    [name, phone, address, city, department, req.user.id]);
  res.json(await q1('SELECT id,name,email,phone,role,address,city,department FROM users WHERE id=$1', [req.user.id]));
});

// ════════════════════════════════════════════════
//  DIRECCIONES
// ════════════════════════════════════════════════
app.get('/api/addresses', auth, async (req, res) =>
  res.json(await qa('SELECT * FROM user_addresses WHERE user_id=$1 ORDER BY is_active DESC,created_at DESC', [req.user.id])));

app.post('/api/addresses', auth, async (req, res) => {
  const { label, full_address, city, department='', lat=null, lng=null } = req.body;
  if (!full_address || !city) return res.status(400).json({ error:'full_address y city son obligatorios' });
  const cnt = await q1('SELECT COUNT(*) as c FROM user_addresses WHERE user_id=$1', [req.user.id]);
  const isFirst = parseInt(cnt.c) === 0;
  const id = uuid();
  await q('INSERT INTO user_addresses (id,user_id,label,full_address,city,department,lat,lng,is_active) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [id, req.user.id, label||'Mi dirección', full_address.trim(), city.trim(), department, lat, lng, isFirst]);
  if (isFirst) await q('UPDATE users SET city=$1,department=$2 WHERE id=$3', [city.trim(), department, req.user.id]);
  res.status(201).json(await q1('SELECT * FROM user_addresses WHERE id=$1', [id]));
});

app.post('/api/addresses/:id/activate', auth, async (req, res) => {
  const addr = await q1('SELECT * FROM user_addresses WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id]);
  if (!addr) return res.status(404).json({ error:'Dirección no encontrada' });
  await q('UPDATE user_addresses SET is_active=FALSE WHERE user_id=$1', [req.user.id]);
  await q('UPDATE user_addresses SET is_active=TRUE WHERE id=$1', [req.params.id]);
  await q('UPDATE users SET city=$1,department=$2,address=$3 WHERE id=$4', [addr.city, addr.department, addr.full_address, req.user.id]);
  res.json({ success:true, active: await q1('SELECT * FROM user_addresses WHERE id=$1', [req.params.id]) });
});

app.delete('/api/addresses/:id', auth, async (req, res) => {
  const addr = await q1('SELECT * FROM user_addresses WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id]);
  if (!addr) return res.status(404).json({ error:'No encontrada' });
  await q('DELETE FROM user_addresses WHERE id=$1', [req.params.id]);
  if (addr.is_active) {
    const next = await q1('SELECT * FROM user_addresses WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1', [req.user.id]);
    if (next) {
      await q('UPDATE user_addresses SET is_active=TRUE WHERE id=$1', [next.id]);
      await q('UPDATE users SET city=$1,department=$2,address=$3 WHERE id=$4', [next.city, next.department, next.full_address, req.user.id]);
    }
  }
  res.json({ success:true });
});

// ════════════════════════════════════════════════
//  NEGOCIOS
// ════════════════════════════════════════════════
app.get('/api/businesses', async (req, res) => {
  const { category, city, department } = req.query;
  let sql = `SELECT b.* FROM businesses b
    JOIN subscriptions s ON s.business_id = b.id
    WHERE s.status = 'active'`;
  const params = [];
  let i = 1;
  if (category)   { sql += ` AND b.category=$${i++}`;               params.push(category); }
  if (city)       { sql += ` AND LOWER(b.city)=LOWER($${i++})`;    params.push(city); }
  if (department) { sql += ` AND LOWER(b.department)=LOWER($${i++})`; params.push(department); }
  sql += ` ORDER BY b.blow_plus DESC NULLS LAST, b.created_at DESC`;
  const rows = await qa(sql, params);
  const result = await Promise.all(rows.map(async b => ({
    ...b,
    product_count: parseInt((await q1('SELECT COUNT(*) as c FROM products WHERE business_id=$1 AND is_available=TRUE',[b.id])).c),
  })));
  res.json(result);
});

// Public APIs
app.get('/api/plans', async (_, res) => {
  const plans = await qa('SELECT * FROM subscription_plans WHERE is_active=TRUE ORDER BY sort_order',[]);
  res.json(plans.map(p => ({
    ...p,
    features: (() => { try { return JSON.parse(p.features||'[]'); } catch { return []; } })()
  })));
});
app.get('/api/business-categories', async (_, res) => {
  res.json(await qa('SELECT * FROM business_categories WHERE is_active=TRUE ORDER BY sort_order',[]));
});

// ── Admin: business categories CRUD ──
app.get('/api/admin/business-categories', auth, role('admin'), async (req, res) => {
  res.json(await qa('SELECT * FROM business_categories ORDER BY sort_order',[]));
});
app.post('/api/admin/business-categories', auth, role('admin'), async (req, res) => {
  const { name, emoji='🏪', sort_order=99 } = req.body;
  if (!name) return res.status(400).json({ error:'name requerido' });
  const id = 'cat-' + uuid().slice(0,8);
  await q('INSERT INTO business_categories (id,name,emoji,sort_order) VALUES ($1,$2,$3,$4)',[id,name,emoji,sort_order]);
  res.json({ success:true, id });
});
app.patch('/api/admin/business-categories/:id', auth, role('admin'), async (req, res) => {
  const { name, emoji, sort_order, is_active } = req.body;
  const updates=[]; const params=[]; let i=1;
  if (name!==undefined)       { updates.push(`name=$${i++}`);       params.push(name); }
  if (emoji!==undefined)      { updates.push(`emoji=$${i++}`);      params.push(emoji); }
  if (sort_order!==undefined) { updates.push(`sort_order=$${i++}`); params.push(sort_order); }
  if (is_active!==undefined)  { updates.push(`is_active=$${i++}`);  params.push(is_active); }
  if (!updates.length) return res.status(400).json({ error:'Nada que actualizar' });
  params.push(req.params.id);
  await q(`UPDATE business_categories SET ${updates.join(',')} WHERE id=$${i}`, params);
  res.json({ success:true });
});
app.delete('/api/admin/business-categories/:id', auth, role('admin'), async (req, res) => {
  await q('DELETE FROM business_categories WHERE id=$1',[req.params.id]);
  res.json({ success:true });
});

// ── Admin: subscription plans CRUD ──
app.get('/api/admin/subscription-plans', auth, role('admin'), async (req, res) => {
  res.json(await qa('SELECT * FROM subscription_plans ORDER BY sort_order',[]));
});
app.post('/api/admin/subscription-plans', auth, role('admin'), async (req, res) => {
  const { name, price, description='', sort_order=99, features='[]' } = req.body;
  if (!name || price===undefined) return res.status(400).json({ error:'name y price requeridos' });
  const id = 'plan-' + uuid().slice(0,8);
  const featStr = typeof features==='string' ? features : JSON.stringify(features);
  await q('INSERT INTO subscription_plans (id,name,price,description,features,sort_order) VALUES ($1,$2,$3,$4,$5,$6)',[id,name,price,description,featStr,sort_order]);
  res.json({ success:true, id });
});
app.patch('/api/admin/subscription-plans/:id', auth, role('admin'), async (req, res) => {
  const { name, price, description, features, is_active, sort_order } = req.body;
  const updates=[]; const params=[]; let i=1;
  if (name!==undefined)        { updates.push(`name=$${i++}`);        params.push(name); }
  if (price!==undefined)       { updates.push(`price=$${i++}`);       params.push(price); }
  if (description!==undefined) { updates.push(`description=$${i++}`); params.push(description); }
  if (features!==undefined)    { updates.push(`features=$${i++}`);    params.push(typeof features==='string'?features:JSON.stringify(features)); }
  if (is_active!==undefined)   { updates.push(`is_active=$${i++}`);   params.push(is_active); }
  if (sort_order!==undefined)  { updates.push(`sort_order=$${i++}`);  params.push(sort_order); }
  if (!updates.length) return res.status(400).json({ error:'Nada que actualizar' });
  params.push(req.params.id);
  await q(`UPDATE subscription_plans SET ${updates.join(',')},updated_at=NOW() WHERE id=$${i}`, params);
  res.json({ success:true });
});
app.delete('/api/admin/subscription-plans/:id', auth, role('admin'), async (req, res) => {
  await q('DELETE FROM subscription_plans WHERE id=$1',[req.params.id]);
  res.json({ success:true });
});

app.get('/api/businesses/mine/dashboard', auth, role('owner'), async (req, res) => {
  const b = await q1('SELECT * FROM businesses WHERE owner_id=$1', [req.user.id]);
  if (!b) return res.status(404).json({ error:'No tenés ningún negocio registrado aún' });
  const rawP     = await qa('SELECT * FROM products WHERE business_id=$1 ORDER BY created_at DESC', [b.id]);
  const products = await Promise.all(rawP.map(async p => ({
    ...p,
    photos:   await qa('SELECT id,url,sort_order FROM product_photos WHERE product_id=$1 ORDER BY sort_order',[p.id]),
    variants: await qa('SELECT * FROM product_variants WHERE product_id=$1 ORDER BY group_name,sort_order',[p.id]),
  })));
  const categories  = await qa('SELECT * FROM product_categories WHERE business_id=$1 ORDER BY sort_order',[b.id]);
  const orders      = await qa(`SELECT o.*,u.name as customer_name,u.phone as customer_phone FROM orders o JOIN users u ON o.customer_id=u.id WHERE o.business_id=$1 ORDER BY o.created_at DESC LIMIT 50`,[b.id]);
  const wallet      = await q1('SELECT * FROM wallets WHERE owner_id=$1',[b.id]) || { balance:0, id:null };
  const transactions= wallet.id ? await qa('SELECT * FROM transactions WHERE wallet_id=$1 ORDER BY created_at DESC LIMIT 30',[wallet.id]) : [];
  const withdrawals = await qa('SELECT * FROM withdrawals WHERE owner_id=$1 ORDER BY created_at DESC',[req.user.id]);
  const today       = await q1(`SELECT COUNT(*) as orders,COALESCE(SUM(total),0) as revenue FROM orders WHERE business_id=$1 AND DATE(created_at)=CURRENT_DATE AND status NOT IN ('cancelled','pending')`,[b.id]);
  const week        = await q1(`SELECT COUNT(*) as orders,COALESCE(SUM(total),0) as revenue FROM orders WHERE business_id=$1 AND created_at>=NOW()-INTERVAL '7 days' AND status NOT IN ('cancelled','pending')`,[b.id]);
  res.json({ business:b, products, categories, orders, balance:parseFloat(wallet.balance)||0, transactions, withdrawals, today, week });
});





app.patch('/api/businesses/mine', auth, role('owner'), async (req, res) => {
  const b = await q1('SELECT * FROM businesses WHERE owner_id=$1',[req.user.id]);
  if (!b) return res.status(404).json({ error:'No tenés ningún negocio' });
  const { name, category, address, phone, logo_emoji, delivery_cost, is_open, plan, delivery_time, city, department } = req.body;
  await q(`UPDATE businesses SET name=COALESCE($1,name),category=COALESCE($2,category),address=COALESCE($3,address),phone=COALESCE($4,phone),logo_emoji=COALESCE($5,logo_emoji),delivery_cost=COALESCE($6,delivery_cost),is_open=COALESCE($7,is_open),plan=COALESCE($8,plan),delivery_time=COALESCE($9,delivery_time),city=COALESCE($10,city),department=COALESCE($11,department) WHERE owner_id=$12`,
    [name,category,address,phone,logo_emoji,delivery_cost,is_open!=null?Boolean(is_open):null,plan,delivery_time,city,department,req.user.id]);
  res.json(await q1('SELECT * FROM businesses WHERE owner_id=$1',[req.user.id]));
});

// ════════════════════════════════════════════════
//  CATEGORÍAS
// ════════════════════════════════════════════════
app.get('/api/businesses/mine/categories', auth, role('owner'), async (req, res) => {
  const b = await q1('SELECT id FROM businesses WHERE owner_id=$1',[req.user.id]);
  if (!b) return res.status(404).json({ error:'Sin negocio' });
  res.json(await qa('SELECT * FROM product_categories WHERE business_id=$1 ORDER BY sort_order',[b.id]));
});
app.post('/api/businesses/mine/categories', auth, role('owner'), async (req, res) => {
  const b = await q1('SELECT id FROM businesses WHERE owner_id=$1',[req.user.id]);
  if (!b) return res.status(404).json({ error:'Sin negocio' });
  const { name, parent_id=null, sort_order=0 } = req.body;
  if (!name) return res.status(400).json({ error:'name es obligatorio' });
  const id = uuid();
  await q('INSERT INTO product_categories (id,business_id,parent_id,name,sort_order) VALUES ($1,$2,$3,$4,$5)',[id,b.id,parent_id||null,name.trim(),sort_order]);
  res.status(201).json(await q1('SELECT * FROM product_categories WHERE id=$1',[id]));
});
app.patch('/api/businesses/mine/categories/:cid', auth, role('owner'), async (req, res) => {
  const b = await q1('SELECT id FROM businesses WHERE owner_id=$1',[req.user.id]);
  if (!b) return res.status(404).json({ error:'Sin negocio' });
  const { name, parent_id, sort_order } = req.body;
  await q('UPDATE product_categories SET name=COALESCE($1,name),parent_id=COALESCE($2,parent_id),sort_order=COALESCE($3,sort_order) WHERE id=$4 AND business_id=$5',
    [name,parent_id,sort_order,req.params.cid,b.id]);
  res.json(await q1('SELECT * FROM product_categories WHERE id=$1',[req.params.cid]));
});
app.delete('/api/businesses/mine/categories/:cid', auth, role('owner'), async (req, res) => {
  const b = await q1('SELECT id FROM businesses WHERE owner_id=$1',[req.user.id]);
  if (!b) return res.status(404).json({ error:'Sin negocio' });
  const cat = await q1('SELECT * FROM product_categories WHERE id=$1',[req.params.cid]);
  if (cat) await q('UPDATE product_categories SET parent_id=$1 WHERE parent_id=$2',[cat.parent_id,req.params.cid]);
  await q('UPDATE products SET category_id=NULL WHERE category_id=$1 AND business_id=$2',[req.params.cid,b.id]);
  await q('DELETE FROM product_categories WHERE id=$1 AND business_id=$2',[req.params.cid,b.id]);
  res.json({ success:true });
});

// ════════════════════════════════════════════════
//  PRODUCTOS
// ════════════════════════════════════════════════
app.post('/api/businesses/mine/products', auth, role('owner'), async (req, res) => {
  const b = await q1('SELECT * FROM businesses WHERE owner_id=$1',[req.user.id]);
  if (!b) return res.status(404).json({ error:'Registrá tu negocio primero' });
  // Check subscription is active before adding products
  const sub = await q1('SELECT * FROM subscriptions WHERE business_id=$1',[b.id]);
  if (!sub || sub.status !== 'active')
    return res.status(403).json({ error:'Tu suscripción está suspendida. Renovála para agregar productos.' });
  const { name, description='', price, emoji='🍽️', category_id=null, photos=[], variants=[], discount_percent=0 } = req.body;
  if (!name || price === undefined) return res.status(400).json({ error:'name y price son obligatorios' });
  const id = uuid();
  await q('INSERT INTO products (id,business_id,category_id,emoji,name,description,price) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [id,b.id,category_id||null,emoji,name.trim(),description,parseFloat(price)]);
  for (let i=0;i<Math.min(photos.length,4);i++) {
    try { const up=await uploadPhoto(photos[i].data,photos[i].mime_type||'image/jpeg'); await q('INSERT INTO product_photos (id,product_id,url,cloudinary_id,sort_order) VALUES ($1,$2,$3,$4,$5)',[uuid(),id,up.url,up.cloudinary_id,i]); }
    catch(e) { console.error('Photo error:',e.message); }
  }
  for (let i=0;i<variants.length;i++) {
    const v=variants[i]; await q('INSERT INTO product_variants (id,product_id,group_name,option_name,price_delta,sort_order) VALUES ($1,$2,$3,$4,$5,$6)',[uuid(),id,v.group_name,v.option_name,parseFloat(v.price_delta)||0,i]);
  }
  res.status(201).json(await getProductFull(id));
});

app.patch('/api/businesses/mine/products/:pid', auth, role('owner'), async (req, res) => {
  const b = await q1('SELECT id FROM businesses WHERE owner_id=$1',[req.user.id]);
  if (!b) return res.status(404).json({ error:'No tenés ningún negocio' });
  const { name, description, price, emoji, is_available, is_featured, discount_percent, category_id, photos, variants } = req.body;
  await q(`UPDATE products SET name=COALESCE($1,name),description=COALESCE($2,description),price=COALESCE($3,price),emoji=COALESCE($4,emoji),is_available=COALESCE($5,is_available),category_id=COALESCE($6,category_id),is_featured=COALESCE($7,is_featured),discount_percent=COALESCE($8,discount_percent) WHERE id=$9 AND business_id=$10`,
    [name,description,price!=null?parseFloat(price):null,emoji,is_available!=null?Boolean(is_available):null,category_id||null,is_featured!=null?Boolean(is_featured):null,discount_percent!=null?parseInt(discount_percent):null,req.params.pid,b.id]);
  if (Array.isArray(photos) && photos.length > 0) {
    const old = await qa('SELECT cloudinary_id FROM product_photos WHERE product_id=$1',[req.params.pid]);
    await q('DELETE FROM product_photos WHERE product_id=$1',[req.params.pid]);
    for (const ph of old) await deletePhoto(ph.cloudinary_id);
    for (let i=0;i<Math.min(photos.length,4);i++) {
      try { const up=await uploadPhoto(photos[i].data,photos[i].mime_type||'image/jpeg'); await q('INSERT INTO product_photos (id,product_id,url,cloudinary_id,sort_order) VALUES ($1,$2,$3,$4,$5)',[uuid(),req.params.pid,up.url,up.cloudinary_id,i]); }
      catch(e) { console.error('Photo error:',e.message); }
    }
  }
  if (Array.isArray(variants)) {
    await q('DELETE FROM product_variants WHERE product_id=$1',[req.params.pid]);
    for (let i=0;i<variants.length;i++) {
      const v=variants[i]; await q('INSERT INTO product_variants (id,product_id,group_name,option_name,price_delta,sort_order) VALUES ($1,$2,$3,$4,$5,$6)',[uuid(),req.params.pid,v.group_name,v.option_name,parseFloat(v.price_delta)||0,i]);
    }
  }
  res.json(await getProductFull(req.params.pid));
});

app.delete('/api/businesses/mine/products/:pid', auth, role('owner'), async (req, res) => {
  const b = await q1('SELECT id FROM businesses WHERE owner_id=$1',[req.user.id]);
  if (!b) return res.status(404).json({ error:'No tenés ningún negocio' });
  await q('UPDATE products SET is_available=FALSE WHERE id=$1 AND business_id=$2',[req.params.pid,b.id]);
  res.json({ success:true });
});

// ════════════════════════════════════════════════
//  SUSCRIPCIONES — Plan único $2.990/mes
// ════════════════════════════════════════════════

// Step 1: Pre-registration — store data and create MP payment link
// Called BEFORE creating the account
// MP preapproval dates must be in format: YYYY-MM-DDTHH:mm:ss.sss-HH:MM
function mpDate(date) {
  const d = new Date(date);
  const pad = n => String(n).padStart(2,'0');
  const ms = String(d.getUTCMilliseconds()).padStart(3,'0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth()+1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.${ms}-00:00`;
}

app.post('/api/register/initiate', async (req, res) => {
  try {
    const { bizName, category, address='', city, department='', name, email, password, phone='' } = req.body;
    if (!bizName||!name||!email||!password||!city)
      return res.status(400).json({ error:'Completá todos los campos obligatorios' });
    if (password.length < 6)
      return res.status(400).json({ error:'La contraseña debe tener al menos 6 caracteres' });
    const emailLow = email.toLowerCase().trim();
    if (await q1('SELECT id FROM users WHERE email=$1',[emailLow]))
      return res.status(409).json({ error:'Este email ya está registrado' });

    const regId = uuid();
    await q('INSERT INTO pending_registrations (id,data) VALUES ($1,$2)',
      [regId, JSON.stringify({ bizName,category,address,city,department,name,email:emailLow,password,phone })]);

    // ── MODO GRATUITO TEMPORAL — skip payment ──
    return res.json({ reg_id: regId, demo: true });

    // ── Preapproval: recurring subscription ── (desactivado temporalmente)
    // eslint-disable-next-line no-unreachable
    const backUrl = `${APP_URL}/owner`;
    console.log('🔗 Preapproval back_url:', backUrl);
    const preapproval = await mp.preapproval.create({
      reason: `Blow — Plan mensual negocios`,
      external_reference: `reg:${regId}`,
      payer_email: emailLow,
      auto_recurring: {
        frequency: 1,
        frequency_type: 'months',
        transaction_amount: PLAN_PRICE,
        currency_id: 'UYU',
        start_date: mpDate(Date.now()),
        end_date: mpDate(Date.now() + 1000*60*60*24*365*5),
      },
      back_url: backUrl,
      notification_url: `${APP_URL}/api/webhooks/mp`,
    });

    await q('UPDATE pending_registrations SET mp_preference_id=$1 WHERE id=$2',
      [preapproval.body.id, regId]);
    res.json({ reg_id: regId, init_point: preapproval.body.init_point });
  } catch(e) { console.error('Register initiate error:', e); res.status(500).json({ error: e.message }); }
});

// Step 2: Complete registration after payment confirmed
app.post('/api/register/complete', async (req, res) => {
  try {
    const { reg_id } = req.body;
    const pending = await q1('SELECT * FROM pending_registrations WHERE id=$1',[reg_id]);
    if (!pending) return res.status(404).json({ error:'Registro no encontrado o expirado' });

    const d = typeof pending.data === 'string' ? JSON.parse(pending.data) : pending.data;

    // Case 1: Webhook already completed registration — just return token
    if (pending.status === 'completed') {
      const existingUser = await q1('SELECT * FROM users WHERE email=$1',[d.email]);
      if (existingUser) {
        const u = { id:existingUser.id, name:existingUser.name, email:existingUser.email, role:'owner' };
        return res.json({ token:sign(u), user:u, message:'¡Bienvenido a Blow!' });
      }
    }

    // Case 2: Expired
    if (pending.status === 'pending' && pending.expires_at && new Date() > new Date(pending.expires_at))
      return res.status(400).json({ error:'El registro expiró. Intentá de nuevo.' });

    // Case 3: Not yet paid
    if (pending.status === 'pending')
      return res.status(402).json({ error:'El pago aún no fue confirmado. Esperá unos segundos y reintentá.' });

    // Case 4: Complete manually (fallback if webhook didn't arrive)
    const alreadyExists = await q1('SELECT * FROM users WHERE email=$1',[d.email]);
    if (alreadyExists) {
      const u = { id:alreadyExists.id, name:alreadyExists.name, email:alreadyExists.email, role:'owner' };
      return res.json({ token:sign(u), user:u, message:'¡Bienvenido a Blow!' });
    }

    const userId = uuid();
    await q('INSERT INTO users (id,name,email,phone,password,role,city,department) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [userId, d.name, d.email, d.phone||'', await bcrypt.hash(d.password,10), 'owner', d.city, d.department||'']);
    const bizId = uuid();
    await q('INSERT INTO businesses (id,owner_id,name,category,address,city,department) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [bizId, userId, d.bizName, d.category, d.address||'', d.city, d.department||'']);
    const periodEnd = new Date(); periodEnd.setMonth(periodEnd.getMonth()+1);
    const preapprovalId = pending.mp_preference_id || null;
    await q(`INSERT INTO subscriptions (id,business_id,owner_id,plan,status,mp_preapproval_id,current_period_start,current_period_end)
      VALUES ($1,$2,$3,'active','active',$4,NOW(),$5)`,
      [uuid(), bizId, userId, preapprovalId, periodEnd.toISOString()]);
    await q('DELETE FROM pending_registrations WHERE id=$1',[reg_id]);

    const u = { id:userId, name:d.name, email:d.email, role:'owner' };
    res.status(201).json({ token:sign(u), user:u, message:'¡Cuenta creada! Bienvenido a Blow.' });
  } catch(e) { console.error('Register complete error:', e); res.status(500).json({ error: e.message }); }
});

// Get subscription status (for existing owners)
app.get('/api/subscription', auth, role('owner'), async (req, res) => {
  const b = await q1('SELECT * FROM businesses WHERE owner_id=$1',[req.user.id]);
  if (!b) return res.status(404).json({ error:'Sin negocio' });
  const sub = await q1('SELECT * FROM subscriptions WHERE business_id=$1',[b.id]);
  res.json({ subscription: sub, plan_price: PLAN_PRICE });
});

// Renew/reactivate subscription (for suspended accounts)
app.post('/api/subscription/renew', auth, role('owner'), async (req, res) => {
  const b = await q1('SELECT * FROM businesses WHERE owner_id=$1',[req.user.id]);
  if (!b) return res.status(404).json({ error:'Sin negocio' });
  const owner = await q1('SELECT * FROM users WHERE id=$1',[req.user.id]);

  if (!mp || !process.env.MP_ACCESS_TOKEN?.startsWith('APP_USR-')) {
    // Demo — reactivate immediately
    const periodEnd = new Date(); periodEnd.setMonth(periodEnd.getMonth()+1);
    await q(`INSERT INTO subscriptions (id,business_id,owner_id,plan,status,current_period_end)
      VALUES ($1,$2,$3,'active','active',$4)
      ON CONFLICT (business_id) DO UPDATE SET status='active',current_period_start=NOW(),current_period_end=$4,updated_at=NOW()`,
      [uuid(), b.id, req.user.id, periodEnd.toISOString()]);
    return res.json({ success:true, demo:true });
  }

  // If existing preapproval, reactivate it
  const sub = await q1('SELECT mp_preapproval_id FROM subscriptions WHERE business_id=$1',[b.id]);
  if (sub?.mp_preapproval_id) {
    try {
      await mp.preapproval.update(sub.mp_preapproval_id, { status: 'authorized' });
      const periodEnd = new Date(); periodEnd.setMonth(periodEnd.getMonth()+1);
      await q(`UPDATE subscriptions SET status='active',current_period_start=NOW(),current_period_end=$1,updated_at=NOW() WHERE business_id=$2`,
        [periodEnd.toISOString(), b.id]);
      return res.json({ success:true, reactivated:true });
    } catch(e) { /* fall through to new preapproval */ }
  }

  // New preapproval for first-time or expired
  const preapproval = await mp.preapproval.create({
    reason: `Blow — Plan mensual negocios`,
    external_reference: `renew:${b.id}`,
    payer_email: owner.email,
    auto_recurring: {
      frequency: 1,
      frequency_type: 'months',
      transaction_amount: PLAN_PRICE,
      currency_id: 'UYU',
      start_date: mpDate(Date.now()),
      end_date: mpDate(Date.now() + 1000*60*60*24*365*5),
    },
    back_url: `${APP_URL}/owner`,
    notification_url: `${APP_URL}/api/webhooks/mp`,
  });
  res.json({ init_point: preapproval.body.init_point });
});

// Cancel subscription
app.post('/api/subscription/cancel', auth, role('owner'), async (req, res) => {
  const b = await q1('SELECT * FROM businesses WHERE owner_id=$1',[req.user.id]);
  if (!b) return res.status(404).json({ error:'Sin negocio' });
  const sub = await q1('SELECT mp_preapproval_id FROM subscriptions WHERE business_id=$1',[b.id]);
  // Cancel preapproval on MercadoPago so no future charges
  if (sub?.mp_preapproval_id && mp) {
    try { await mp.preapproval.update(sub.mp_preapproval_id, { status: 'cancelled' }); } catch(e) {}
  }
  await q("UPDATE subscriptions SET status='cancelled',cancelled_at=NOW(),updated_at=NOW() WHERE business_id=$1",[b.id]);
  notify(req.user.id, { type:'subscription_cancelled', message:'❌ Suscripción cancelada. Tu negocio quedará invisible al final del período.' });
  res.json({ success:true });
});

// Admin — view all subscriptions
app.get('/api/admin/subscriptions', auth, role('admin'), async (req, res) => {
  res.json(await qa(`SELECT s.*,b.name as business_name,u.email as owner_email,u.name as owner_name
    FROM subscriptions s
    JOIN businesses b ON s.business_id=b.id
    JOIN users u ON s.owner_id=u.id
    ORDER BY s.created_at DESC`,[]));
});
// Admin — manually activate a subscription
app.post('/api/admin/subscriptions/:id/activate', auth, role('admin'), async (req, res) => {
  const periodEnd = new Date(); periodEnd.setMonth(periodEnd.getMonth()+1);
  await q("UPDATE subscriptions SET status='active',current_period_start=NOW(),current_period_end=$1,updated_at=NOW() WHERE id=$2",
    [periodEnd.toISOString(), req.params.id]);
  res.json({ success:true });
});
// Admin — suspend a subscription
app.post('/api/admin/subscriptions/:id/suspend', auth, role('admin'), async (req, res) => {
  await q("UPDATE subscriptions SET status='suspended',updated_at=NOW() WHERE id=$1",[req.params.id]);
  res.json({ success:true });
});

// ════════════════════════════════════════════════
//  PEDIDOS
// ════════════════════════════════════════════════
app.post('/api/orders', auth, role('customer'), async (req, res) => {
  try {
    const { business_id, items, address } = req.body;
    if (!business_id || !items || !items.length) return res.status(400).json({ error:'business_id e items son obligatorios' });
    const biz = await q1('SELECT * FROM businesses WHERE id=$1',[business_id]);
    if (!biz) return res.status(404).json({ error:'Negocio no encontrado' });
    if (!biz.is_open) return res.status(400).json({ error:'Este negocio está cerrado' });
    let subtotal = 0; const lineItems = [];
    for (const item of items) {
      const p = await q1('SELECT * FROM products WHERE id=$1 AND business_id=$2 AND is_available=TRUE',[item.product_id,business_id]);
      if (!p) return res.status(400).json({ error:'Producto no disponible' });
      const qty = parseInt(item.quantity)||1;
      let unitPrice = p.price; let variantLabel = '';
      if (item.variant_id) {
        const v = await q1('SELECT * FROM product_variants WHERE id=$1 AND product_id=$2',[item.variant_id,p.id]);
        if (v) { unitPrice += v.price_delta; variantLabel = `${v.group_name}: ${v.option_name}`; }
      }
      subtotal += unitPrice * qty;
      lineItems.push({ ...p, quantity:qty, unit_price:unitPrice, variant_label:variantLabel });
    }
    const _ubp = await q1('SELECT blow_plus, blow_plus_expires FROM users WHERE id=$1',[req.user.id]);
    const userBP = _ubp && _ubp.blow_plus && (!_ubp.blow_plus_expires || new Date(_ubp.blow_plus_expires) > new Date());
    const fulfillment_type = req.body.fulfillment_type || 'delivery';
    const baseFee = fulfillment_type === 'pickup' ? 0 : (biz.custom_delivery_cost ?? biz.delivery_cost ?? 0);
    const fee = (userBP && biz.blow_plus_free_delivery && fulfillment_type === 'delivery') ? 0 : baseFee;
    const total=subtotal+fee;
    const _fee=await getPlatformFee();
      const plat=parseFloat((subtotal*_fee).toFixed(2)), bizAmt=parseFloat((subtotal-plat).toFixed(2));
    const orderId=uuid();
    const cust=await q1('SELECT * FROM users WHERE id=$1',[req.user.id]);
    await q(`INSERT INTO orders (id,customer_id,business_id,status,subtotal,delivery_fee,total,address,business_amount,delivery_amount,platform_amount) VALUES ($1,$2,$3,'pending',$4,$5,$6,$7,$8,$9,$10)`,
      [orderId,req.user.id,business_id,subtotal,fee,total,address||cust.address||'',bizAmt,fee,plat]);
    for (const i of lineItems) {
      const n = i.variant_label ? `${i.name} (${i.variant_label})` : i.name;
      await q('INSERT INTO order_items (id,order_id,product_id,name,emoji,price,quantity) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [uuid(),orderId,i.id,n,i.emoji||'🍽️',i.unit_price,i.quantity]);
    }
    notify(biz.owner_id,{ type:'new_order',message:`🔔 Nuevo pedido #${orderId.slice(-6).toUpperCase()} — $${total}`,order_id:orderId,total });
    if (mp && process.env.MP_ACCESS_TOKEN && process.env.MP_ACCESS_TOKEN.startsWith('APP_USR-')) {
      const pref = await mp.preferences.create({
        items: lineItems.map(i=>({ title:i.name,quantity:i.quantity,unit_price:i.unit_price,currency_id:'UYU' })),
        payer: { name:cust.name,email:cust.email },
        external_reference: orderId,
        back_urls:{ success:`${APP_URL}/?payment=success`,failure:`${APP_URL}/?payment=failure`,pending:`${APP_URL}/?payment=pending` },
        auto_return:'approved',
        notification_url:`${APP_URL}/api/webhooks/mp`,
      });
      res.json({ order_id:orderId,payment:{ id:pref.body.id,init_point:pref.body.init_point } });
    } else {
      await q(`UPDATE orders SET status='confirmed',updated_at=NOW() WHERE id=$1`,[orderId]);
      notify(biz.owner_id,{ type:'new_order',message:`💰 Pedido confirmado #${orderId.slice(-6).toUpperCase()}`,order_id:orderId,total });
      notify(req.user.id,{ type:'status_change',message:'✅ Pedido confirmado (modo demo)',status:'confirmed',order_id:orderId });
      res.json({ order_id:orderId,demo:true });
    }
  } catch(e) { console.error(e); res.status(500).json({ error:e.message }); }
});

app.get('/api/orders', auth, async (req, res) => {
  let orders;
  if (req.user.role==='customer') orders=await qa('SELECT o.*,b.name as business_name,b.logo_emoji FROM orders o JOIN businesses b ON o.business_id=b.id WHERE o.customer_id=$1 ORDER BY o.created_at DESC',[req.user.id]);
  else if (req.user.role==='delivery') orders=await qa(`SELECT o.*,b.name as business_name,b.address as business_address,u.name as customer_name,u.phone as customer_phone FROM orders o JOIN businesses b ON o.business_id=b.id JOIN users u ON o.customer_id=u.id WHERE o.status IN ('ready','on_way') OR o.delivery_id=$1 ORDER BY o.created_at DESC`,[req.user.id]);
  else orders=await qa('SELECT o.*,b.name as business_name FROM orders o JOIN businesses b ON o.business_id=b.id ORDER BY o.created_at DESC LIMIT 100',[]);
  const result=await Promise.all(orders.map(async o=>({...o,items:await qa('SELECT * FROM order_items WHERE order_id=$1',[o.id])})));
  res.json(result);
});

app.get('/api/orders/:id', auth, async (req, res) => {
  const o=await q1('SELECT o.*,b.name as business_name,b.address as business_address,b.logo_emoji,u.name as customer_name FROM orders o JOIN businesses b ON o.business_id=b.id JOIN users u ON o.customer_id=u.id WHERE o.id=$1',[req.params.id]);
  if (!o) return res.status(404).json({ error:'Pedido no encontrado' });
  o.items=await qa('SELECT * FROM order_items WHERE order_id=$1',[o.id]);
  res.json(o);
});

app.patch('/api/orders/:id/status', auth, async (req, res) => {
  const { status } = req.body;
  const order=await q1('SELECT * FROM orders WHERE id=$1',[req.params.id]);
  if (!order) return res.status(404).json({ error:'Pedido no encontrado' });
  const allowed={ owner:{confirmed:'preparing',preparing:'ready'},delivery:{ready:'on_way',on_way:'delivered'},admin:{pending:'confirmed',confirmed:'preparing',preparing:'ready',ready:'on_way',on_way:'delivered'} };
  const ra=allowed[req.user.role];
  if (!ra || ra[order.status]!==status) return res.status(400).json({ error:`No podés cambiar de ${order.status} a ${status}` });
  if (req.user.role==='owner') {
    const b=await q1('SELECT id FROM businesses WHERE owner_id=$1',[req.user.id]);
    if (!b||b.id!==order.business_id) return res.status(403).json({ error:'No es tu pedido' });
  }
  await q('UPDATE orders SET status=$1,updated_at=NOW() WHERE id=$2',[status,order.id]);
  if (status==='on_way') await q('UPDATE orders SET delivery_id=$1 WHERE id=$2',[req.user.id,order.id]);
  if (status==='delivered') {
    await credit(order.business_id,'business',order.business_amount,`Pedido #${order.id.slice(-6).toUpperCase()}`,order.id);
    await credit(order.delivery_id||req.user.id,'delivery',order.delivery_amount,`Delivery #${order.id.slice(-6).toUpperCase()}`,order.id);
    await credit('platform','platform',order.platform_amount,`Comisión #${order.id.slice(-6).toUpperCase()}`,order.id);
  }
  notify(order.customer_id,{ type:'status_change',message:`Tu pedido: ${status}`,status,order_id:order.id });
  const biz=await q1('SELECT owner_id FROM businesses WHERE id=$1',[order.business_id]);
  if (biz) notify(biz.owner_id,{ type:'order_update',status,order_id:order.id });
  res.json(await q1('SELECT * FROM orders WHERE id=$1',[order.id]));
});

app.post('/api/orders/:id/cancel', auth, async (req, res) => {
  const order=await q1('SELECT * FROM orders WHERE id=$1',[req.params.id]);
  if (!order) return res.status(404).json({ error:'No encontrado' });
  if (!['pending','confirmed','paid'].includes(order.status)) return res.status(400).json({ error:'No se puede cancelar' });
  if (req.user.role==='customer'&&order.customer_id!==req.user.id) return res.status(403).json({ error:'No es tu pedido' });
  const reason = req.body?.reason || '';
  await q("UPDATE orders SET status='cancelled',cancel_reason=$2,updated_at=NOW() WHERE id=$1",[order.id, reason]);
  const biz=await q1('SELECT owner_id FROM businesses WHERE id=$1',[order.business_id]);
  if (biz) notify(biz.owner_id,{ type:'order_cancelled',message:`❌ Pedido cancelado`,order_id:order.id });
  notify(order.customer_id,{ type:'order_cancelled',message:`❌ Tu pedido fue cancelado`,order_id:order.id });
  res.json({ success:true });
});

// Endpoint reject para panel de negocio (owner rechaza un pedido pendiente/paid)
app.post('/api/orders/:id/reject', auth, async (req, res) => {
  try {
    const order=await q1('SELECT * FROM orders WHERE id=$1',[req.params.id]);
    if (!order) return res.status(404).json({ error:'No encontrado' });
    // Solo el owner del negocio o admin puede rechazar
    if (req.user.role==='owner') {
      const biz=await q1('SELECT id FROM businesses WHERE owner_id=$1',[req.user.id]);
      if (!biz || biz.id!==order.business_id) return res.status(403).json({ error:'No es tu pedido' });
    } else if (req.user.role!=='admin') {
      return res.status(403).json({ error:'Sin permiso' });
    }
    if (!['pending','paid','confirmed'].includes(order.status)) return res.status(400).json({ error:'No se puede rechazar' });
    const reason = req.body?.reason || '';
    await q("UPDATE orders SET status='rejected',cancel_reason=$2,updated_at=NOW() WHERE id=$1",[order.id, reason]);
    notify(order.customer_id,{ type:'order_rejected',message:`❌ Tu pedido fue rechazado${reason?' — '+reason:''}`,order_id:order.id });
    res.json({ success:true, refund: null });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════
//  WALLET
// ════════════════════════════════════════════════
app.get('/api/wallet', auth, async (req, res) => {
  const ownerId=req.user.role==='owner'?(await q1('SELECT id FROM businesses WHERE owner_id=$1',[req.user.id]))?.id:req.user.id;
  if (!ownerId) return res.status(404).json({ error:'Sin negocio' });
  const wallet=await getWallet(ownerId,req.user.role);
  const txs=await qa('SELECT * FROM transactions WHERE wallet_id=$1 ORDER BY created_at DESC LIMIT 30',[wallet.id]);
  res.json({ balance:parseFloat(wallet.balance)||0,transactions:txs });
});





// ════════════════════════════════════════════════
//  BLOW+ CLIENTE
// ════════════════════════════════════════════════

// Get user Blow+ status
app.get('/api/user/blow-plus', auth, async (req, res) => {
  const u = await q1('SELECT blow_plus, blow_plus_since, blow_plus_expires FROM users WHERE id=$1', [req.user.id]);
  if (!u) return res.status(404).json({ error: 'Usuario no encontrado' });
  const now = new Date();
  const active = u.blow_plus && (!u.blow_plus_expires || new Date(u.blow_plus_expires) > now);
  res.json({ active, since: u.blow_plus_since, expires: u.blow_plus_expires });
});

// Create MP preference for user Blow+
app.post('/api/user/blow-plus/subscribe', auth, async (req, res) => {
  const u = await q1('SELECT * FROM users WHERE id=$1', [req.user.id]);
  if (!u) return res.status(404).json({ error: 'Usuario no encontrado' });

  // Demo mode
  if (!mp || !process.env.MP_ACCESS_TOKEN?.startsWith('APP_USR-')) {
    await q(`UPDATE users SET blow_plus=TRUE, blow_plus_since=NOW(), blow_plus_expires=NOW()+INTERVAL '30 days' WHERE id=$1`, [req.user.id]);
    return res.json({ demo: true, message: 'Blow+ cliente activado en modo demo' });
  }

  try {
    const pref = await mp.preferences.create({
      items: [{
        title: 'Blow+ Cliente — Envíos gratis + promos exclusivas',
        description: 'Envíos gratis en negocios adheridos y promociones exclusivas cada mes',
        quantity: 1,
        unit_price: BLOW_PLUS_USER_PRICE,
        currency_id: 'UYU'
      }],
      payer: { name: u.name, email: u.email },
      external_reference: `blowplususer:${u.id}`,
      back_urls: {
        success: `${APP_URL}/?blowplususer=success`,
        failure: `${APP_URL}/?blowplususer=failure`,
        pending: `${APP_URL}/?blowplususer=pending`,
      },
      auto_return: 'approved',
      notification_url: `${APP_URL}/api/webhooks/mp`,
    });
    res.json({ init_point: pref.body.init_point, sandbox_init_point: pref.body.sandbox_init_point });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Cancel user Blow+
app.post('/api/user/blow-plus/cancel', auth, async (req, res) => {
  await q('UPDATE users SET blow_plus=FALSE WHERE id=$1', [req.user.id]);
  res.json({ success: true });
});

// Admin: toggle user Blow+
app.patch('/api/admin/users/:id/blow-plus', auth, role('admin'), async (req, res) => {
  const { active } = req.body;
  if (active) {
    await q(`UPDATE users SET blow_plus=TRUE, blow_plus_since=NOW(), blow_plus_expires=NOW()+INTERVAL '30 days' WHERE id=$1`, [req.params.id]);
  } else {
    await q('UPDATE users SET blow_plus=FALSE WHERE id=$1', [req.params.id]);
  }
  res.json({ success: true });
});

// ════════════════════════════════════════════════
//  BLOW+ PREMIUM
// ════════════════════════════════════════════════

// Get Blow+ status
app.get('/api/businesses/mine/blow-plus', auth, role('owner'), async (req, res) => {
  const biz = await q1('SELECT blow_plus, blow_plus_since, blow_plus_expires FROM businesses WHERE owner_id=$1', [req.user.id]);
  if (!biz) return res.status(404).json({ error: 'Negocio no encontrado' });
  const now = new Date();
  const active = biz.blow_plus && (!biz.blow_plus_expires || new Date(biz.blow_plus_expires) > now);
  res.json({ active, since: biz.blow_plus_since, expires: biz.blow_plus_expires });
});

// Create MP preference for Blow+ subscription
app.post('/api/businesses/mine/blow-plus/subscribe', auth, role('owner'), async (req, res) => {
  const owner = await q1('SELECT * FROM users WHERE id=$1', [req.user.id]);
  const biz = await q1('SELECT * FROM businesses WHERE owner_id=$1', [req.user.id]);
  if (!biz) return res.status(404).json({ error: 'Negocio no encontrado' });

  // Demo mode
  if (!mp || !process.env.MP_ACCESS_TOKEN?.startsWith('APP_USR-')) {
    await q(`UPDATE businesses SET blow_plus=TRUE, blow_plus_since=NOW(), blow_plus_expires=NOW()+INTERVAL '30 days' WHERE id=$1`, [biz.id]);
    return res.json({ demo: true, message: 'Blow+ activado en modo demo' });
  }

  try {
    const pref = await mp.preferences.create({
      items: [{
        title: 'Blow+ — Plan Premium mensual',
        description: 'Aparecer primero en resultados + productos promocionados',
        quantity: 1,
        unit_price: BLOW_PLUS_PRICE,
        currency_id: 'UYU'
      }],
      payer: { name: owner.name, email: owner.email },
      external_reference: `blowplus:${biz.id}`,
      back_urls: {
        success: `${APP_URL}/?blowplus=success`,
        failure: `${APP_URL}/?blowplus=failure`,
        pending: `${APP_URL}/?blowplus=pending`,
      },
      auto_return: 'approved',
      notification_url: `${APP_URL}/api/webhooks/mp`,
    });
    res.json({ init_point: pref.body.init_point, sandbox_init_point: pref.body.sandbox_init_point });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Cancel Blow+
app.post('/api/businesses/mine/blow-plus/cancel', auth, role('owner'), async (req, res) => {
  const biz = await q1('SELECT id FROM businesses WHERE owner_id=$1', [req.user.id]);
  if (!biz) return res.status(404).json({ error: 'Negocio no encontrado' });
  await q('UPDATE businesses SET blow_plus=FALSE WHERE id=$1', [biz.id]);
  res.json({ success: true, message: 'Blow+ cancelado. Seguirá activo hasta el vencimiento.' });
});

// Admin: manually toggle Blow+ for a business
app.patch('/api/admin/businesses/:id/blow-plus', auth, role('admin'), async (req, res) => {
  const { active } = req.body;
  if (active) {
    await q(`UPDATE businesses SET blow_plus=TRUE, blow_plus_since=NOW(), blow_plus_expires=NOW()+INTERVAL '30 days' WHERE id=$1`, [req.params.id]);
  } else {
    await q('UPDATE businesses SET blow_plus=FALSE WHERE id=$1', [req.params.id]);
  }
  res.json({ success: true });
});

// ════════════════════════════════════════════════
//  PHOTO UPLOAD ROUTES
// ════════════════════════════════════════════════

// Upload business cover photo
app.post('/api/businesses/mine/upload-cover', auth, role('owner'), uploadMiddleware('photo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No se recibio imagen' });
  const url = req.file.path || req.file.secure_url;
  await q('UPDATE businesses SET cover_url=$1 WHERE owner_id=$2', [url, req.user.id]);
  res.json({ url });
});

app.post('/api/businesses/mine/upload-logo', auth, role('owner'), uploadMiddleware('photo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No se recibio imagen' });
  const url = req.file.path || req.file.secure_url;
  await q('UPDATE businesses SET logo_url=$1 WHERE owner_id=$2', [url, req.user.id]);
  res.json({ url });
});

app.post('/api/businesses/mine/products/:id/upload-photo', auth, role('owner'), uploadMiddleware('photo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No se recibio imagen' });
  const url = req.file.path || req.file.secure_url;
  const biz = await q1('SELECT id FROM businesses WHERE owner_id=$1', [req.user.id]);
  if (!biz) return res.status(404).json({ error: 'Negocio no encontrado' });
  await q('UPDATE products SET photo_url=$1 WHERE id=$2 AND business_id=$3', [url, req.params.id, biz.id]);
  res.json({ url });
});

app.post('/api/admin/businesses/:id/upload-cover', auth, role('admin'), uploadMiddleware('photo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No se recibio imagen' });
  const url = req.file.path || req.file.secure_url;
  await q('UPDATE businesses SET cover_url=$1 WHERE id=$2', [url, req.params.id]);
  res.json({ url });
});

app.post('/api/admin/businesses/:id/upload-logo', auth, role('admin'), uploadMiddleware('photo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No se recibio imagen' });
  const url = req.file.path || req.file.secure_url;
  await q('UPDATE businesses SET logo_url=$1 WHERE id=$2', [url, req.params.id]);
  res.json({ url });
});

// ═══════════════════════════════════════════════
//  PROMOTIONS
// ═══════════════════════════════════════════════


// Owner: toggle Blow+ free delivery
app.patch('/api/businesses/mine/blow-plus-delivery', auth, role('owner'), async (req, res) => {
  const { enabled } = req.body;
  await q('UPDATE businesses SET blow_plus_free_delivery=$1 WHERE owner_id=$2', [!!enabled, req.user.id]);
  res.json({ success: true });
});

// Owner: list own promotions
app.get('/api/businesses/mine/promotions', auth, role('owner'), async (req, res) => {
  const biz = await q1('SELECT id FROM businesses WHERE owner_id=$1',[req.user.id]);
  if (!biz) return res.status(404).json({ error:'Negocio no encontrado' });
  const promos = await qa('SELECT * FROM promotions WHERE business_id=$1 ORDER BY created_at DESC',[biz.id]);
  res.json(promos.map(p => ({ ...p, combo_products: safeJson(p.combo_products, []) })));
});

// Owner: create promotion
app.post('/api/businesses/mine/promotions', auth, role('owner'), async (req, res) => {
  const biz = await q1('SELECT id FROM businesses WHERE owner_id=$1',[req.user.id]);
  if (!biz) return res.status(404).json({ error:'Negocio no encontrado' });
  const { name, type, value=0, min_order_amount=0, category_id=null,
          combo_products=[], combo_price=0, code=null,
          requires_code=false, starts_at=null, ends_at=null, blow_plus_only=false } = req.body;
  if (!name || !type) return res.status(400).json({ error:'name y type son requeridos' });
  const id = 'promo-' + uuid().slice(0,8);
  await q(
    `INSERT INTO promotions (id,business_id,name,type,value,min_order_amount,category_id,combo_products,combo_price,code,requires_code,starts_at,ends_at,blow_plus_only)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [id,biz.id,name,type,value,min_order_amount,category_id,
     JSON.stringify(combo_products),combo_price,
     code||null,requires_code,starts_at||null,ends_at||null,blow_plus_only]
  );
  res.json({ success:true, id });
});

// Owner: update promotion
app.patch('/api/businesses/mine/promotions/:id', auth, role('owner'), async (req, res) => {
  const biz = await q1('SELECT id FROM businesses WHERE owner_id=$1',[req.user.id]);
  if (!biz) return res.status(404).json({ error:'Negocio no encontrado' });
  const { name, type, value, min_order_amount, category_id, combo_products,
          combo_price, code, requires_code, is_active, starts_at, ends_at, blow_plus_only } = req.body;
  const updates=[]; const params=[]; let i=1;
  if (name!==undefined)             { updates.push(`name=$${i++}`);             params.push(name); }
  if (type!==undefined)             { updates.push(`type=$${i++}`);             params.push(type); }
  if (value!==undefined)            { updates.push(`value=$${i++}`);            params.push(value); }
  if (min_order_amount!==undefined) { updates.push(`min_order_amount=$${i++}`); params.push(min_order_amount); }
  if (category_id!==undefined)      { updates.push(`category_id=$${i++}`);      params.push(category_id); }
  if (combo_products!==undefined)   { updates.push(`combo_products=$${i++}`);   params.push(JSON.stringify(combo_products)); }
  if (combo_price!==undefined)      { updates.push(`combo_price=$${i++}`);      params.push(combo_price); }
  if (code!==undefined)             { updates.push(`code=$${i++}`);             params.push(code||null); }
  if (requires_code!==undefined)    { updates.push(`requires_code=$${i++}`);    params.push(requires_code); }
  if (is_active!==undefined)        { updates.push(`is_active=$${i++}`);        params.push(is_active); }
  if (starts_at!==undefined)        { updates.push(`starts_at=$${i++}`);        params.push(starts_at||null); }
  if (ends_at!==undefined)          { updates.push(`ends_at=$${i++}`);          params.push(ends_at||null); }
  if (blow_plus_only!==undefined)  { updates.push(`blow_plus_only=$${i++}`);  params.push(blow_plus_only); }
  if (!updates.length) return res.status(400).json({ error:'Nada que actualizar' });
  params.push(req.params.id); params.push(biz.id);
  await q(`UPDATE promotions SET ${updates.join(',')} WHERE id=$${i} AND business_id=$${i+1}`, params);
  res.json({ success:true });
});

// Owner: delete promotion
app.delete('/api/businesses/mine/promotions/:id', auth, role('owner'), async (req, res) => {
  const biz = await q1('SELECT id FROM businesses WHERE owner_id=$1',[req.user.id]);
  if (!biz) return res.status(404).json({ error:'Negocio no encontrado' });
  await q('DELETE FROM promotions WHERE id=$1 AND business_id=$2',[req.params.id,biz.id]);
  res.json({ success:true });
});

app.post('/api/businesses', auth, role('owner'), async (req, res) => {
  if (await q1('SELECT id FROM businesses WHERE owner_id=$1',[req.user.id]))
    return res.status(409).json({ error:'Ya tenés un negocio registrado' });
  const { name, category, address='', phone='', logo_emoji='🏪', delivery_cost=50, delivery_time='20-35', city='', department='' } = req.body;
  if (!name || !category) return res.status(400).json({ error:'name y category son obligatorios' });
  if (!city.trim()) return res.status(400).json({ error:'La ciudad es obligatoria' });
  const id = uuid();
  await q('INSERT INTO businesses (id,owner_id,name,category,address,phone,logo_emoji,delivery_cost,delivery_time,city,department) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
    [id, req.user.id, name.trim(), category, address, phone, logo_emoji, delivery_cost, delivery_time, city.trim(), department]);
  res.status(201).json(await q1('SELECT * FROM businesses WHERE id=$1',[id]));
});
app.get('/api/businesses/:id', async (req, res) => {
  const b = await q1('SELECT * FROM businesses WHERE id=$1',[req.params.id]);
  if (!b) return res.status(404).json({ error:'Negocio no encontrado' });
  const rawP = await qa('SELECT * FROM products WHERE business_id=$1 AND is_available=TRUE',[b.id]);
  const prods = await Promise.all(rawP.map(async p => ({
    ...p,
    photos:   await qa('SELECT id,url,sort_order FROM product_photos WHERE product_id=$1 ORDER BY sort_order',[p.id]),
    variants: await qa('SELECT * FROM product_variants WHERE product_id=$1 ORDER BY group_name,sort_order',[p.id]),
  })));
  const cats = await qa('SELECT * FROM product_categories WHERE business_id=$1 ORDER BY sort_order',[b.id]);
  res.json({ ...b, products:prods, categories:cats });
});

// Public: get active promotions for a business
app.get('/api/businesses/:id/promotions', async (req, res) => {
  const now = new Date().toISOString();
  // Check if requester is a Blow+ user
  let userIsBlowPlus = false;
  try {
    const authHeader = req.headers.authorization;
    if (authHeader) {
      const tok = authHeader.replace('Bearer ','');
      const decoded = jwt.verify(tok, JWT_SECRET);
      const u = await q1('SELECT blow_plus, blow_plus_expires FROM users WHERE id=$1', [decoded.id]);
      userIsBlowPlus = u?.blow_plus && (!u.blow_plus_expires || new Date(u.blow_plus_expires) > new Date());
    }
  } catch(e) {}
  const promos = await qa(
    `SELECT * FROM promotions WHERE business_id=$1 AND is_active=TRUE
     AND (starts_at IS NULL OR starts_at <= $2)
     AND (ends_at IS NULL OR ends_at >= $2)`,
    [req.params.id, now]
  );
  const filtered = promos.filter(p => !p.blow_plus_only || userIsBlowPlus);
  res.json(filtered.map(p => ({
    ...p,
    combo_products: safeJson(p.combo_products, []),
    code: p.requires_code ? '[required]' : null,
    blow_plus_only: p.blow_plus_only
  })));
});

// Public: validate promo code
app.post('/api/businesses/:id/promotions/validate-code', async (req, res) => {
  const { code, cart_items, cart_total } = req.body;
  if (!code) return res.status(400).json({ error:'Código requerido' });
  const now = new Date().toISOString();
  const promo = await q1(
    `SELECT * FROM promotions WHERE business_id=$1 AND LOWER(code)=LOWER($2)
     AND is_active=TRUE AND requires_code=TRUE
     AND (starts_at IS NULL OR starts_at <= $3)
     AND (ends_at IS NULL OR ends_at >= $3)`,
    [req.params.id, code, now]
  );
  if (!promo) return res.status(404).json({ error:'Código inválido o vencido' });
  if (promo.min_order_amount > 0 && (cart_total||0) < promo.min_order_amount) {
    return res.status(400).json({ error:`Monto mínimo para este código: $${promo.min_order_amount}` });
  }
  const discount = calcPromoDiscount(promo, cart_items||[], cart_total||0);
  res.json({ success:true, promo: { ...promo, combo_products: safeJson(promo.combo_products,[]) }, discount });
});

app.post('/api/wallet/withdraw', auth, async (req, res) => {
  const ownerId=req.user.role==='owner'?(await q1('SELECT id FROM businesses WHERE owner_id=$1',[req.user.id]))?.id:req.user.id;
  if (!ownerId) return res.status(404).json({ error:'Sin negocio' });
  const { amount,method,destination } = req.body;
  if (!amount||amount<=0) return res.status(400).json({ error:'Monto inválido' });
  const wallet=await getWallet(ownerId,req.user.role);
  if (parseFloat(wallet.balance)<amount) return res.status(400).json({ error:'Saldo insuficiente' });
  await q('UPDATE wallets SET balance=balance-$1,updated_at=NOW() WHERE id=$2',[amount,wallet.id]);
  await q('INSERT INTO transactions (id,wallet_id,type,amount,description) VALUES ($1,$2,$3,$4,$5)',[uuid(),wallet.id,'debit',amount,`Retiro via ${method}`]);
  const owner=await q1('SELECT name,email FROM users WHERE id=$1',[req.user.id]);
  await q('INSERT INTO withdrawals (id,wallet_id,owner_id,owner_name,email,amount,method,destination) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
    [uuid(),wallet.id,req.user.id,owner.name,owner.email||'',amount,method,destination]);
  res.json({ success:true });
});

// ════════════════════════════════════════════════
//  ADMIN
// ════════════════════════════════════════════════
app.post('/api/admin/setup', async (req, res) => {
  if (await q1("SELECT id FROM users WHERE role='admin'",[]))
    return res.status(403).json({ error:'Ya existe un administrador' });
  const { name,email,password } = req.body;
  if (!name||!email||!password) return res.status(400).json({ error:'Faltan datos' });
  const id=uuid();
  await q('INSERT INTO users (id,name,email,password,role) VALUES ($1,$2,$3,$4,$5)',[id,name,email.toLowerCase(),await bcrypt.hash(password,10),'admin']);
  const user={id,name,email,role:'admin'};
  res.status(201).json({ token:sign(user),user });
});

app.get('/api/admin/stats', auth, role('admin'), async (req, res) => {
  const userStats  =await qa('SELECT role,COUNT(*) as c FROM users GROUP BY role',[]);
  const orderStats =await qa('SELECT status,COUNT(*) as c FROM orders GROUP BY status',[]);
  const revenue    =await q1("SELECT COALESCE(SUM(total),0) as total FROM orders WHERE status='delivered'",[]);
  const today      =await q1(`SELECT COUNT(*) as orders,COALESCE(SUM(total),0) as revenue FROM orders WHERE DATE(created_at)=CURRENT_DATE AND status NOT IN ('cancelled','pending')`,[]);
  const week       =await q1(`SELECT COUNT(*) as orders,COALESCE(SUM(total),0) as revenue FROM orders WHERE created_at>=NOW()-INTERVAL '7 days' AND status NOT IN ('cancelled','pending')`,[]);
  const businesses =await q1('SELECT COUNT(*) as c FROM businesses',[]);
  const pendingW   =await q1("SELECT COUNT(*) as c FROM withdrawals WHERE status='pending'",[]);
  res.json({ userStats,orderStats,revenue:parseFloat(revenue.total),today,week,businesses:parseInt(businesses.c),pendingWithdrawals:parseInt(pendingW.c) });
});

app.get('/api/admin/stats/advanced', auth, role('admin'), async (req, res) => {
  try {
    const { from, to } = req.query;
    const fromDate = from || new Date(Date.now() - 30*24*60*60*1000).toISOString().split('T')[0];
    const toDate   = to   || new Date().toISOString().split('T')[0];
    const totals = await q1(`
      SELECT
        COALESCE(SUM(total),0) as gmv,
        COALESCE(SUM(platform_amount),0) as platform_revenue,
        COUNT(*) as total_orders,
        COUNT(*) FILTER (WHERE status='cancelled') as cancelled_orders,
        AVG(total) FILTER (WHERE status='delivered') as avg_order_value,
        COUNT(DISTINCT customer_id) FILTER (WHERE status='delivered') as active_customers
      FROM orders
      WHERE created_at >= $1::date AND created_at < ($2::date + INTERVAL '1 day')
    `, [fromDate, toDate]);
    const daily = await qa(`
      SELECT DATE(created_at) as date,
        COALESCE(SUM(total),0) as gmv,
        COUNT(*) as orders
      FROM orders
      WHERE created_at >= $1::date AND created_at < ($2::date + INTERVAL '1 day')
        AND status NOT IN ('cancelled','pending')
      GROUP BY DATE(created_at) ORDER BY date ASC
    `, [fromDate, toDate]);
    const byStatus = await qa(`SELECT status, COUNT(*) as c FROM orders WHERE created_at >= $1::date AND created_at < ($2::date + INTERVAL '1 day') GROUP BY status`, [fromDate, toDate]);
    const topBiz = await qa(`
      SELECT b.name, COUNT(o.id) as orders, COALESCE(SUM(o.total),0) as gmv
      FROM orders o JOIN businesses b ON o.business_id=b.id
      WHERE o.created_at >= $1::date AND o.created_at < ($2::date + INTERVAL '1 day') AND o.status='delivered'
      GROUP BY b.id, b.name ORDER BY gmv DESC LIMIT 5
    `, [fromDate, toDate]);
    const topCustomers = await qa(`
      SELECT u.name, u.email, COUNT(o.id) as orders, COALESCE(SUM(o.total),0) as spent
      FROM orders o JOIN users u ON o.customer_id=u.id
      WHERE o.created_at >= $1::date AND o.created_at < ($2::date + INTERVAL '1 day') AND o.status='delivered'
      GROUP BY u.id, u.name, u.email ORDER BY spent DESC LIMIT 5
    `, [fromDate, toDate]);
    res.json({
      totals: {
        gmv: parseFloat(totals.gmv||0),
        platform_revenue: parseFloat(totals.platform_revenue||0),
        total_orders: parseInt(totals.total_orders||0),
        cancelled_orders: parseInt(totals.cancelled_orders||0),
        avg_order_value: parseFloat(totals.avg_order_value||0),
        active_customers: parseInt(totals.active_customers||0)
      },
      daily, byStatus, topBiz, topCustomers
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/users', auth, role('admin'), async (req, res) => {
  const { role:r,search } = req.query;
  let sql='SELECT u.*,(SELECT COUNT(*) FROM orders WHERE customer_id=u.id) as order_count FROM users u WHERE TRUE';
  const params=[]; let i=1;
  if (r) { sql+=` AND u.role=$${i++}`;params.push(r); }
  if (search) { sql+=` AND (u.name ILIKE $${i} OR u.email ILIKE $${i++})`;params.push(`%${search}%`); }
  res.json(await qa(sql+' ORDER BY u.created_at DESC',params));
});

app.patch('/api/admin/users/:id', auth, role('admin'), async (req, res) => {
  const { name,email,role:r,phone }=req.body;
  await q('UPDATE users SET name=COALESCE($1,name),email=COALESCE($2,email),role=COALESCE($3,role),phone=COALESCE($4,phone) WHERE id=$5',[name,email,r,phone,req.params.id]);
  res.json(await q1('SELECT id,name,email,role,phone,created_at FROM users WHERE id=$1',[req.params.id]));
});
app.delete('/api/admin/users/:id', auth, role('admin'), async (req, res) => {
  await q("DELETE FROM users WHERE id=$1 AND role!='admin'",[req.params.id]);
  res.json({ success:true });
});
app.post('/api/admin/users/:id/reset-password', auth, role('admin'), async (req, res) => {
  const { password }=req.body;
  if (!password||password.length<6) return res.status(400).json({ error:'Mínimo 6 caracteres' });
  await q('UPDATE users SET password=$1 WHERE id=$2',[await bcrypt.hash(password,10),req.params.id]);
  res.json({ success:true });
});
app.get('/api/admin/businesses', auth, role('admin'), async (req, res) =>
  res.json(await qa(`SELECT b.*,u.name as owner_name,u.email as owner_email,(SELECT COUNT(*) FROM orders WHERE business_id=b.id AND status='delivered') as completed_orders,(SELECT COALESCE(SUM(total),0) FROM orders WHERE business_id=b.id AND status='delivered') as total_revenue FROM businesses b JOIN users u ON b.owner_id=u.id ORDER BY b.created_at DESC`,[])));
app.patch('/api/admin/businesses/:id', auth, role('admin'), async (req, res) => {
  const { name,category,address,phone,logo_emoji,delivery_cost,is_open,plan,delivery_time,city,department }=req.body;
  await q(`UPDATE businesses SET name=COALESCE($1,name),category=COALESCE($2,category),address=COALESCE($3,address),phone=COALESCE($4,phone),logo_emoji=COALESCE($5,logo_emoji),delivery_cost=COALESCE($6,delivery_cost),is_open=COALESCE($7,is_open),plan=COALESCE($8,plan),delivery_time=COALESCE($9,delivery_time),city=COALESCE($10,city),department=COALESCE($11,department) WHERE id=$12`,
    [name,category,address,phone,logo_emoji,delivery_cost,is_open!=null?Boolean(is_open):null,plan,delivery_time,city,department,req.params.id]);
  res.json(await q1('SELECT * FROM businesses WHERE id=$1',[req.params.id]));
});
app.delete('/api/admin/businesses/:id', auth, role('admin'), async (req, res) => {
  await q('DELETE FROM businesses WHERE id=$1',[req.params.id]);
  res.json({ success:true });
});
app.get('/api/admin/orders', auth, role('admin'), async (req, res) => {
  const { status,search }=req.query;
  let sql='SELECT o.*,u.name as customer_name,b.name as business_name FROM orders o JOIN users u ON o.customer_id=u.id JOIN businesses b ON o.business_id=b.id WHERE TRUE';
  const params=[]; let i=1;
  if (status) { sql+=` AND o.status=$${i++}`;params.push(status); }
  if (search) { sql+=` AND (u.name ILIKE $${i} OR b.name ILIKE $${i++})`;params.push(`%${search}%`); }
  const rows=await qa(sql+' ORDER BY o.created_at DESC LIMIT 200',params);
  res.json(await Promise.all(rows.map(async o=>({...o,items:await qa('SELECT * FROM order_items WHERE order_id=$1',[o.id])}))));
});
app.get('/api/admin/withdrawals', auth, role('admin'), async (req, res) =>
  res.json(await qa('SELECT * FROM withdrawals ORDER BY created_at DESC',[])));
app.post('/api/admin/withdrawals/:id/approve', auth, role('admin'), async (req, res) => {
  await q("UPDATE withdrawals SET status='completed',processed_at=NOW() WHERE id=$1",[req.params.id]);
  res.json({ success:true });
});
app.post('/api/admin/withdrawals/:id/reject', auth, role('admin'), async (req, res) => {
  const w=await q1('SELECT * FROM withdrawals WHERE id=$1',[req.params.id]);
  if (!w) return res.status(404).json({ error:'No encontrado' });
  await q("UPDATE withdrawals SET status='rejected',processed_at=NOW() WHERE id=$1",[req.params.id]);
  await q('UPDATE wallets SET balance=balance+$1,updated_at=NOW() WHERE id=$2',[w.amount,w.wallet_id]);
  await q('INSERT INTO transactions (id,wallet_id,type,amount,description) VALUES ($1,$2,$3,$4,$5)',[uuid(),w.wallet_id,'credit',w.amount,'Retiro rechazado — saldo devuelto']);
  res.json({ success:true });
});
app.get('/api/admin/settings', auth, role('admin'), async (req, res) => {
  const rows=await qa('SELECT * FROM app_settings',[]);
  const obj={};
  rows.forEach(r=>{ try{obj[r.key]=JSON.parse(r.value);}catch{obj[r.key]=r.value;} });
  res.json(obj);
});
app.post('/api/admin/settings', auth, role('admin'), async (req, res) => {
  for (const [k,v] of Object.entries(req.body))
    await q('INSERT INTO app_settings (key,value,updated_at) VALUES ($1,$2,NOW()) ON CONFLICT(key) DO UPDATE SET value=$2,updated_at=NOW()',[k,JSON.stringify(v)]);
  await loadPlanPrice(); // reload in-memory price
  res.json({ success:true });
});
app.get('/api/admin/platform', auth, role('admin'), async (req, res) => {
  const wallet=await q1("SELECT * FROM wallets WHERE owner_id='platform'",[]);
  const txs=wallet?.id?await qa('SELECT * FROM transactions WHERE wallet_id=$1 ORDER BY created_at DESC LIMIT 30',[wallet.id]):[];
  res.json({ balance:parseFloat(wallet?.balance)||0,transactions:txs,fee_percent:process.env.PLATFORM_FEE_PERCENT||0 });
});

// ════════════════════════════════════════════════
//  WEBHOOK MERCADOPAGO
// ════════════════════════════════════════════════
app.post('/api/webhooks/mp', async (req, res) => {
  res.sendStatus(200);
  try {
    const { type, data, topic, id } = req.body;
    const resourceId = data?.id || id;
    console.log('🔔 WEBHOOK RECEIVED:', JSON.stringify({ type, topic, id, data, resourceId }));
    if (!resourceId || !mp) { console.log('❌ No resourceId or no mp'); return; }

    // ── Preapproval (suscripción recurrente) ────────────────────────────
    if (type === 'subscription_preapproval' || topic === 'preapproval') {
      console.log('📋 Preapproval event, fetching id:', resourceId);
      const pa = (await mp.preapproval.get(resourceId)).body;
      const extRef = pa.external_reference;
      console.log('📋 Preapproval data:', JSON.stringify({ id: pa.id, status: pa.status, extRef }));
      if (!extRef) { console.log('❌ No external_reference'); return; }

      // Registro inicial aprobado — crear usuario y negocio
      console.log('🔍 Checking reg condition: extRef=', extRef, 'status=', pa.status);
      if (extRef.startsWith('reg:') && pa.status === 'authorized') {
        const regId = extRef.replace('reg:','');
        const pending = await q1('SELECT * FROM pending_registrations WHERE id=$1',[regId]);
        if (!pending) { console.log('Webhook reg: pending not found', regId); return; }
        if (pending.status === 'completed') { console.log('Webhook reg: already completed', regId); return; }

        // Mark as paid first to avoid double processing
        await q("UPDATE pending_registrations SET status='completed', mp_preference_id=$1 WHERE id=$2",
          [pa.id, regId]);

        const d = typeof pending.data === 'string' ? JSON.parse(pending.data) : pending.data;
        // Check email not already registered
        if (await q1('SELECT id FROM users WHERE email=$1',[d.email])) {
          console.log('Webhook reg: email already exists', d.email); return;
        }

        // Create user
        const userId = uuid();
        await q('INSERT INTO users (id,name,email,phone,password,role,city,department) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
          [userId, d.name, d.email, d.phone||'', await bcrypt.hash(d.password,10), 'owner', d.city, d.department||'']);

        // Create business
        const bizId = uuid();
        await q('INSERT INTO businesses (id,owner_id,name,category,address,city,department) VALUES ($1,$2,$3,$4,$5,$6,$7)',
          [bizId, userId, d.bizName, d.category, d.address||'', d.city, d.department||'']);

        // Create active subscription with preapproval id
        const periodEnd = new Date(); periodEnd.setMonth(periodEnd.getMonth()+1);
        await q(`INSERT INTO subscriptions (id,business_id,owner_id,plan,status,mp_preapproval_id,current_period_start,current_period_end)
          VALUES ($1,$2,$3,'active','active',$4,NOW(),$5)`,
          [uuid(), bizId, userId, pa.id, periodEnd.toISOString()]);

        console.log('✅ Negocio creado via webhook:', d.bizName, '| owner:', d.email);
      }

      // Renovación aprobada para negocio existente
      if (extRef.startsWith('renew:') && pa.status === 'authorized') {
        const bizId = extRef.replace('renew:','');
        const periodEnd = new Date(); periodEnd.setMonth(periodEnd.getMonth()+1);
        await q(`UPDATE subscriptions SET status='active', mp_preapproval_id=$1,
          current_period_start=NOW(), current_period_end=$2, updated_at=NOW()
          WHERE business_id=$3`,
          [pa.id, periodEnd.toISOString(), bizId]);
        const biz = await q1('SELECT owner_id FROM businesses WHERE id=$1',[bizId]);
        if (biz) notify(biz.owner_id, { type:'subscription_renewed', message:'✅ Suscripción renovada automáticamente.' });
      }

      // Suscripción cancelada o suspendida por falta de pago
      if (['cancelled','paused'].includes(pa.status)) {
        const bizId = extRef.startsWith('renew:') ? extRef.replace('renew:','') : null;
        if (bizId) {
          await q(`UPDATE subscriptions SET status=$1, updated_at=NOW() WHERE business_id=$2 AND mp_preapproval_id=$3`,
            [pa.status === 'paused' ? 'past_due' : 'cancelled', bizId, pa.id]);
          const biz = await q1('SELECT owner_id FROM businesses WHERE id=$1',[bizId]);
          if (biz) notify(biz.owner_id, { type:'subscription_issue',
            message: pa.status === 'paused'
              ? '⚠️ No pudimos procesar tu pago. Actualizá tu método de pago para evitar la suspensión.'
              : '❌ Tu suscripción fue cancelada.' });
        }
      }
      return;
    }

    // ── Authorized payment (cobro mensual automático de preapproval) ────
    if (type === 'subscription_authorized_payment') {
      const authPayment = (await mp.preapprovalPayment.get(resourceId)).body;
      const preapprovalId = authPayment.preapproval_id;
      if (!preapprovalId) return;
      // Extend subscription period by 1 month
      const sub = await q1('SELECT * FROM subscriptions WHERE mp_preapproval_id=$1',[preapprovalId]);
      if (sub && authPayment.status === 'processed') {
        const newEnd = new Date(sub.current_period_end || Date.now());
        newEnd.setMonth(newEnd.getMonth()+1);
        await q(`UPDATE subscriptions SET status='active', current_period_end=$1, updated_at=NOW() WHERE mp_preapproval_id=$2`,
          [newEnd.toISOString(), preapprovalId]);
        const biz = await q1('SELECT owner_id FROM businesses WHERE id=$1',[sub.business_id]);
        if (biz) notify(biz.owner_id, { type:'subscription_renewed', message:'✅ Pago mensual procesado. ¡Gracias!' });
      }
      return;
    }

    // ── Regular payment (orders, Blow+, etc.) ──────────────────────────
    const paymentId = resourceId;
    if ((type||topic) !== 'payment') return;
    const payment = (await mp.payment.get(paymentId)).body;
    const extRef = payment.external_reference;
    if (!extRef) return;

    if (extRef.startsWith('blowplus:') && payment.status === 'approved') {
      const bizId = extRef.replace('blowplus:','');
      await q(`UPDATE businesses SET blow_plus=TRUE, blow_plus_since=NOW(),
        blow_plus_expires=NOW()+INTERVAL '30 days', blow_plus_mp_id=$1 WHERE id=$2`,
        [String(payment.id), bizId]);
      return;
    }

    if (extRef.startsWith('blowplususer:') && payment.status === 'approved') {
      const userId = extRef.replace('blowplususer:','');
      await q(`UPDATE users SET blow_plus=TRUE, blow_plus_since=NOW(), blow_plus_expires=NOW()+INTERVAL '30 days' WHERE id=$1`, [userId]);
      return;
    }

    // ── Order payment ──────────────────────────────────────────────────
    const orderId = extRef;
    const order = await q1('SELECT * FROM orders WHERE id=$1',[orderId]);
    if (!order) return;
    await q('UPDATE orders SET mp_payment_id=$1,mp_status=$2,updated_at=NOW() WHERE id=$3',[String(payment.id),payment.status,orderId]);
    if (payment.status === 'approved' && order.status === 'pending') {
      await q("UPDATE orders SET status='confirmed',updated_at=NOW() WHERE id=$1",[orderId]);
      const biz = await q1('SELECT * FROM businesses WHERE id=$1',[order.business_id]);
      if (biz) notify(biz.owner_id,{ type:'new_order',message:`💰 Pago confirmado! #${orderId.slice(-6).toUpperCase()}`,order_id:orderId,total:order.total });
      notify(order.customer_id,{ type:'status_change',message:'✅ Pago recibido!',status:'confirmed',order_id:orderId });
    }
    if (order && ['rejected','cancelled'].includes(payment.status) && order.status === 'pending')
      await q("UPDATE orders SET status='cancelled',updated_at=NOW() WHERE id=$1",[orderId]);

  } catch(e) { console.error('Webhook error:', e.message); }
});

// ── Public settings (no auth) ────────────────
app.get('/api/public-settings', async (_, res) => {
  try {
    const rows = await qa("SELECT * FROM app_settings WHERE key IN ('bank_promo','app_appearance','logo_url','logo_emoji','banners','text_appname','color_primary','color_bg','color_accent','color_success')", []);
    const obj = {};
    rows.forEach(r => { try { obj[r.key] = JSON.parse(r.value); } catch { obj[r.key] = r.value; } });
    res.json(obj);
  } catch(e) { res.json({}); }
});

// ── Health + Static ───────────────────────────
app.get('/health', async (_,res) => {
  try { await db.query('SELECT 1'); res.json({ status:'ok',db:'postgres',mp:!!mp,cloudinary:!!cloudinary,ts:new Date().toISOString() }); }
  catch(e) { res.status(500).json({ status:'error',db:e.message }); }
});

// ══════════════════════════════════════════════
//  COUPONS
// ══════════════════════════════════════════════

app.post('/api/coupons/validate', auth, async (req, res) => {
  try {
    const { code, order_total, business_id } = req.body;
    if (!code) return res.status(400).json({ error: 'Código requerido' });
    const c = await q1('SELECT * FROM coupons WHERE UPPER(code)=UPPER($1) AND active=true', [code.trim()]);
    if (!c) return res.status(404).json({ error: 'Cupón no encontrado o inactivo' });
    if (c.expires_at && new Date(c.expires_at) < new Date()) return res.status(400).json({ error: 'El cupón expiró' });
    if (c.max_uses && c.uses_count >= c.max_uses) return res.status(400).json({ error: 'Sin usos disponibles' });
    if (c.min_order && order_total < c.min_order) return res.status(400).json({ error: 'Pedido mínimo $' + c.min_order });
    if (c.business_id && c.business_id !== business_id) return res.status(400).json({ error: 'Cupón no válido para este negocio' });
    const used = await q1('SELECT COUNT(*) as cnt FROM coupon_uses WHERE coupon_id=$1 AND user_id=$2', [c.id, req.user.id]);
    if (c.per_user && parseInt(used.cnt) >= c.per_user) return res.status(400).json({ error: 'Ya usaste este cupón' });
    const discount = c.discount_type === 'percent' ? Math.round(order_total * c.discount_value / 100) : Math.min(c.discount_value, order_total);
    res.json({ valid: true, coupon: { id: c.id, code: c.code, description: c.description, discount_type: c.discount_type, discount_value: c.discount_value, discount_amount: discount } });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/coupons/available', auth, async (req, res) => {
  try {
    const coupons = await q('SELECT c.*, COALESCE((SELECT COUNT(*) FROM coupon_uses WHERE coupon_id=c.id AND user_id=$1),0) as my_uses, b.name as business_name FROM coupons c LEFT JOIN businesses b ON b.id=c.business_id WHERE c.active=true AND (c.expires_at IS NULL OR c.expires_at > NOW()) AND (c.max_uses IS NULL OR c.uses_count < c.max_uses) ORDER BY c.created_at DESC', [req.user.id]);
    res.json(coupons);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/coupons', auth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Sin permisos' });
  try {
    const { code, description, discount_type, discount_value, min_order, max_uses, per_user, business_id, expires_at } = req.body;
    if (!code || !discount_value) return res.status(400).json({ error: 'Código y descuento requeridos' });
    const existing = await q1('SELECT id FROM coupons WHERE UPPER(code)=UPPER($1)', [code.trim()]);
    if (existing) return res.status(409).json({ error: 'Ya existe ese código' });
    const id = uuid();
    await q('INSERT INTO coupons (id,code,description,discount_type,discount_value,min_order,max_uses,per_user,business_id,created_by,expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
      [id, code.trim().toUpperCase(), description||'', discount_type||'percent', discount_value, min_order||0, max_uses||null, per_user||1, business_id||null, req.user.id, expires_at||null]);
    res.status(201).json({ id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/coupons', auth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Sin permisos' });
  try { res.json(await q('SELECT c.*, b.name as business_name FROM coupons c LEFT JOIN businesses b ON b.id=c.business_id ORDER BY c.created_at DESC')); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/admin/coupons/:id', auth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Sin permisos' });
  try { await q('UPDATE coupons SET active=$1 WHERE id=$2', [req.body.active, req.params.id]); res.json({ ok: true }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/admin/coupons/:id', auth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Sin permisos' });
  try { await q('DELETE FROM coupons WHERE id=$1', [req.params.id]); res.json({ ok: true }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/owner/coupons', auth, async (req, res) => {
  if (req.user.role !== 'owner') return res.status(403).json({ error: 'Sin permisos' });
  try {
    const biz = await q1('SELECT id FROM businesses WHERE owner_id=$1', [req.user.id]);
    if (!biz) return res.status(404).json({ error: 'Negocio no encontrado' });
    const { code, description, discount_type, discount_value, min_order } = req.body;
    if (!code || !discount_value) return res.status(400).json({ error: 'Código y descuento requeridos' });
    const existing = await q1('SELECT id FROM coupons WHERE UPPER(code)=UPPER($1)', [code.trim()]);
    if (existing) return res.status(409).json({ error: 'Ya existe ese código' });
    const id = uuid();
    await q('INSERT INTO coupons (id,code,description,discount_type,discount_value,min_order,per_user,business_id,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [id, code.trim().toUpperCase(), description||'', discount_type||'percent', discount_value, min_order||0, 1, biz.id, req.user.id]);
    res.status(201).json({ id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/owner/coupons', auth, async (req, res) => {
  if (req.user.role !== 'owner') return res.status(403).json({ error: 'Sin permisos' });
  try {
    const biz = await q1('SELECT id FROM businesses WHERE owner_id=$1', [req.user.id]);
    if (!biz) return res.json([]);
    res.json(await q('SELECT * FROM coupons WHERE business_id=$1 ORDER BY created_at DESC', [biz.id]));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/owner/coupons/:id', auth, async (req, res) => {
  if (req.user.role !== 'owner') return res.status(403).json({ error: 'Sin permisos' });
  try {
    const biz = await q1('SELECT id FROM businesses WHERE owner_id=$1', [req.user.id]);
    await q('DELETE FROM coupons WHERE id=$1 AND business_id=$2', [req.params.id, biz?.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════
//  HELP / SOPORTE
// ══════════════════════════════════════════════

app.post('/api/help', async (req, res) => {
  try {
    const { name, email, message } = req.body;
    if (!message || !email) return res.status(400).json({ error: 'Email y mensaje requeridos' });
    const id = uuid();
    let userId = null;
    try { const auth = req.headers.authorization; if (auth) userId = require('jsonwebtoken').verify(auth.split(' ')[1], JWT_SECRET).id; } catch(e) {}
    await q('INSERT INTO help_messages (id,user_id,user_name,user_email,message) VALUES ($1,$2,$3,$4,$5)', [id, userId, name||'Anónimo', email, message]);
    res.status(201).json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/help', auth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Sin permisos' });
  try { res.json(await q('SELECT * FROM help_messages ORDER BY created_at DESC LIMIT 100')); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/admin/help/:id', auth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Sin permisos' });
  try {
    const { reply } = req.body;
    const msg = await q1('SELECT * FROM help_messages WHERE id=$1', [req.params.id]);
    if (!msg) return res.status(404).json({ error: 'No encontrado' });
    await q("UPDATE help_messages SET admin_reply=$1, status='resolved' WHERE id=$2", [reply, req.params.id]);
    await sendEmail(msg.user_email, 'Respuesta de soporte — Blow', '<p>Hola <b>' + msg.user_name + '</b>, respondimos tu consulta:</p><blockquote>' + reply + '</blockquote>');
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api',(_,res)=>res.json({ app:'Blow API v3',db:'PostgreSQL',status:'running' }));
app.get('/admin',(_,res)=>res.sendFile(path.join(__dirname,'public','admin.html')));

// ── PROMO BANNERS API ──
app.get('/api/banners', async (req,res)=>{
  try {
    const rows = await db.query("SELECT * FROM promo_banners WHERE active=TRUE ORDER BY sort_order ASC, created_at DESC");
    res.json(rows.rows);
  } catch(e){ res.json([]); }
});
// Admin banner list con filtro por tipo
app.get('/api/banners/admin', auth, async (req,res)=>{
  if(req.user.role!=='admin') return res.status(403).json({error:'No autorizado'});
  try {
    const type = req.query.type || 'hero';
    const rows = await db.query("SELECT * FROM promo_banners WHERE banner_type=$1 ORDER BY sort_order ASC, created_at DESC",[type]);
    res.json(rows.rows);
  } catch(e){ res.json([]); }
});
// Upload imagen de banner (sin ID previo)
app.post('/api/admin/banners/upload-image', auth, uploadMiddleware('photo'), async (req,res)=>{
  if(req.user.role!=='admin') return res.status(403).json({error:'No autorizado'});
  if(!req.file) return res.status(400).json({error:'No image'});
  try {
    const result = await cloudinary.uploader.upload(
      `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`,
      {folder:'blow_banners',transformation:[{width:800,height:300,crop:'fill'}]}
    );
    res.json({ok:true,url:result.secure_url});
  } catch(e){ res.status(500).json({error:e.message}); }
});
app.post('/api/admin/banners', auth, async (req,res)=>{
  if(req.user.role!=='admin') return res.status(403).json({error:'No autorizado'});
  const {title,subtitle,highlight,highlight_label,emoji,bg_color,link,link_url,sort_order,is_active,image_url,banner_type} = req.body;
  const id = 'ban_'+Date.now();
  await db.query(
    "INSERT INTO promo_banners(id,title,subtitle,highlight,emoji,bg_color,link,sort_order,active,image_url,banner_type) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
    [id,title||'',subtitle||'',highlight||highlight_label||'',emoji||'🍔',bg_color||'#FA0050',link_url||link||'',sort_order||0,is_active!==false,image_url||'',banner_type||'hero']
  );
  res.json({ok:true,id});
});
app.patch('/api/admin/banners/:id', auth, async (req,res)=>{
  if(req.user.role!=='admin') return res.status(403).json({error:'No autorizado'});
  const {title,subtitle,highlight,emoji,bg_color,link,sort_order,active,image_url} = req.body;
  await db.query("UPDATE promo_banners SET title=COALESCE($1,title),subtitle=COALESCE($2,subtitle),highlight=COALESCE($3,highlight),emoji=COALESCE($4,emoji),bg_color=COALESCE($5,bg_color),link=COALESCE($6,link),sort_order=COALESCE($7,sort_order),active=COALESCE($8,active),image_url=COALESCE($9,image_url) WHERE id=$10",
    [title,subtitle,highlight,emoji,bg_color,link,sort_order,active,image_url,req.params.id]);
  res.json({ok:true});
});
app.delete('/api/admin/banners/:id', auth, async (req,res)=>{
  if(req.user.role!=='admin') return res.status(403).json({error:'No autorizado'});
  await db.query("DELETE FROM promo_banners WHERE id=$1",[req.params.id]);
  res.json({ok:true});
});
app.post('/api/admin/banners/:id/image', auth, uploadMiddleware('image'), async (req,res)=>{
  if(req.user.role!=='admin') return res.status(403).json({error:'No autorizado'});
  if(!req.file) return res.status(400).json({error:'No image'});
  try {
    let imageUrl;
    if (req.file.buffer) {
      const result = await cloudinary.uploader.upload(`data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`,{folder:'blow_banners',transformation:[{width:800,height:300,crop:'fill'}]});
      imageUrl = result.secure_url;
    } else { imageUrl = req.file.path || req.file.secure_url; }
    await db.query("UPDATE promo_banners SET image_url=$1 WHERE id=$2",[imageUrl,req.params.id]);
    res.json({ok:true,url:result.secure_url});
  } catch(e){ res.status(500).json({error:e.message}); }
});

// ── FEATURED SLOTS API ──
app.get('/api/featured', async (req,res)=>{
  try {
    const rows = await db.query(`SELECT fs.*, b.name, b.logo_emoji, b.category, b.rating, b.delivery_time, b.delivery_cost, b.logo_url
      FROM featured_slots fs JOIN businesses b ON fs.business_id=b.id
      WHERE fs.active=TRUE ORDER BY fs.sort_order ASC`);
    res.json(rows.rows);
  } catch(e){ res.json([]); }
});
app.get('/api/admin/featured', auth, async (req,res)=>{
  if(req.user.role!=='admin') return res.status(403).json({error:'No autorizado'});
  const rows = await db.query(`SELECT fs.*, b.name as biz_name FROM featured_slots fs LEFT JOIN businesses b ON fs.business_id=b.id ORDER BY fs.sort_order ASC`);
  res.json(rows.rows);
});
app.post('/api/admin/featured', auth, async (req,res)=>{
  if(req.user.role!=='admin') return res.status(403).json({error:'No autorizado'});
  const {business_id,custom_title,sort_order} = req.body;
  const id = 'feat_'+Date.now();
  await db.query("INSERT INTO featured_slots(id,business_id,custom_title,sort_order) VALUES($1,$2,$3,$4)",[id,business_id,custom_title||'',sort_order||0]);
  res.json({ok:true,id});
});
app.post('/api/admin/featured/:id/image', auth, uploadMiddleware('image'), async (req,res)=>{
  if(req.user.role!=='admin') return res.status(403).json({error:'No autorizado'});
  if(!req.file) return res.status(400).json({error:'No image'});
  try {
    let imageUrl;
    if (req.file.buffer) {
      const result = await cloudinary.uploader.upload(`data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`,{folder:'blow_featured',transformation:[{width:600,height:400,crop:'fill'}]});
      imageUrl = result.secure_url;
    } else { imageUrl = req.file.path || req.file.secure_url; }
    await db.query("UPDATE featured_slots SET custom_image=$1 WHERE id=$2",[imageUrl,req.params.id]);
    res.json({ok:true,url:result.secure_url});
  } catch(e){ res.status(500).json({error:e.message}); }
});
app.patch('/api/admin/featured/:id', auth, async (req,res)=>{
  if(req.user.role!=='admin') return res.status(403).json({error:'No autorizado'});
  const {active,sort_order,custom_title} = req.body;
  await db.query("UPDATE featured_slots SET active=COALESCE($1,active),sort_order=COALESCE($2,sort_order),custom_title=COALESCE($3,custom_title) WHERE id=$4",[active,sort_order,custom_title,req.params.id]);
  res.json({ok:true});
});
app.delete('/api/admin/featured/:id', auth, async (req,res)=>{
  if(req.user.role!=='admin') return res.status(403).json({error:'No autorizado'});
  await db.query("DELETE FROM featured_slots WHERE id=$1",[req.params.id]);
  res.json({ok:true});
});


// ── BLOW+ BANNER CONFIG ──
app.get('/api/config/blowplus-banner', async (req,res)=>{
  try {
    const row = await q1("SELECT value FROM app_config WHERE key='blowplus_banner'", []);
    if (row) res.json(JSON.parse(row.value));
    else res.json({title:'¡Ahorrá $ 2.000 al mes!', subtitle:'Es lo que ahorran, en promedio, las personas que ya son Plus. ¡Suscribite!'});
  } catch(e){ res.json({title:'¡Ahorrá $ 2.000 al mes!', subtitle:'Es lo que ahorran, en promedio, las personas que ya son Plus. ¡Suscribite!'}); }
});
app.post('/api/admin/config/blowplus-banner', auth, async (req,res)=>{
  if(req.user.role!=='admin') return res.status(403).json({error:'No autorizado'});
  const {title, subtitle} = req.body;
  await db.query("INSERT INTO app_config(key,value) VALUES('blowplus_banner',$1) ON CONFLICT(key) DO UPDATE SET value=$1",
    [JSON.stringify({title, subtitle})]);
  res.json({ok:true});
});


// ── TOP CUSTOMERS (admin: all app, owner: their business) ──
app.get('/api/admin/top-customers', auth, async (req,res)=>{
  if(req.user.role!=='admin') return res.status(403).json({error:'No autorizado'});
  try {
    const rows = await db.query(`
      SELECT u.id, u.name, u.email,
        COUNT(o.id) as total_orders,
        SUM(o.total) as total_spent,
        MAX(o.created_at) as last_order
      FROM users u
      JOIN orders o ON o.customer_id=u.id
      WHERE o.status IN ('delivered','completed')
      GROUP BY u.id, u.name, u.email
      ORDER BY total_spent DESC LIMIT 50
    `);
    res.json(rows.rows);
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.get('/api/owner/top-customers', auth, async (req,res)=>{
  if(req.user.role!=='owner') return res.status(403).json({error:'No autorizado'});
  try {
    const biz = await q1('SELECT id FROM businesses WHERE owner_id=$1',[req.user.id]);
    if(!biz) return res.json([]);
    const rows = await db.query(`
      SELECT u.id, u.name, u.email,
        COUNT(o.id) as total_orders,
        SUM(o.total) as total_spent,
        MAX(o.created_at) as last_order
      FROM users u
      JOIN orders o ON o.customer_id=u.id
      WHERE o.business_id=$1 AND o.status IN ('delivered','completed')
      GROUP BY u.id, u.name, u.email
      ORDER BY total_spent DESC LIMIT 50
    `,[biz.id]);
    res.json(rows.rows);
  } catch(e){ res.status(500).json({error:e.message}); }
});

// ── ASSIGN COUPON TO USER ──
app.post('/api/admin/coupons/:id/assign', auth, async (req,res)=>{
  if(req.user.role!=='admin') return res.status(403).json({error:'No autorizado'});
  const {user_ids} = req.body; // array of user ids
  if(!user_ids?.length) return res.status(400).json({error:'user_ids requerido'});
  try {
    for(const uid of user_ids){
      const ucId = 'uc_'+Date.now()+'_'+uid.slice(-4);
      await db.query("INSERT INTO user_coupons(id,user_id,coupon_id,assigned_by) VALUES($1,$2,$3,$4) ON CONFLICT(user_id,coupon_id) DO NOTHING",
        [ucId, uid, req.params.id, req.user.id]);
    }
    res.json({ok:true, assigned: user_ids.length});
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.post('/api/owner/coupons/:id/assign', auth, async (req,res)=>{
  if(req.user.role!=='owner') return res.status(403).json({error:'No autorizado'});
  const {user_ids} = req.body;
  if(!user_ids?.length) return res.status(400).json({error:'user_ids requerido'});
  try {
    // Verify coupon belongs to owner's business
    const biz = await q1('SELECT id FROM businesses WHERE owner_id=$1',[req.user.id]);
    if(!biz) return res.status(403).json({error:'Sin negocio'});
    const coupon = await q1('SELECT id FROM coupons WHERE id=$1 AND (business_id=$2 OR created_by=$3)',
      [req.params.id, biz.id, req.user.id]);
    if(!coupon) return res.status(403).json({error:'Cupón no encontrado'});
    for(const uid of user_ids){
      const ucId = 'uc_'+Date.now()+'_'+uid.slice(-4);
      await db.query("INSERT INTO user_coupons(id,user_id,coupon_id,assigned_by) VALUES($1,$2,$3,$4) ON CONFLICT(user_id,coupon_id) DO NOTHING",
        [ucId, uid, req.params.id, req.user.id]);
    }
    res.json({ok:true, assigned: user_ids.length});
  } catch(e){ res.status(500).json({error:e.message}); }
});

// ── USER COUPONS (what the customer sees) ──
app.get('/api/my-coupons', auth, async (req,res)=>{
  try {
    const rows = await db.query(`
      SELECT c.*, uc.assigned_at, uc.used, uc.id as uc_id,
        b.name as business_name
      FROM user_coupons uc
      JOIN coupons c ON uc.coupon_id=c.id
      LEFT JOIN businesses b ON c.business_id=b.id
      WHERE uc.user_id=$1 AND uc.used=FALSE
        AND (c.expires_at IS NULL OR c.expires_at > NOW())
        AND c.active=TRUE
      ORDER BY uc.assigned_at DESC
    `,[req.user.id]);
    res.json(rows.rows);
  } catch(e){ res.json([]); }
});


// ── USER PROFILE UPDATE ──
app.patch('/api/user/profile', auth, async (req,res)=>{
  const {name, email, phone} = req.body;
  if (!name || !email) return res.status(400).json({error:'Nombre y email requeridos'});
  try {
    await db.query(
      'UPDATE users SET name=$1, email=$2, phone=$3 WHERE id=$4',
      [name.trim(), email.trim().toLowerCase(), phone||null, req.user.id]
    );
    const updated = await q1('SELECT id,name,email,phone,role,avatar_url FROM users WHERE id=$1',[req.user.id]);
    res.json({ok:true, user: updated});
  } catch(e) {
    if (e.code==='23505') return res.status(400).json({error:'Ese email ya está en uso'});
    res.status(500).json({error:e.message});
  }
});

// ── USER AVATAR UPLOAD ──
app.post('/api/user/avatar', auth, uploadMiddleware('photo'), async (req,res)=>{
  try {
    let url;
    if (req.file?.path) {
      url = req.file.path;
    } else if (req.file?.buffer) {
      const b64 = req.file.buffer.toString('base64');
      const dataURI = 'data:' + req.file.mimetype + ';base64,' + b64;
      const result = await cloudinary.uploader.upload(dataURI, {folder:'avatars', transformation:[{width:300,height:300,crop:'fill',gravity:'face'}]});
      url = result.secure_url;
    } else {
      return res.status(400).json({error:'No se recibió imagen'});
    }
    await db.query('UPDATE users SET avatar_url=$1 WHERE id=$2',[url, req.user.id]);
    res.json({ok:true, url});
  } catch(e) { res.status(500).json({error:e.message}); }
});


// ── PUBLIC PLAN PRICE ──
app.get('/api/public/plan-price', async (req,res)=>{
  await loadPlanPrice(); // always fresh from DB
  res.json({ price: PLAN_PRICE });
});

app.get('*',(_,res)=>res.sendFile(path.join(__dirname,'public','index.html')));

// ── Start ─────────────────────────────────────
initDB().then(()=>{
  server.listen(PORT,()=>{
    console.log(`\n⚡  Blow v3 → http://localhost:${PORT}`);
    console.log(`🐘  PostgreSQL  : ${process.env.DATABASE_URL?'✅ configurado':'❌ falta DATABASE_URL'}`);
    console.log(`☁️   Cloudinary  : ${cloudinary?'✅ configurado':'⚠️  no configurado'}`);
    console.log(`🔑  MP Token    : ${process.env.MP_ACCESS_TOKEN?.startsWith('APP_USR-')?'✅ OK':'❌ falta'}`);
    console.log(`🔐  JWT         : ${process.env.JWT_SECRET!=='dev_secret_cambiar_en_prod'?'✅ OK':'⚠️  cambiar'}\n`);
  });
}).catch(e=>{ console.error('❌ Error DB:',e.message); process.exit(1); });// ════════════════════════════════════════════════
//  MULTER + CLOUDINARY UPLOAD
// ════════════════════════════════════════════════
let multerUpload = null;
try {
  const multer = require('multer');
  if (cloudinary) {
    let storage;
    try {
      const { CloudinaryStorage } = require('multer-storage-cloudinary');
      storage = new CloudinaryStorage({
        cloudinary,
        params: (req, file) => ({
          folder: 'blow',
          allowed_formats: ['jpg','jpeg','png','webp'],
          transformation: [{ width: 1200, height: 800, crop: 'limit', quality: 'auto' }],
        }),
      });
    } catch(e2) {
      console.log('multer-storage-cloudinary not available, using memory storage:', e2.message);
      storage = multer.memoryStorage();
    }
    multerUpload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 } });
  } else {
    multerUpload = require('multer')({ dest: '/tmp/uploads/', limits: { fileSize: 5 * 1024 * 1024 } });
  }
} catch(e) { console.log('Multer not available:', e.message); }

function uploadMiddleware(field) {
  return (req, res, next) => {
    if (!multerUpload) return res.status(503).json({ error: 'Cloudinary no configurado' });
    multerUpload.single(field)(req, res, (err) => {
      if (err) return res.status(400).json({ error: err.message });
      next();
    });
  };
}



// ════════════════════════════════════════════════
//  ENDPOINTS FALTANTES — AGREGADOS
// ════════════════════════════════════════════════

// ── Search ───────────────────────────────────────
app.get('/api/search', async (req, res) => {
  try {
    const { q, city } = req.query;
    if (!q) return res.json({ businesses: [], products: [] });
    const term = `%${q}%`;
    const bizWhere = city ? 'AND b.city ILIKE $2' : '';
    const bizParams = city ? [term, city] : [term];
    const businesses = await qa(
      `SELECT b.*, (SELECT COUNT(*) FROM products WHERE business_id=b.id AND is_available=TRUE) as product_count
       FROM businesses b
       WHERE (b.name ILIKE $1 OR b.category ILIKE $1 OR b.description ILIKE $1 OR b.tags ILIKE $1) ${bizWhere}
       ORDER BY b.rating DESC LIMIT 10`, bizParams);
    const products = await qa(
      `SELECT p.*, b.name as business_name, b.id as business_id
       FROM products p JOIN businesses b ON p.business_id=b.id
       WHERE (p.name ILIKE $1 OR p.description ILIKE $1) AND p.is_available=TRUE
       ORDER BY p.name LIMIT 10`, [term]);
    res.json({ businesses, products });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Products ─────────────────────────────────────
app.get('/api/products/:id', async (req, res) => {
  try {
    const p = await q1('SELECT p.*, b.name as business_name FROM products p JOIN businesses b ON p.business_id=b.id WHERE p.id=$1', [req.params.id]);
    if (!p) return res.status(404).json({ error: 'No encontrado' });
    const photos = await qa('SELECT * FROM product_photos WHERE product_id=$1 ORDER BY sort_order', [req.params.id]);
    const variants = await qa('SELECT * FROM product_variants WHERE product_id=$1 ORDER BY sort_order', [req.params.id]);
    res.json({ ...p, photos, variants });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Favorites ─────────────────────────────────────
app.get('/api/favorites', auth, async (req, res) => {
  try {
    const favs = await qa(
      `SELECT f.*, p.name, p.price, p.emoji, p.photo_url, b.name as business_name
       FROM favorites f
       JOIN products p ON f.product_id=p.id
       JOIN businesses b ON f.business_id=b.id
       WHERE f.user_id=$1 ORDER BY f.created_at DESC`, [req.user.id]);
    res.json(favs);
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/favorites', auth, async (req, res) => {
  try {
    const { product_id, business_id } = req.body;
    const id = uuid();
    await q('INSERT INTO favorites (id,user_id,product_id,business_id) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING',
      [id, req.user.id, product_id, business_id]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/favorites/:product_id', auth, async (req, res) => {
  try {
    await q('DELETE FROM favorites WHERE user_id=$1 AND product_id=$2', [req.user.id, req.params.product_id]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Reviews ──────────────────────────────────────
app.get('/api/businesses/:id/reviews', async (req, res) => {
  try {
    const reviews = await qa(
      `SELECT r.*, u.name as user_name, u.avatar_url FROM order_reviews r
       JOIN users u ON r.user_id=u.id
       WHERE r.business_id=$1 ORDER BY r.created_at DESC LIMIT 20`, [req.params.id]);
    res.json(reviews);
  } catch(e) { res.json([]); }
});
app.post('/api/orders/:id/review', auth, async (req, res) => {
  try {
    const { rating, comment } = req.body;
    const order = await q1('SELECT * FROM orders WHERE id=$1 AND customer_id=$2', [req.params.id, req.user.id]);
    if (!order) return res.status(404).json({ error: 'No encontrado' });
    if (order.status !== 'delivered') return res.status(400).json({ error: 'Solo se pueden reseñar pedidos entregados' });
    const id = uuid();
    await q('INSERT INTO order_reviews (id,order_id,business_id,user_id,rating,comment) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (order_id) DO UPDATE SET rating=$5,comment=$6',
      [id, order.id, order.business_id, req.user.id, rating, comment || '']);
    const avg = await q1('SELECT AVG(rating) as avg FROM order_reviews WHERE business_id=$1', [order.business_id]);
    await q('UPDATE businesses SET rating=$1 WHERE id=$2', [parseFloat(avg.avg || 4.5).toFixed(1), order.business_id]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/businesses/mine/reviews', auth, role('owner'), async (req, res) => {
  try {
    const biz = await q1('SELECT id FROM businesses WHERE owner_id=$1', [req.user.id]);
    if (!biz) return res.json([]);
    const reviews = await qa(
      `SELECT r.*, u.name as user_name, u.avatar_url FROM order_reviews r
       JOIN users u ON r.user_id=u.id
       WHERE r.business_id=$1 ORDER BY r.created_at DESC`, [biz.id]);
    res.json(reviews);
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.patch('/api/reviews/:id/reply', auth, role('owner'), async (req, res) => {
  try {
    const { reply } = req.body;
    await q('UPDATE order_reviews SET owner_reply=$1 WHERE id=$2', [reply, req.params.id]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Order messages (chat) ────────────────────────
app.get('/api/orders/:id/messages', auth, async (req, res) => {
  try {
    const order = await q1('SELECT * FROM orders WHERE id=$1', [req.params.id]);
    if (!order) return res.status(404).json({ error: 'No encontrado' });
    const msgs = await qa('SELECT m.*, u.name as sender_name FROM order_messages m JOIN users u ON m.sender_id=u.id WHERE m.order_id=$1 ORDER BY m.created_at ASC', [req.params.id]);
    res.json(msgs);
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/orders/:id/messages', auth, async (req, res) => {
  try {
    const { body } = req.body;
    const order = await q1('SELECT * FROM orders WHERE id=$1', [req.params.id]);
    if (!order) return res.status(404).json({ error: 'No encontrado' });
    const id = uuid();
    await q('INSERT INTO order_messages (id,order_id,sender_id,body) VALUES ($1,$2,$3,$4)', [id, req.params.id, req.user.id, body]);
    // Notificar al otro participante
    const targetId = req.user.id === order.customer_id ? order.business_id : order.customer_id;
    notify(targetId, { type: 'order_message', message: '💬 Nuevo mensaje en tu pedido', order_id: order.id });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Support chat (usuario ↔ admin) ───────────────
app.get('/api/support/messages', auth, async (req, res) => {
  try {
    const msgs = await qa('SELECT m.*, u.name as sender_name FROM support_messages m JOIN users u ON m.sender_id=u.id WHERE m.user_id=$1 ORDER BY m.created_at ASC', [req.user.id]);
    res.json(msgs);
  } catch(e) { res.json([]); }
});
app.post('/api/support/messages', auth, async (req, res) => {
  try {
    const { body } = req.body;
    const id = uuid();
    await q('INSERT INTO support_messages (id,user_id,sender_id,body,is_admin) VALUES ($1,$2,$3,$4,FALSE)', [id, req.user.id, req.user.id, body]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/admin/support/conversations', auth, role('admin'), async (req, res) => {
  try {
    const convos = await qa(
      `SELECT u.id as user_id, u.name, u.email, u.avatar_url,
        (SELECT body FROM support_messages WHERE user_id=u.id ORDER BY created_at DESC LIMIT 1) as last_message,
        (SELECT created_at FROM support_messages WHERE user_id=u.id ORDER BY created_at DESC LIMIT 1) as last_at,
        (SELECT COUNT(*) FROM support_messages WHERE user_id=u.id AND is_admin=FALSE AND read_at IS NULL) as unread
       FROM users u WHERE EXISTS (SELECT 1 FROM support_messages WHERE user_id=u.id)
       ORDER BY last_at DESC`, []);
    res.json(convos);
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/admin/support/messages/:userId', auth, role('admin'), async (req, res) => {
  try {
    await q('UPDATE support_messages SET read_at=NOW() WHERE user_id=$1 AND is_admin=FALSE AND read_at IS NULL', [req.params.userId]);
    const msgs = await qa('SELECT m.*, u.name as sender_name FROM support_messages m JOIN users u ON m.sender_id=u.id WHERE m.user_id=$1 ORDER BY m.created_at ASC', [req.params.userId]);
    res.json(msgs);
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/admin/support/messages/:userId', auth, role('admin'), async (req, res) => {
  try {
    const { body } = req.body;
    const id = uuid();
    await q('INSERT INTO support_messages (id,user_id,sender_id,body,is_admin) VALUES ($1,$2,$3,$4,TRUE)', [id, req.params.userId, req.user.id, body]);
    notify(req.params.userId, { type: 'support_message', message: '💬 Respuesta del equipo Blow' });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Category banners & featured ──────────────────
app.get('/api/category-banners', async (req, res) => {
  try {
    const { category_id } = req.query;
    const rows = category_id
      ? await qa('SELECT * FROM category_banners WHERE category_id=$1 AND active=TRUE ORDER BY sort_order', [category_id])
      : await qa('SELECT * FROM category_banners WHERE active=TRUE ORDER BY sort_order', []);
    res.json(rows);
  } catch(e) { res.json([]); }
});
app.get('/api/category-featured', async (req, res) => {
  try {
    const { category_id } = req.query;
    const rows = category_id
      ? await qa(`SELECT cf.*, b.name as business_name, b.logo_url, b.rating, b.delivery_time, b.delivery_cost
                  FROM category_featured cf JOIN businesses b ON cf.business_id=b.id
                  WHERE cf.category_id=$1 AND cf.active=TRUE ORDER BY cf.sort_order`, [category_id])
      : await qa(`SELECT cf.*, b.name as business_name FROM category_featured cf JOIN businesses b ON cf.business_id=b.id WHERE cf.active=TRUE ORDER BY cf.sort_order`, []);
    res.json(rows);
  } catch(e) { res.json([]); }
});
app.get('/api/admin/category-banners', auth, role('admin'), async (req, res) => {
  try { res.json(await qa('SELECT * FROM category_banners ORDER BY sort_order', [])); }
  catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/admin/category-banners', auth, role('admin'), async (req, res) => {
  try {
    const { category_id, title, subtitle, bg_color, link_business_id, sort_order } = req.body;
    const id = uuid();
    await q('INSERT INTO category_banners (id,category_id,title,subtitle,bg_color,link_business_id,sort_order) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [id, category_id, title||'', subtitle||'', bg_color||'#FA0050', link_business_id||null, sort_order||0]);
    res.json({ id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.patch('/api/admin/category-banners/:id', auth, role('admin'), async (req, res) => {
  try {
    const { active, title, subtitle, bg_color } = req.body;
    await q('UPDATE category_banners SET active=COALESCE($1,active),title=COALESCE($2,title),subtitle=COALESCE($3,subtitle),bg_color=COALESCE($4,bg_color) WHERE id=$5',
      [active, title, subtitle, bg_color, req.params.id]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/admin/category-banners/:id', auth, role('admin'), async (req, res) => {
  try { await q('DELETE FROM category_banners WHERE id=$1', [req.params.id]); res.json({ success: true }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/admin/category-banners/:id/upload-image', auth, role('admin'), uploadMiddleware('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No image' });
    const result = await cloudinary.uploader.upload(`data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`, { folder: 'blow/cat-banners' });
    await q('UPDATE category_banners SET image_url=$1 WHERE id=$2', [result.secure_url, req.params.id]);
    res.json({ url: result.secure_url });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Category featured ────────────────────────────
app.get('/api/admin/category-featured', auth, role('admin'), async (req, res) => {
  try { res.json(await qa('SELECT cf.*, b.name as business_name FROM category_featured cf JOIN businesses b ON cf.business_id=b.id ORDER BY cf.sort_order', [])); }
  catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/admin/category-featured', auth, role('admin'), async (req, res) => {
  try {
    const { category_id, business_id, sort_order } = req.body;
    const id = uuid();
    await q('INSERT INTO category_featured (id,category_id,business_id,sort_order) VALUES ($1,$2,$3,$4)',
      [id, category_id, business_id, sort_order||0]);
    res.json({ id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.patch('/api/admin/category-featured/:id', auth, role('admin'), async (req, res) => {
  try {
    const { active } = req.body;
    await q('UPDATE category_featured SET active=$1 WHERE id=$2', [active, req.params.id]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/admin/category-featured/:id', auth, role('admin'), async (req, res) => {
  try { await q('DELETE FROM category_featured WHERE id=$1', [req.params.id]); res.json({ success: true }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Subcategories ────────────────────────────────
app.get('/api/subcategories', async (req, res) => {
  try {
    const { category_id } = req.query;
    const rows = category_id
      ? await qa('SELECT * FROM business_subcategories WHERE category_id=$1 AND is_active=TRUE ORDER BY sort_order', [category_id])
      : await qa('SELECT * FROM business_subcategories WHERE is_active=TRUE ORDER BY sort_order', []);
    res.json(rows);
  } catch(e) { res.json([]); }
});
app.get('/api/admin/subcategories', auth, role('admin'), async (req, res) => {
  try { res.json(await qa('SELECT * FROM business_subcategories ORDER BY sort_order', [])); }
  catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/admin/subcategories', auth, role('admin'), async (req, res) => {
  try {
    const { category_id, name, emoji, sort_order } = req.body;
    const id = uuid();
    await q('INSERT INTO business_subcategories (id,category_id,name,emoji,sort_order) VALUES ($1,$2,$3,$4,$5)',
      [id, category_id, name, emoji||'🍽️', sort_order||0]);
    res.json({ id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.patch('/api/admin/subcategories/:id', auth, role('admin'), async (req, res) => {
  try {
    const { is_active, name, emoji } = req.body;
    await q('UPDATE business_subcategories SET is_active=COALESCE($1,is_active),name=COALESCE($2,name),emoji=COALESCE($3,emoji) WHERE id=$4',
      [is_active, name, emoji, req.params.id]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/admin/subcategories/:id', auth, role('admin'), async (req, res) => {
  try { await q('DELETE FROM business_subcategories WHERE id=$1', [req.params.id]); res.json({ success: true }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/admin/subcategories/:id/upload-image', auth, role('admin'), uploadMiddleware('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No image' });
    const result = await cloudinary.uploader.upload(`data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`, { folder: 'blow/subcats' });
    await q('UPDATE business_subcategories SET image_url=$1 WHERE id=$2', [result.secure_url, req.params.id]);
    res.json({ url: result.secure_url });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Auth: Forgot / Reset password ────────────────
app.post('/api/auth/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    const user = await q1('SELECT id,name FROM users WHERE email=$1', [email]);
    if (!user) return res.json({ success: true }); // no revelar si existe
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const id = uuid();
    await q('DELETE FROM email_verifications WHERE email=$1', [email]);
    await q('INSERT INTO email_verifications (id,email,code,data,expires_at) VALUES ($1,$2,$3,$4,NOW()+INTERVAL \'15 minutes\')',
      [id, email, code, JSON.stringify({ type: 'reset' })]);
    // Enviar email con código
    const resend = require('resend');
    const r = new resend.Resend(process.env.RESEND_API_KEY);
    await r.emails.send({
      from: 'Blow <noreply@blow.uy>',
      to: email,
      subject: 'Resetear contraseña — Blow',
      html: `<p>Hola ${user.name},</p><p>Tu código para resetear la contraseña es: <strong>${code}</strong></p><p>Expira en 15 minutos.</p>`
    });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/auth/reset-password', async (req, res) => {
  try {
    const { email, code, new_password } = req.body;
    const ver = await q1('SELECT * FROM email_verifications WHERE email=$1 AND code=$2 AND expires_at>NOW()', [email, code]);
    if (!ver) return res.status(400).json({ error: 'Código inválido o expirado' });
    const bcrypt = require('bcrypt');
    const hash = await bcrypt.hash(new_password, 10);
    await q('UPDATE users SET password=$1 WHERE email=$2', [hash, email]);
    await q('DELETE FROM email_verifications WHERE email=$1', [email]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Admin: ban users ─────────────────────────────
app.post('/api/admin/users/:id/ban', auth, role('admin'), async (req, res) => {
  try {
    const { banned, reason } = req.body;
    await q('UPDATE users SET banned=$1, ban_reason=$2 WHERE id=$3', [banned, reason||'', req.params.id]);
    if (banned) notify(req.params.id, { type: 'account_banned', message: '🚫 Tu cuenta fue suspendida' });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Admin: toggle business open ──────────────────
app.post('/api/admin/businesses/:id/toggle-open', auth, role('admin'), async (req, res) => {
  try {
    const biz = await q1('SELECT is_open FROM businesses WHERE id=$1', [req.params.id]);
    if (!biz) return res.status(404).json({ error: 'No encontrado' });
    await q('UPDATE businesses SET is_open=$1 WHERE id=$2', [!biz.is_open, req.params.id]);
    res.json({ is_open: !biz.is_open });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Admin: impersonate ───────────────────────────
app.post('/api/admin/impersonate/:id', auth, role('admin'), async (req, res) => {
  try {
    const user = await q1('SELECT * FROM users WHERE id=$1', [req.params.id]);
    if (!user) return res.status(404).json({ error: 'No encontrado' });
    const token = jwt.sign({ id: user.id, role: user.role, email: user.email }, JWT_SECRET, { expiresIn: '2h' });
    res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role } });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Admin: orders cancel ─────────────────────────
app.post('/api/admin/orders/:id/cancel', auth, role('admin'), async (req, res) => {
  try {
    const { reason } = req.body;
    const order = await q1('SELECT * FROM orders WHERE id=$1', [req.params.id]);
    if (!order) return res.status(404).json({ error: 'No encontrado' });
    await q("UPDATE orders SET status='cancelled',cancel_reason=$2,updated_at=NOW() WHERE id=$1", [order.id, reason||'']);
    notify(order.customer_id, { type: 'order_cancelled', message: '❌ Tu pedido fue cancelado por admin', order_id: order.id });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Admin: subscriptions detail ──────────────────
app.get('/api/admin/subscriptions/detail', auth, role('admin'), async (req, res) => {
  try {
    const subs = await qa(
      `SELECT s.*, b.name as business_name, b.city, u.name as owner_name, u.email as owner_email
       FROM subscriptions s
       JOIN businesses b ON s.business_id=b.id
       JOIN users u ON s.owner_id=u.id
       ORDER BY s.created_at DESC`, []);
    res.json(subs);
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/admin/subscriptions/:id/cancel-notify', auth, role('admin'), async (req, res) => {
  try {
    const { reason } = req.body;
    const sub = await q1('SELECT s.*,u.email,u.name FROM subscriptions s JOIN users u ON s.owner_id=u.id WHERE s.id=$1', [req.params.id]);
    if (!sub) return res.status(404).json({ error: 'No encontrado' });
    await q("UPDATE subscriptions SET status='cancelled',cancelled_at=NOW() WHERE id=$1", [req.params.id]);
    notify(sub.owner_id, { type: 'subscription_cancelled', message: `⚠️ Tu suscripción fue cancelada${reason?' — '+reason:''}` });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

