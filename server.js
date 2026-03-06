// ════════════════════════════════════════════════
//  Blow — Backend v3.0
//  Node.js + Express + PostgreSQL + Cloudinary + MercadoPago + WebSockets
// ════════════════════════════════════════════════
require('dotenv').config();
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
const server = http.createServer(app);
const PORT   = process.env.PORT || 3000;
const JWT_SECRET   = process.env.JWT_SECRET || 'dev_secret_cambiar_en_prod';
const PLATFORM_FEE = parseFloat(process.env.PLATFORM_FEE_PERCENT || 10) / 100;
const APP_URL      = process.env.APP_URL || `http://localhost:${PORT}`;

// ── Plan único ────────────────────────────────
const PLAN_PRICE = 2990; // $UYU por mes
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
      expires_at TIMESTAMPTZ DEFAULT NOW() + INTERVAL '2 hours'
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
    ALTER TABLE promotions ADD COLUMN IF NOT EXISTS blow_plus_only BOOLEAN DEFAULT FALSE;

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
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Helpers ───────────────────────────────────
const sign = u => jwt.sign({ id:u.id, name:u.name, email:u.email, role:u.role }, JWT_SECRET, { expiresIn:'30d' });
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
app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, email, phone='', password } = req.body;
    const r = 'customer'; // Always customer — owners register via separate flow
    if (!name || !email || !password) return res.status(400).json({ error:'Nombre, email y contraseña son obligatorios' });
    if (password.length < 6) return res.status(400).json({ error:'La contraseña debe tener al menos 6 caracteres' });
    const emailLow = email.toLowerCase().trim();
    if (await q1('SELECT id FROM users WHERE email=$1', [emailLow])) return res.status(409).json({ error:'Este email ya está registrado' });
    const id = uuid();
    await q('INSERT INTO users (id,name,email,phone,password,role) VALUES ($1,$2,$3,$4,$5,$6)',
      [id, name.trim(), emailLow, phone, await bcrypt.hash(password,10), r]);
    const user = { id, name:name.trim(), email:emailLow, role:r };
    res.status(201).json({ token:sign(user), user });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error:'Email y contraseña requeridos' });
    const u = await q1('SELECT * FROM users WHERE email=$1', [email.toLowerCase().trim()]);
    if (!u || !(await bcrypt.compare(password, u.password))) return res.status(401).json({ error:'Email o contraseña incorrectos' });
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

    // Store registration data temporarily
    const regId = uuid();
    await q('INSERT INTO pending_registrations (id,data) VALUES ($1,$2)',
      [regId, JSON.stringify({ bizName,category,address,city,department,name,email:emailLow,password,phone })]);

    // Demo mode — skip payment
    if (!mp || !process.env.MP_ACCESS_TOKEN?.startsWith('APP_USR-')) {
      return res.json({ reg_id: regId, demo: true });
    }

    // Create MP preference (one-time first payment)
    const pref = await mp.preferences.create({
      items: [{ title:`Blow — Suscripción mensual`, quantity:1, unit_price:PLAN_PRICE, currency_id:'UYU' }],
      payer: { name, email: emailLow },
      external_reference: `reg:${regId}`,
      back_urls: {
        success: `${APP_URL}/owner?reg=${regId}&payment=success`,
        failure: `${APP_URL}/owner-login?reg=${regId}&payment=failure`,
        pending: `${APP_URL}/owner-login?reg=${regId}&payment=pending`,
      },
      auto_return: 'approved',
      notification_url: `${APP_URL}/api/webhooks/mp`,
    });

    await q('UPDATE pending_registrations SET mp_preference_id=$1 WHERE id=$2',[pref.body.id, regId]);
    res.json({ reg_id: regId, init_point: pref.body.init_point });
  } catch(e) { console.error('Register initiate error:', e); res.status(500).json({ error: e.message }); }
});

// Step 2: Complete registration after payment confirmed
app.post('/api/register/complete', async (req, res) => {
  try {
    const { reg_id } = req.body;
    const pending = await q1('SELECT * FROM pending_registrations WHERE id=$1',[reg_id]);
    if (!pending) return res.status(404).json({ error:'Registro no encontrado o expirado' });
    if (new Date() > new Date(pending.expires_at))
      return res.status(400).json({ error:'El registro expiró. Intentá de nuevo.' });

    const d = pending.data;
    // Check email not taken since
    if (await q1('SELECT id FROM users WHERE email=$1',[d.email]))
      return res.status(409).json({ error:'Este email ya está registrado' });

    // Create user
    const userId = uuid();
    await q('INSERT INTO users (id,name,email,phone,password,role,city,department) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [userId, d.name, d.email, d.phone||'', await bcrypt.hash(d.password,10), 'owner', d.city, d.department||'']);

    // Create business
    const bizId = uuid();
    await q('INSERT INTO businesses (id,owner_id,name,category,address,city,department) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [bizId, userId, d.bizName, d.category, d.address||'', d.city, d.department||'']);

    // Create active subscription
    const periodEnd = new Date(); periodEnd.setMonth(periodEnd.getMonth()+1);
    await q('INSERT INTO subscriptions (id,business_id,owner_id,plan,status,current_period_start,current_period_end) VALUES ($1,$2,$3,$4,$5,NOW(),$6)',
      [uuid(), bizId, userId, 'active', 'active', periodEnd.toISOString()]);

    // Clean up pending registration
    await q('DELETE FROM pending_registrations WHERE id=$1',[reg_id]);

    const user = { id:userId, name:d.name, email:d.email, role:'owner' };
    res.status(201).json({ token:sign(user), user, message:'¡Cuenta creada! Bienvenido a Blow.' });
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

  const pref = await mp.preferences.create({
    items: [{ title:'Blow — Renovación mensual', quantity:1, unit_price:PLAN_PRICE, currency_id:'UYU' }],
    payer: { name:owner.name, email:owner.email },
    external_reference: `renew:${b.id}`,
    back_urls: {
      success: `${APP_URL}/owner?payment=success`,
      failure: `${APP_URL}/owner-login?payment=failure`,
    },
    auto_return: 'approved',
    notification_url: `${APP_URL}/api/webhooks/mp`,
  });
  res.json({ init_point: pref.body.init_point });
});

// Cancel subscription
app.post('/api/subscription/cancel', auth, role('owner'), async (req, res) => {
  const b = await q1('SELECT * FROM businesses WHERE owner_id=$1',[req.user.id]);
  if (!b) return res.status(404).json({ error:'Sin negocio' });
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
    const plat=parseFloat((subtotal*PLATFORM_FEE).toFixed(2)), bizAmt=parseFloat((subtotal-plat).toFixed(2));
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
  if (!['pending','confirmed'].includes(order.status)) return res.status(400).json({ error:'No se puede cancelar' });
  if (req.user.role==='customer'&&order.customer_id!==req.user.id) return res.status(403).json({ error:'No es tu pedido' });
  await q("UPDATE orders SET status='cancelled',updated_at=NOW() WHERE id=$1",[order.id]);
  const biz=await q1('SELECT owner_id FROM businesses WHERE id=$1',[order.business_id]);
  if (biz) notify(biz.owner_id,{ type:'order_cancelled',message:`❌ Pedido cancelado`,order_id:order.id });
  res.json({ success:true });
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
  res.json({ success:true });
});
app.get('/api/admin/platform', auth, role('admin'), async (req, res) => {
  const wallet=await q1("SELECT * FROM wallets WHERE owner_id='platform'",[]);
  const txs=wallet?.id?await qa('SELECT * FROM transactions WHERE wallet_id=$1 ORDER BY created_at DESC LIMIT 30',[wallet.id]):[];
  res.json({ balance:parseFloat(wallet?.balance)||0,transactions:txs,fee_percent:process.env.PLATFORM_FEE_PERCENT||10 });
});

// ════════════════════════════════════════════════
//  WEBHOOK MERCADOPAGO
// ════════════════════════════════════════════════
app.post('/api/webhooks/mp', async (req, res) => {
  res.sendStatus(200);
  try {
    const { type,data,topic,id }=req.body;
    const paymentId=data?.id||id;
    if ((type||topic)!=='payment'||!paymentId||!mp) return;
    const payment=(await mp.payment.get(paymentId)).body;
    const extRef=payment.external_reference;
    if (!extRef) return;

    // ── Blow+ payment ──────────────────────────────
    if (extRef.startsWith('blowplus:') && payment.status==='approved') {
      const bizId = extRef.replace('blowplus:','');
      await q(`UPDATE businesses SET blow_plus=TRUE, blow_plus_since=NOW(),
        blow_plus_expires=NOW()+INTERVAL '30 days', blow_plus_mp_id=$1 WHERE id=$2`,
        [String(payment.id), bizId]);
      return;
    }

    // ── Blow+ cliente payment ───────────────────────
    if (extRef.startsWith('blowplususer:') && payment.status==='approved') {
      const userId = extRef.replace('blowplususer:','');
      await q(`UPDATE users SET blow_plus=TRUE, blow_plus_since=NOW(), blow_plus_expires=NOW()+INTERVAL '30 days' WHERE id=$1`, [userId]);
      return;
    }

    // ── Subscription registration payment ──────────
    if (extRef.startsWith('reg:') && payment.status==='approved') {
      const regId = extRef.replace('reg:','');
      const pending = await q1('SELECT * FROM pending_registrations WHERE id=$1',[regId]);
      if (pending && pending.status==='pending') {
        await q("UPDATE pending_registrations SET status='paid' WHERE id=$1",[regId]);
      }
      return;
    }

    // ── Order payment ──────────────────────────────
    const orderId=extRef;
    const order=await q1('SELECT * FROM orders WHERE id=$1',[orderId]);
    if (!order) return;
    await q('UPDATE orders SET mp_payment_id=$1,mp_status=$2,updated_at=NOW() WHERE id=$3',[String(payment.id),payment.status,orderId]);
    if (payment.status==='approved'&&order.status==='pending') {
      await q("UPDATE orders SET status='confirmed',updated_at=NOW() WHERE id=$1",[orderId]);
      const biz=await q1('SELECT * FROM businesses WHERE id=$1',[order.business_id]);
      if (biz) notify(biz.owner_id,{ type:'new_order',message:`💰 Pago confirmado! #${orderId.slice(-6).toUpperCase()}`,order_id:orderId,total:order.total });
      notify(order.customer_id,{ type:'status_change',message:'✅ Pago recibido!',status:'confirmed',order_id:orderId });
    }
    if (order && ['rejected','cancelled'].includes(payment.status)&&order.status==='pending')
      await q("UPDATE orders SET status='cancelled',updated_at=NOW() WHERE id=$1",[orderId]);
  } catch(e) { console.error('Webhook error:',e.message); }
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
app.get('/api',(_,res)=>res.json({ app:'Blow API v3',db:'PostgreSQL',status:'running' }));
app.get('/admin',(_,res)=>res.sendFile(path.join(__dirname,'public','admin.html')));
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


