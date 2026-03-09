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
    if (r1) { const v = parseFloat(JSON.parse(r1.value)); PLAN_PRICE = (isNaN(v) || v < 1) ? 2990 : v; return; }
    const r2 = await q1("SELECT value FROM app_settings WHERE key='plan_price'", []);
    if (r2) { const v = parseFloat(JSON.parse(r2.value)); PLAN_PRICE = (isNaN(v) || v < 1) ? 2990 : v; }
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
  // Also send push notification (works when app is closed)
  // Map event types to human-readable push titles/bodies
  const pushMap = {
    new_order:       { title: '🛍️ Nuevo pedido', body: payload.message },
    order_cancelled: { title: '❌ Pedido cancelado', body: payload.message },
    status_change:   { title: '📦 Tu pedido fue actualizado', body: payload.message },
    owner_message:   { title: `💬 ${payload.business_name || 'Tu negocio'}`, body: payload.message },
    refund_issued:   { title: '💸 Reembolso procesado', body: payload.message },
  };
  const push = pushMap[payload.type];
  if (push) {
    sendPush(userId, {
      title: push.title,
      body: push.body,
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-72.png',
      tag: payload.order_id || payload.type,
      url: payload.order_id ? `/?order=${payload.order_id}` : '/',
      data: payload,
    }).catch(() => {});
  }
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
      rating REAL DEFAULT NULL, delivery_time TEXT DEFAULT '20-35',
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
    ALTER TABLE businesses ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE;
    ALTER TABLE businesses ADD COLUMN IF NOT EXISTS city TEXT DEFAULT '';
    ALTER TABLE businesses ADD COLUMN IF NOT EXISTS department TEXT DEFAULT '';
    -- Reset ratings for businesses with fewer than 3 reviews (removes hardcoded defaults)
    UPDATE businesses SET rating = NULL WHERE id NOT IN (
      SELECT business_id FROM reviews GROUP BY business_id HAVING COUNT(*) >= 3
    );
    ALTER TABLE businesses ADD COLUMN IF NOT EXISTS schedule JSONB DEFAULT NULL;
    ALTER TABLE businesses ADD COLUMN IF NOT EXISTS schedule_enabled BOOLEAN DEFAULT FALSE;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS owner_message TEXT DEFAULT NULL;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS owner_message_at TIMESTAMPTZ DEFAULT NULL;
    ALTER TABLE products ADD COLUMN IF NOT EXISTS stock INTEGER DEFAULT NULL;
    ALTER TABLE businesses ADD COLUMN IF NOT EXISTS lat REAL DEFAULT NULL;
    ALTER TABLE businesses ADD COLUMN IF NOT EXISTS lng REAL DEFAULT NULL;
    ALTER TABLE businesses ADD COLUMN IF NOT EXISTS delivery_radius_km REAL DEFAULT NULL;
    ALTER TABLE businesses ADD COLUMN IF NOT EXISTS onboarding_done BOOLEAN DEFAULT FALSE;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS refund_status TEXT DEFAULT NULL;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS refund_id TEXT DEFAULT NULL;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS refunded_at TIMESTAMPTZ DEFAULT NULL;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMPTZ DEFAULT NULL;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS preparing_at TIMESTAMPTZ DEFAULT NULL;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS ready_at TIMESTAMPTZ DEFAULT NULL;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS eta_minutes INTEGER DEFAULT NULL;
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      endpoint TEXT NOT NULL UNIQUE,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS reviews (
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
      customer_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
      comment TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(order_id)
    );
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
      expires_at TIMESTAMPTZ DEFAULT NOW() + INTERVAL '15 minutes',
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

    CREATE TABLE IF NOT EXISTS main_banners (
      id TEXT PRIMARY KEY,
      slot INTEGER NOT NULL DEFAULT 0,
      tag TEXT DEFAULT '🔥 Oferta especial',
      title TEXT NOT NULL DEFAULT 'Banner',
      subtitle TEXT DEFAULT '',
      subtitle_highlight TEXT DEFAULT '',
      emoji TEXT DEFAULT '🍔',
      bg_color TEXT DEFAULT '#2558d4',
      cta_text TEXT DEFAULT '¡Ver ofertas!',
      link TEXT DEFAULT '',
      active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    -- Loyalty points
    CREATE TABLE IF NOT EXISTS loyalty_points (
      id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      business_id TEXT REFERENCES businesses(id) ON DELETE CASCADE,
      points INTEGER NOT NULL DEFAULT 0,
      reason TEXT,
      order_id TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS loyalty_config (
      business_id TEXT PRIMARY KEY REFERENCES businesses(id) ON DELETE CASCADE,
      points_per_100 INTEGER DEFAULT 1,
      redeem_points INTEGER DEFAULT 100,
      redeem_discount INTEGER DEFAULT 50,
      enabled BOOLEAN DEFAULT TRUE
    );
    -- Scheduled orders
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS scheduled_for TIMESTAMPTZ DEFAULT NULL;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS is_scheduled BOOLEAN DEFAULT FALSE;
    -- Cash / in-person payment support
    ALTER TABLE orders  ADD COLUMN IF NOT EXISTS payment_method TEXT DEFAULT 'online';
    ALTER TABLE orders  ADD COLUMN IF NOT EXISTS pay_on_delivery BOOLEAN DEFAULT FALSE;
    ALTER TABLE businesses ADD COLUMN IF NOT EXISTS accepts_cash    BOOLEAN DEFAULT FALSE;
    ALTER TABLE businesses ADD COLUMN IF NOT EXISTS accepts_card_pos BOOLEAN DEFAULT FALSE;
    -- Business news / posts
    CREATE TABLE IF NOT EXISTS business_news (
      id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
      business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      body TEXT DEFAULT '',
      emoji TEXT DEFAULT '📢',
      image_url TEXT DEFAULT NULL,
      active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    -- Saved addresses (if not exists)
    CREATE TABLE IF NOT EXISTS user_addresses (
      id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      label TEXT DEFAULT 'Casa',
      full_address TEXT NOT NULL,
      city TEXT DEFAULT '',
      department TEXT DEFAULT '',
      lat REAL DEFAULT NULL,
      lng REAL DEFAULT NULL,
      is_active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    -- ── Performance indexes ──────────────────────
    CREATE INDEX IF NOT EXISTS idx_orders_customer_id    ON orders(customer_id);
    CREATE INDEX IF NOT EXISTS idx_orders_business_id    ON orders(business_id);
    CREATE INDEX IF NOT EXISTS idx_orders_status         ON orders(status);
    CREATE INDEX IF NOT EXISTS idx_orders_created_at     ON orders(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_orders_mp_payment_id  ON orders(mp_payment_id) WHERE mp_payment_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_products_business_id  ON products(business_id);
    CREATE INDEX IF NOT EXISTS idx_products_available    ON products(business_id, is_available);
    CREATE INDEX IF NOT EXISTS idx_businesses_city       ON businesses(city);
    CREATE INDEX IF NOT EXISTS idx_businesses_category   ON businesses(category);
    CREATE INDEX IF NOT EXISTS idx_businesses_is_open    ON businesses(is_open, plan) WHERE plan IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_order_items_order_id  ON order_items(order_id);
    CREATE INDEX IF NOT EXISTS idx_reviews_business_id   ON reviews(business_id);
    CREATE INDEX IF NOT EXISTS idx_loyalty_user_biz      ON loyalty_points(user_id, business_id);
    CREATE INDEX IF NOT EXISTS idx_push_subs_user_id     ON push_subscriptions(user_id);
    CREATE INDEX IF NOT EXISTS idx_help_msgs_user_id     ON help_messages(user_id) WHERE user_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_user_addresses_user   ON user_addresses(user_id);
    CREATE INDEX IF NOT EXISTS idx_business_news_biz     ON business_news(business_id, active);
    -- Full-text search index on products and businesses
    CREATE INDEX IF NOT EXISTS idx_products_name_fts     ON products USING gin(to_tsvector('spanish', name || ' ' || COALESCE(description, '')));
    CREATE INDEX IF NOT EXISTS idx_businesses_name_fts   ON businesses USING gin(to_tsvector('spanish', name));
    -- Rider GPS positions (upserted, one row per active order)
    CREATE TABLE IF NOT EXISTS rider_locations (
      order_id TEXT PRIMARY KEY REFERENCES orders(id) ON DELETE CASCADE,
      rider_id TEXT NOT NULL,
      lat REAL NOT NULL,
      lng REAL NOT NULL,
      heading REAL DEFAULT 0,
      speed REAL DEFAULT 0,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_rider_locations_rider ON rider_locations(rider_id);
  `);
  
  // Seed default main banners if none exist
  const bannerCount = await q1('SELECT COUNT(*) as c FROM main_banners',[]);
  if (parseInt(bannerCount.c) === 0) {
    const defaultBanners = [
      { id:'mb_0', slot:0, tag:'🔥 Oferta especial', title:'Hasta 40% OFF\n+ Envíos gratis', subtitle:'Con débito Santander', subtitle_highlight:'+10% OFF adicional', emoji:'🍕', bg_color:'#2558d4', cta_text:'¡Ver ofertas!' },
      { id:'mb_1', slot:1, tag:'⚡ Rápido', title:'Pedí en\nminutos', subtitle:'Locales abiertos ahora', subtitle_highlight:'cerca de vos', emoji:'🍔', bg_color:'#1a3a6e', cta_text:'Ver locales' },
      { id:'mb_2', slot:2, tag:'💊 Salud', title:'Farmacias\n24 horas', subtitle:'Envío express', subtitle_highlight:'en 20 minutos', emoji:'💊', bg_color:'#0f2249', cta_text:'Ver farmacias' },
    ];
    for (const b of defaultBanners) {
      await db.query(
        "INSERT INTO main_banners(id,slot,tag,title,subtitle,subtitle_highlight,emoji,bg_color,cta_text) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(id) DO NOTHING",
        [b.id, b.slot, b.tag, b.title, b.subtitle, b.subtitle_highlight, b.emoji, b.bg_color, b.cta_text]
      );
    }
  }

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

// ── Schedule helpers ──────────────────────────
// schedule format: { mon:[{open:'09:00',close:'23:00'}], tue:[...], ... }
// days: mon tue wed thu fri sat sun
function isBusinessOpenNow(schedule) {
  if (!schedule) return false;
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Montevideo' }));
  const days = ['sun','mon','tue','wed','thu','fri','sat'];
  const dayKey = days[now.getDay()];
  const slots = schedule[dayKey];
  if (!slots || !slots.length) return false;
  const cur = now.getHours() * 60 + now.getMinutes();
  return slots.some(slot => {
    const [oh, om] = slot.open.split(':').map(Number);
    const [ch, cm] = slot.close.split(':').map(Number);
    const openMin = oh * 60 + om;
    let closeMin = ch * 60 + cm;
    if (closeMin <= openMin) closeMin += 1440; // past midnight
    if (closeMin <= openMin) return false;
    const curAdj = closeMin > 1440 && cur < openMin ? cur + 1440 : cur;
    return curAdj >= openMin && curAdj < closeMin;
  });
}

// Cron: every minute, auto open/close businesses that have schedule_enabled
setInterval(async () => {
  try {
    const businesses = await qa(
      'SELECT id, schedule, is_open FROM businesses WHERE schedule_enabled=TRUE AND schedule IS NOT NULL', []
    );
    for (const biz of businesses) {
      const shouldBeOpen = isBusinessOpenNow(biz.schedule);
      if (shouldBeOpen !== biz.is_open) {
        await q('UPDATE businesses SET is_open=$1 WHERE id=$2', [shouldBeOpen, biz.id]);
        console.log(`⏰ Auto-${shouldBeOpen ? 'opened' : 'closed'} business ${biz.id}`);
      }
    }
  } catch(e) { console.error('Schedule cron error:', e.message); }
}, 60 * 1000);

// ── MercadoPago ───────────────────────────────
let mp = null;
try {
  mp = require('mercadopago');
  if (process.env.MP_ACCESS_TOKEN && process.env.MP_ACCESS_TOKEN.startsWith('APP_USR-')) {
    mp.configure({ access_token: process.env.MP_ACCESS_TOKEN });
    console.log('✅ MercadoPago listo');
  } else { console.warn('⚠️  MP_ACCESS_TOKEN no configurado'); }
} catch(e) { console.warn('⚠️  mercadopago no instalado'); }

// ── Web Push / VAPID ──────────────────────────
let webpush = null;
let VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY || null;
let VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY || null;

async function initVapid() {
  try {
    webpush = require('web-push');
    // Load or generate VAPID keys from DB
    if (!VAPID_PUBLIC || !VAPID_PRIVATE) {
      const row = await q1("SELECT value FROM app_settings WHERE key='vapid_public'");
      const row2 = await q1("SELECT value FROM app_settings WHERE key='vapid_private'");
      if (row && row2) {
        VAPID_PUBLIC = row.value; VAPID_PRIVATE = row2.value;
      } else {
        const keys = webpush.generateVAPIDKeys();
        VAPID_PUBLIC = keys.publicKey; VAPID_PRIVATE = keys.privateKey;
        await q("INSERT INTO app_settings (key,value) VALUES ('vapid_public',$1),('vapid_private',$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value",
          [VAPID_PUBLIC, VAPID_PRIVATE]);
        console.log('✅ VAPID keys generated');
      }
    }
    webpush.setVapidDetails(`mailto:hola@blow.uy`, VAPID_PUBLIC, VAPID_PRIVATE);
    console.log('✅ Web Push listo');
  } catch(e) { console.warn('⚠️  web-push no disponible:', e.message); }
}

async function sendPush(userId, payload) {
  if (!webpush) return;
  try {
    const subs = await qa('SELECT * FROM push_subscriptions WHERE user_id=$1', [userId]);
    for (const sub of subs) {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          JSON.stringify(payload)
        );
      } catch(e) {
        // 410 Gone = subscription expired, remove it
        if (e.statusCode === 410 || e.statusCode === 404) {
          await q('DELETE FROM push_subscriptions WHERE endpoint=$1', [sub.endpoint]);
        }
      }
    }
  } catch(e) { console.error('sendPush error:', e.message); }
}

// Send push to all customers of a business
async function sendPushToBusinessCustomers(businessId, payload, options = {}) {
  const { limit = 500, onlyRecent = true } = options;
  // Get unique customers who ordered from this business (optionally only those in last 90 days)
  const customers = await qa(`
    SELECT DISTINCT customer_id FROM orders
    WHERE business_id=$1
      ${onlyRecent ? "AND created_at > NOW() - INTERVAL '90 days'" : ''}
      AND status = 'delivered'
    LIMIT $2
  `, [businessId, limit]);
  let sent = 0, failed = 0;
  for (const c of customers) {
    try { await sendPush(c.customer_id, payload); sent++; }
    catch(e) { failed++; }
  }
  return { sent, failed, total: customers.length };
}

// ── Middlewares ───────────────────────────────

// 🔒 Cargar paquetes de seguridad de forma segura
let helmet = null;
try { helmet = require('helmet'); } catch(e) { console.warn('⚠️  helmet no instalado'); }
let rateLimit = null;
try { rateLimit = require('express-rate-limit'); } catch(e) { console.warn('⚠️  express-rate-limit no instalado'); }
let compression = null;
try { compression = require("compression"); } catch(e) { console.warn("compression no instalado"); }

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
app.use(express.json({ limit: '5mb' }));
if (compression) app.use(compression({ level: 6, threshold: 1024 }));
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders(res, filePath) {
    if (filePath.endsWith('sw.js') || filePath.endsWith('manifest.json')) {
      res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate'); return;
    }
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate'); return;
    }
    if (filePath.match(/\.(png|jpg|jpeg|webp|ico|woff2|woff|ttf)$/)) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable'); return;
    }
    if (filePath.match(/\.(js|css)$/)) {
      res.setHeader('Cache-Control', 'public, max-age=86400'); return;
    }
  }
}));

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
  try {
  const u = await q1('SELECT id,name,email,phone,role,address,city,department FROM users WHERE id=$1', [req.user.id]);
  if (!u) return res.json({ error:'No encontrado' });
  u.addresses = await qa('SELECT * FROM user_addresses WHERE user_id=$1 ORDER BY is_active DESC,created_at DESC', [req.user.id]);
  res.json(u);
  } catch(e) { console.error("❌ route error:", req.method, req.path, e.message); if (!res.headersSent) res.status(500).json({ error: e.message }); }
});

app.patch('/api/auth/me', auth, async (req, res) => {
  try {
  const { name, phone, address, city, department } = req.body;
  await q('UPDATE users SET name=COALESCE($1,name),phone=COALESCE($2,phone),address=COALESCE($3,address),city=COALESCE($4,city),department=COALESCE($5,department) WHERE id=$6',
    [name, phone, address, city, department, req.user.id]);
  res.json(await q1('SELECT id,name,email,phone,role,address,city,department FROM users WHERE id=$1', [req.user.id]));
  } catch(e) { console.error("❌ route error:", req.method, req.path, e.message); if (!res.headersSent) res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════
//  DIRECCIONES
// ════════════════════════════════════════════════
app.get('/api/addresses', auth, async (req, res) =>
  res.json(await qa('SELECT * FROM user_addresses WHERE user_id=$1 ORDER BY is_active DESC,created_at DESC', [req.user.id])));

app.post('/api/addresses', auth, async (req, res) => {
  try {
  const { label, full_address, city, department='', lat=null, lng=null } = req.body;
  if (!full_address || !city) return res.status(400).json({ error:'full_address y city son obligatorios' });
  const cnt = await q1('SELECT COUNT(*) as c FROM user_addresses WHERE user_id=$1', [req.user.id]);
  const isFirst = parseInt(cnt.c) === 0;
  const id = uuid();
  await q('INSERT INTO user_addresses (id,user_id,label,full_address,city,department,lat,lng,is_active) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [id, req.user.id, label||'Mi dirección', full_address.trim(), city.trim(), department, lat, lng, isFirst]);
  if (isFirst) await q('UPDATE users SET city=$1,department=$2 WHERE id=$3', [city.trim(), department, req.user.id]);
  res.status(201).json(await q1('SELECT * FROM user_addresses WHERE id=$1', [id]));
  } catch(e) { console.error("❌ route error:", req.method, req.path, e.message); if (!res.headersSent) res.status(500).json({ error: e.message }); }
});

app.post('/api/addresses/:id/activate', auth, async (req, res) => {
  try {
  const addr = await q1('SELECT * FROM user_addresses WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id]);
  if (!addr) return res.status(404).json({ error:'Dirección no encontrada' });
  await q('UPDATE user_addresses SET is_active=FALSE WHERE user_id=$1', [req.user.id]);
  await q('UPDATE user_addresses SET is_active=TRUE WHERE id=$1', [req.params.id]);
  await q('UPDATE users SET city=$1,department=$2,address=$3 WHERE id=$4', [addr.city, addr.department, addr.full_address, req.user.id]);
  res.json({ success:true, active: await q1('SELECT * FROM user_addresses WHERE id=$1', [req.params.id]) });
  } catch(e) { console.error("❌ route error:", req.method, req.path, e.message); if (!res.headersSent) res.status(500).json({ error: e.message }); }
});

app.delete('/api/addresses/:id', auth, async (req, res) => {
  try {
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
  } catch(e) { console.error("❌ route error:", req.method, req.path, e.message); if (!res.headersSent) res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════
//  NEGOCIOS
// ════════════════════════════════════════════════
// ── Personalized recommendations ─────────────
// ═══════════════════════════════════════════════
//  GPS TRACKING — REPARTIDOR
// ═══════════════════════════════════════════════

// Repartidor actualiza su posición (llamado cada 10s desde la app)
app.post('/api/rider/location', auth, async (req, res) => {
  try {
  if (!['delivery','owner'].includes(req.user.role)) return res.status(403).json({ error: 'Sin permisos' });
  const { order_id, lat, lng, heading = 0, speed = 0 } = req.body;
  if (!order_id || !lat || !lng) return res.status(400).json({ error: 'order_id, lat y lng requeridos' });
  try {
    // Verify the rider is assigned to this order
    const order = await q1('SELECT * FROM orders WHERE id=$1', [order_id]);
    if (!order) return res.status(404).json({ error: 'Pedido no encontrado' });
    if (req.user.role === 'delivery' && order.delivery_id !== req.user.id) return res.status(403).json({ error: 'No sos el repartidor de este pedido' });
    // Upsert location
    await q(`INSERT INTO rider_locations (order_id, rider_id, lat, lng, heading, speed, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,NOW())
      ON CONFLICT (order_id) DO UPDATE SET lat=$3, lng=$4, heading=$5, speed=$6, updated_at=NOW()`,
      [order_id, req.user.id, parseFloat(lat), parseFloat(lng), parseFloat(heading), parseFloat(speed)]);
    // Broadcast to customer via WebSocket
    notify(order.customer_id, {
      type: 'rider_location',
      order_id,
      lat: parseFloat(lat),
      lng: parseFloat(lng),
      heading: parseFloat(heading),
    });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
  } catch(e) { console.error("❌ route error:", req.method, req.path, e.message); if (!res.headersSent) res.status(500).json({ error: e.message }); }
});

// Customer polls rider location (fallback if WS disconnected)
app.get('/api/orders/:id/rider-location', auth, async (req, res) => {
  try {
    const order = await q1('SELECT customer_id, delivery_id, status FROM orders WHERE id=$1', [req.params.id]);
    if (!order) return res.status(404).json({ error: 'Pedido no encontrado' });
    if (order.customer_id !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ error: 'Sin permisos' });
    if (!['on_way'].includes(order.status)) return res.json({ available: false, status: order.status });
    const loc = await q1('SELECT lat, lng, heading, speed, updated_at FROM rider_locations WHERE order_id=$1', [req.params.id]);
    if (!loc) return res.json({ available: false });
    // Consider stale if > 60 seconds old
    const ageSeconds = (Date.now() - new Date(loc.updated_at).getTime()) / 1000;
    res.json({ available: true, lat: loc.lat, lng: loc.lng, heading: loc.heading, stale: ageSeconds > 60, age_seconds: Math.round(ageSeconds) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/recommendations', auth, async (req, res) => {
  try {
    const { lat, lng, limit = 8 } = req.query;
    // 1. Get user's order history — business_ids and categories ordered by frequency
    const history = await qa(`
      SELECT o.business_id, b.category, COUNT(*) as times
      FROM orders o
      JOIN businesses b ON b.id = o.business_id
      WHERE o.customer_id = $1
        AND o.status = 'delivered'
      GROUP BY o.business_id, b.category
      ORDER BY times DESC
      LIMIT 20
    `, [req.user.id]);

    if (!history.length) {
      // No history → return top-rated open businesses
      const fallback = await qa(`
        SELECT b.id, b.name, b.category, b.logo_emoji, b.logo_url, b.cover_url,
               b.delivery_cost, b.delivery_time, b.rating, (SELECT COUNT(*) FROM reviews WHERE business_id=b.id) AS review_count, b.is_open,
               'popular' AS rec_reason
        FROM businesses b
        WHERE b.is_open = TRUE AND b.plan IS NOT NULL
        ORDER BY COALESCE(b.rating, 0) DESC, (SELECT COUNT(*) FROM reviews WHERE business_id=b.id) DESC
        LIMIT $1
      `, [parseInt(limit)]);
      return res.json({ recommendations: fallback, reason: 'popular' });
    }

    // 2. Get top categories from history
    const catCounts = {};
    const recentBizIds = history.map(h => h.business_id);
    history.forEach(h => { catCounts[h.category] = (catCounts[h.category] || 0) + parseInt(h.times); });
    const topCats = Object.entries(catCounts).sort((a,b) => b[1]-a[1]).map(e => e[0]);

    // 3. Find similar businesses not recently ordered from
    const distExpr = lat && lng
      ? `6371 * acos(GREATEST(-1, LEAST(1, cos(radians(${parseFloat(lat)})) * cos(radians(b.lat)) * cos(radians(b.lng) - radians(${parseFloat(lng)})) + sin(radians(${parseFloat(lat)})) * sin(radians(b.lat)))))`
      : 'NULL';

    const placeholders = recentBizIds.map((_,i) => `$${i+2}`).join(',');
    const recs = await qa(`
      SELECT b.id, b.name, b.category, b.logo_emoji, b.logo_url, b.cover_url,
             b.delivery_cost, b.delivery_time, b.rating, (SELECT COUNT(*) FROM reviews WHERE business_id=b.id) AS review_count, b.is_open,
             ${distExpr} AS distance_km,
             CASE WHEN b.category = ANY($1::text[]) THEN 'same_category' ELSE 'discover' END AS rec_reason
      FROM businesses b
      WHERE b.plan IS NOT NULL
        AND b.is_open = TRUE
        ${recentBizIds.length ? `AND b.id NOT IN (${placeholders})` : ''}
      ORDER BY
        CASE WHEN b.category = ANY($1::text[]) THEN 0 ELSE 1 END ASC,
        COALESCE(b.rating, 0) DESC,
        (SELECT COUNT(*) FROM reviews WHERE business_id=b.id) DESC
      LIMIT $${recentBizIds.length + 2}
    `, [topCats, ...recentBizIds, parseInt(limit)]);

    // 4. If not enough, pad with "order again" businesses (last ordered first)
    let result = recs;
    if (result.length < 3) {
      const again = await qa(`
        SELECT DISTINCT ON (o.business_id) b.id, b.name, b.category, b.logo_emoji, b.logo_url,
               b.cover_url, b.delivery_cost, b.delivery_time, b.rating, (SELECT COUNT(*) FROM reviews WHERE business_id=b.id) AS review_count, b.is_open,
               'order_again' AS rec_reason
        FROM orders o JOIN businesses b ON b.id = o.business_id
        WHERE o.customer_id = $1 AND o.status = 'delivered' AND b.is_open = TRUE
        ORDER BY o.business_id, o.created_at DESC
        LIMIT $2
      `, [req.user.id, parseInt(limit)]);
      result = [...result, ...again].slice(0, parseInt(limit));
    }

    res.json({ recommendations: result, reason: topCats[0] || 'mixed' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});


// ═══════════════════════════════════════════════
//  BUSINESS NEWS / NOVEDADES
// ═══════════════════════════════════════════════
app.get('/api/businesses/:id/news', async (req, res) => {
  try {
    const news = await qa('SELECT * FROM business_news WHERE business_id=$1 AND active=TRUE ORDER BY created_at DESC LIMIT 10', [req.params.id]);
    res.json(news);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/businesses/mine/news', auth, role('owner'), async (req, res) => {
  try {
    const biz = await q1('SELECT id FROM businesses WHERE owner_id=$1', [req.user.id]);
    if (!biz) return res.status(404).json({ error: 'Negocio no encontrado' });
    res.json(await qa('SELECT * FROM business_news WHERE business_id=$1 ORDER BY created_at DESC', [biz.id]));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/businesses/mine/news', auth, role('owner'), async (req, res) => {
  try {
    const biz = await q1('SELECT id FROM businesses WHERE owner_id=$1', [req.user.id]);
    if (!biz) return res.status(404).json({ error: 'Negocio no encontrado' });
    const { title, body='', emoji='📢' } = req.body;
    if (!title?.trim()) return res.status(400).json({ error: 'Título requerido' });
    const id = uuid();
    await q('INSERT INTO business_news (id,business_id,title,body,emoji) VALUES ($1,$2,$3,$4,$5)',
      [id, biz.id, title.trim(), body.trim(), emoji]);
    res.status(201).json(await q1('SELECT * FROM business_news WHERE id=$1', [id]));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/businesses/mine/news/:id', auth, role('owner'), async (req, res) => {
  try {
    const biz = await q1('SELECT id FROM businesses WHERE owner_id=$1', [req.user.id]);
    const item = await q1('SELECT * FROM business_news WHERE id=$1 AND business_id=$2', [req.params.id, biz?.id]);
    if (!item) return res.status(404).json({ error: 'No encontrado' });
    const { title, body, emoji, active } = req.body;
    await q('UPDATE business_news SET title=COALESCE($1,title),body=COALESCE($2,body),emoji=COALESCE($3,emoji),active=COALESCE($4,active) WHERE id=$5',
      [title||null, body||null, emoji||null, active!=null?Boolean(active):null, req.params.id]);
    res.json(await q1('SELECT * FROM business_news WHERE id=$1', [req.params.id]));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/businesses/mine/news/:id', auth, role('owner'), async (req, res) => {
  try {
    const biz = await q1('SELECT id FROM businesses WHERE owner_id=$1', [req.user.id]);
    await q('DELETE FROM business_news WHERE id=$1 AND business_id=$2', [req.params.id, biz?.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════
//  LOYALTY POINTS
// ═══════════════════════════════════════════════
async function awardLoyaltyPoints(userId, businessId, orderId, total) {
  try {
    const cfg = await q1('SELECT * FROM loyalty_config WHERE business_id=$1 AND enabled=TRUE', [businessId]);
    if (!cfg) return;
    const pts = Math.floor(parseFloat(total) / 100) * (cfg.points_per_100 || 1);
    if (pts <= 0) return;
    await q('INSERT INTO loyalty_points (user_id,business_id,points,reason,order_id) VALUES ($1,$2,$3,$4,$5)',
      [userId, businessId, pts, 'purchase', orderId]);
  } catch(e) { /* non-critical */ }
}

app.get('/api/loyalty/balance', auth, async (req, res) => {
  try {
    const { business_id } = req.query;
    let rows;
    if (business_id) {
      rows = await qa('SELECT SUM(points) as total FROM loyalty_points WHERE user_id=$1 AND business_id=$2', [req.user.id, business_id]);
    } else {
      rows = await qa('SELECT business_id, SUM(points) as total FROM loyalty_points WHERE user_id=$1 GROUP BY business_id', [req.user.id]);
    }
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/loyalty/config/:bizId', async (req, res) => {
  try {
    const cfg = await q1('SELECT * FROM loyalty_config WHERE business_id=$1', [req.params.bizId]);
    res.json(cfg || { enabled: false });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/loyalty/config', auth, role('owner'), async (req, res) => {
  try {
    const biz = await q1('SELECT id FROM businesses WHERE owner_id=$1', [req.user.id]);
    if (!biz) return res.status(404).json({ error: 'Negocio no encontrado' });
    const { points_per_100=1, redeem_points=100, redeem_discount=50, enabled=true } = req.body;
    await q(`INSERT INTO loyalty_config (business_id,points_per_100,redeem_points,redeem_discount,enabled)
      VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (business_id) DO UPDATE SET points_per_100=$2,redeem_points=$3,redeem_discount=$4,enabled=$5`,
      [biz.id, points_per_100, redeem_points, redeem_discount, Boolean(enabled)]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Redeem points on an order (called during checkout if user chooses to redeem)
app.post('/api/orders/:id/redeem-points', auth, async (req, res) => {
  try {
    const order = await q1('SELECT * FROM orders WHERE id=$1 AND customer_id=$2', [req.params.id, req.user.id]);
    if (!order) return res.status(404).json({ error: 'Pedido no encontrado' });
    const cfg = await q1('SELECT * FROM loyalty_config WHERE business_id=$1 AND enabled=TRUE', [order.business_id]);
    if (!cfg) return res.status(400).json({ error: 'Este negocio no tiene programa de puntos' });
    const bal = await q1('SELECT COALESCE(SUM(points),0) as total FROM loyalty_points WHERE user_id=$1 AND business_id=$2',
      [req.user.id, order.business_id]);
    const balance = parseInt(bal.total);
    if (balance < cfg.redeem_points) return res.status(400).json({ error: `Necesitás ${cfg.redeem_points} puntos (tenés ${balance})` });
    // Deduct points
    await q('INSERT INTO loyalty_points (user_id,business_id,points,reason,order_id) VALUES ($1,$2,$3,$4,$5)',
      [req.user.id, order.business_id, -cfg.redeem_points, 'redeem', order.id]);
    res.json({ ok: true, discount: cfg.redeem_discount, points_used: cfg.redeem_points, remaining: balance - cfg.redeem_points });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════
//  SAVED ADDRESSES
// ═══════════════════════════════════════════════
app.get('/api/addresses', auth, async (req, res) => {
  try { res.json(await qa('SELECT * FROM user_addresses WHERE user_id=$1 ORDER BY is_active DESC, created_at DESC', [req.user.id])); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/addresses', auth, async (req, res) => {
  try {
    const cnt = await q1('SELECT COUNT(*) as c FROM user_addresses WHERE user_id=$1', [req.user.id]);
    if (parseInt(cnt.c) >= 5) return res.status(400).json({ error: 'Máximo 5 direcciones guardadas' });
    const { label='Casa', full_address, city='', department='', lat, lng } = req.body;
    if (!full_address?.trim()) return res.status(400).json({ error: 'Dirección requerida' });
    const id = uuid();
    // If first address, make it active
    const makeActive = parseInt(cnt.c) === 0;
    await q('INSERT INTO user_addresses (id,user_id,label,full_address,city,department,lat,lng,is_active) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [id, req.user.id, label, full_address.trim(), city, department, lat||null, lng||null, makeActive]);
    res.status(201).json(await q1('SELECT * FROM user_addresses WHERE id=$1', [id]));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/addresses/:id/activate', auth, async (req, res) => {
  try {
    await q('UPDATE user_addresses SET is_active=FALSE WHERE user_id=$1', [req.user.id]);
    await q('UPDATE user_addresses SET is_active=TRUE WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/addresses/:id', auth, async (req, res) => {
  try {
    await q('DELETE FROM user_addresses WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/businesses', async (req, res) => {
  try {
    const { category, city, department } = req.query;
    const limit  = Math.min(parseInt(req.query.limit)  || 12, 50);
    const offset = parseInt(req.query.offset) || 0;
    const clientLat = parseFloat(req.query.lat) || null;
    const clientLng = parseFloat(req.query.lng) || null;

    let sql = `SELECT b.*${clientLat && clientLng
      ? `,CASE WHEN b.lat IS NOT NULL AND b.lng IS NOT NULL
          THEN ROUND((6371 * acos(cos(radians(${clientLat})) * cos(radians(b.lat)) * cos(radians(b.lng) - radians(${clientLng})) + sin(radians(${clientLat})) * sin(radians(b.lat))))::numeric, 1)
          ELSE NULL END AS distance_km,
        CASE WHEN b.delivery_radius_km IS NULL THEN true
             WHEN b.lat IS NULL THEN true
             WHEN (6371 * acos(cos(radians(${clientLat})) * cos(radians(b.lat)) * cos(radians(b.lng) - radians(${clientLng})) + sin(radians(${clientLat})) * sin(radians(b.lat)))) <= b.delivery_radius_km THEN true
             ELSE false END AS delivers_to_me`
      : ''} FROM businesses b
      LEFT JOIN subscriptions s ON s.business_id = b.id
      WHERE (s.status = 'active' OR s.id IS NULL) AND (b.is_active = TRUE OR b.is_active IS NULL)`;
    const params = [];
    let i = 1;
    if (category)   { sql += ` AND b.category=$${i++}`;                params.push(category); }
    if (city)       { sql += ` AND LOWER(b.city)=LOWER($${i++})`;      params.push(city); }
    if (department) { sql += ` AND LOWER(b.department)=LOWER($${i++})`; params.push(department); }
    const countSql = `SELECT COUNT(*) as total FROM businesses b LEFT JOIN subscriptions s ON s.business_id = b.id WHERE (s.status = 'active' OR s.id IS NULL) AND (b.is_active = TRUE OR b.is_active IS NULL)` +
      (category ? ` AND b.category='${category.replace(/'/g,"''")}' ` : '') +
      (city ? ` AND LOWER(b.city)=LOWER('${city.replace(/'/g,"''")}')` : '') +
      (department ? ` AND LOWER(b.department)=LOWER('${department.replace(/'/g,"''")}')` : '');
    const totalRow = await q1(countSql, []);
    const total = parseInt(totalRow?.total || 0);
    sql += ` ORDER BY b.blow_plus DESC NULLS LAST, b.is_open DESC, b.created_at DESC`;
    sql += ` LIMIT $${i++} OFFSET $${i++}`;
    params.push(limit, offset);
    const rows = await qa(sql, params);
    const result = [];
    for (const b of rows) {
      const cnt = await q1('SELECT COUNT(*) as c FROM products WHERE business_id=$1 AND is_available=TRUE',[b.id]);
      result.push({ ...b, product_count: parseInt(cnt?.c || 0) });
    }
    res.json({ businesses: result, total, hasMore: offset + limit < total, offset, limit });
  } catch(e) {
    console.error('❌ /api/businesses error:', e.message, e.stack);
    res.status(500).json({ error: e.message });
  }
});

// Public APIs
// ── Push notifications ────────────────────────
app.get('/api/push/vapid-key', (req, res) => {
  if (!VAPID_PUBLIC) return res.status(503).json({ error: 'Push no disponible' });
  res.json({ publicKey: VAPID_PUBLIC });
});

app.post('/api/push/subscribe', auth, async (req, res) => {
  try {
  const { endpoint, keys } = req.body;
  if (!endpoint || !keys?.p256dh || !keys?.auth)
    return res.status(400).json({ error: 'Suscripción inválida' });
  try {
    await q(`INSERT INTO push_subscriptions (id,user_id,endpoint,p256dh,auth)
      VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (endpoint) DO UPDATE SET user_id=$2, p256dh=$4, auth=$5`,
      [uuid(), req.user.id, endpoint, keys.p256dh, keys.auth]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
  } catch(e) { console.error("❌ route error:", req.method, req.path, e.message); if (!res.headersSent) res.status(500).json({ error: e.message }); }
});

app.delete('/api/push/subscribe', auth, async (req, res) => {
  try {
  const { endpoint } = req.body;
  if (endpoint) await q('DELETE FROM push_subscriptions WHERE endpoint=$1 AND user_id=$2', [endpoint, req.user.id]);
  else await q('DELETE FROM push_subscriptions WHERE user_id=$1', [req.user.id]);
  res.json({ ok: true });
  } catch(e) { console.error("❌ route error:", req.method, req.path, e.message); if (!res.headersSent) res.status(500).json({ error: e.message }); }
});

// ── Marketing push from owner panel ──────────
app.get('/api/owner/push/audience', auth, role('owner'), async (req, res) => {
  try {
    const biz = await q1('SELECT id FROM businesses WHERE owner_id=$1', [req.user.id]);
    if (!biz) return res.status(404).json({ error: 'No encontrado' });
    const stats = await q1(`
      SELECT
        COUNT(DISTINCT o.customer_id) as total_customers,
        COUNT(DISTINCT ps.user_id) as push_enabled
      FROM orders o
      JOIN push_subscriptions ps ON ps.user_id = o.customer_id
      WHERE o.business_id=$1 AND o.status='delivered'
        AND o.created_at > NOW() - INTERVAL '90 days'
    `, [biz.id]);
    res.json(stats);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/owner/push/send', auth, role('owner'), async (req, res) => {
  try {
    const biz = await q1('SELECT id, name FROM businesses WHERE owner_id=$1', [req.user.id]);
    if (!biz) return res.status(404).json({ error: 'No encontrado' });
    const { title, body, url = '/' } = req.body;
    if (!title?.trim()) return res.status(400).json({ error: 'Título requerido' });
    // Rate limit: max 1 marketing push per business per day
    const lastPush = await q1(`
      SELECT created_at FROM push_log WHERE business_id=$1
        AND created_at > NOW() - INTERVAL '24 hours' LIMIT 1
    `, [biz.id]).catch(() => null);
    // push_log table created inline if doesn't exist
    await q(`CREATE TABLE IF NOT EXISTS push_log (
      id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
      business_id TEXT NOT NULL,
      title TEXT, body TEXT,
      sent_count INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`);
    const recent = await q1(`SELECT id FROM push_log WHERE business_id=$1 AND created_at > NOW() - INTERVAL '24 hours'`, [biz.id]).catch(()=>null);
    if (recent) return res.status(429).json({ error: 'Solo podés enviar 1 campaña por día. Intentá mañana.' });
    const payload = { title: `${biz.name}: ${title}`, body: body || '', url, type: 'marketing' };
    const result = await sendPushToBusinessCustomers(biz.id, payload);
    await q(`INSERT INTO push_log (business_id,title,body,sent_count) VALUES ($1,$2,$3,$4)`,
      [biz.id, title, body || '', result.sent]);
    res.json({ ok: true, ...result });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

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
  try {
  res.json(await qa('SELECT * FROM business_categories ORDER BY sort_order',[]));
  } catch(e) { console.error("❌ route error:", req.method, req.path, e.message); if (!res.headersSent) res.status(500).json({ error: e.message }); }
});
app.post('/api/admin/business-categories', auth, role('admin'), async (req, res) => {
  try {
  const { name, emoji='🏪', sort_order=99 } = req.body;
  if (!name) return res.status(400).json({ error:'name requerido' });
  const id = 'cat-' + uuid().slice(0,8);
  await q('INSERT INTO business_categories (id,name,emoji,sort_order) VALUES ($1,$2,$3,$4)',[id,name,emoji,sort_order]);
  res.json({ success:true, id });
  } catch(e) { console.error("❌ route error:", req.method, req.path, e.message); if (!res.headersSent) res.status(500).json({ error: e.message }); }
});
app.patch('/api/admin/business-categories/:id', auth, role('admin'), async (req, res) => {
  try {
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
  } catch(e) { console.error("❌ route error:", req.method, req.path, e.message); if (!res.headersSent) res.status(500).json({ error: e.message }); }
});
app.delete('/api/admin/business-categories/:id', auth, role('admin'), async (req, res) => {
  try {
  await q('DELETE FROM business_categories WHERE id=$1',[req.params.id]);
  res.json({ success:true });
  } catch(e) { console.error("❌ route error:", req.method, req.path, e.message); if (!res.headersSent) res.status(500).json({ error: e.message }); }
});

// ── Admin: subscription plans CRUD ──
app.get('/api/admin/subscription-plans', auth, role('admin'), async (req, res) => {
  try {
  res.json(await qa('SELECT * FROM subscription_plans ORDER BY sort_order',[]));
  } catch(e) { console.error("❌ route error:", req.method, req.path, e.message); if (!res.headersSent) res.status(500).json({ error: e.message }); }
});
app.post('/api/admin/subscription-plans', auth, role('admin'), async (req, res) => {
  try {
  const { name, price, description='', sort_order=99, features='[]' } = req.body;
  if (!name || price===undefined) return res.status(400).json({ error:'name y price requeridos' });
  const id = 'plan-' + uuid().slice(0,8);
  const featStr = typeof features==='string' ? features : JSON.stringify(features);
  await q('INSERT INTO subscription_plans (id,name,price,description,features,sort_order) VALUES ($1,$2,$3,$4,$5,$6)',[id,name,price,description,featStr,sort_order]);
  res.json({ success:true, id });
  } catch(e) { console.error("❌ route error:", req.method, req.path, e.message); if (!res.headersSent) res.status(500).json({ error: e.message }); }
});
app.patch('/api/admin/subscription-plans/:id', auth, role('admin'), async (req, res) => {
  try {
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
  } catch(e) { console.error("❌ route error:", req.method, req.path, e.message); if (!res.headersSent) res.status(500).json({ error: e.message }); }
});
app.delete('/api/admin/subscription-plans/:id', auth, role('admin'), async (req, res) => {
  try {
  await q('DELETE FROM subscription_plans WHERE id=$1',[req.params.id]);
  res.json({ success:true });
  } catch(e) { console.error("❌ route error:", req.method, req.path, e.message); if (!res.headersSent) res.status(500).json({ error: e.message }); }
});

app.get('/api/businesses/mine/dashboard', auth, role('owner'), async (req, res) => {
  try {
  
  const b = await q1('SELECT * FROM businesses WHERE owner_id=$1', [req.user.id]);
  if (!b) return res.status(404).json({ error:'No tenés ningún negocio registrado aún' });
  const rawP     = await qa('SELECT * FROM products WHERE business_id=$1 ORDER BY created_at DESC', [b.id]);
  const products = await Promise.all(rawP.map(async p => ({
    ...p,
    photos:   await qa('SELECT id,url,sort_order FROM product_photos WHERE product_id=$1 ORDER BY sort_order',[p.id]),
    variants: await qa('SELECT * FROM product_variants WHERE product_id=$1 ORDER BY group_name,sort_order',[p.id]),
  })));
  const categories  = await qa('SELECT * FROM product_categories WHERE business_id=$1 ORDER BY sort_order',[b.id]);
  const rawOrders   = await qa(`SELECT o.*,u.name as customer_name,u.phone as customer_phone FROM orders o JOIN users u ON o.customer_id=u.id WHERE o.business_id=$1 ORDER BY o.created_at DESC LIMIT 50`,[b.id]);
  // Attach items to each order in one extra query (no N+1)
  const orderIds    = rawOrders.map(o => o.id);
  const allItems    = orderIds.length ? await qa(`SELECT * FROM order_items WHERE order_id = ANY($1::text[])`, [orderIds]) : [];
  const itemsByOrder = {};
  allItems.forEach(i => { if (!itemsByOrder[i.order_id]) itemsByOrder[i.order_id] = []; itemsByOrder[i.order_id].push(i); });
  const orders      = rawOrders.map(o => ({ ...o, items: itemsByOrder[o.id] || [] }));
  const wallet      = await q1('SELECT * FROM wallets WHERE owner_id=$1',[b.id]) || { balance:0, id:null };
  const transactions= wallet.id ? await qa('SELECT * FROM transactions WHERE wallet_id=$1 ORDER BY created_at DESC LIMIT 30',[wallet.id]) : [];
  const withdrawals = await qa('SELECT * FROM withdrawals WHERE owner_id=$1 ORDER BY created_at DESC',[req.user.id]);
  const today       = await q1(`SELECT COUNT(*) as orders,COALESCE(SUM(total),0) as revenue FROM orders WHERE business_id=$1 AND DATE(created_at)=CURRENT_DATE AND status NOT IN ('cancelled','pending')`,[b.id]);
  const week        = await q1(`SELECT COUNT(*) as orders,COALESCE(SUM(total),0) as revenue FROM orders WHERE business_id=$1 AND created_at>=NOW()-INTERVAL '7 days' AND status NOT IN ('cancelled','pending')`,[b.id]);
  res.json({ business:b, products, categories, orders, balance:parseFloat(wallet.balance)||0, transactions, withdrawals, today, week });
  } catch(e) { console.error(`❌ dashboard:`, e.message); res.status(500).json({ error: e.message }); }
});






// GET own business info
app.get('/api/businesses/mine', auth, role('owner'), async (req, res) => {
  try {
  
  const b = await q1('SELECT * FROM businesses WHERE owner_id=$1', [req.user.id]);
  if (!b) return res.status(404).json({ error: 'Negocio no encontrado' });
  res.json(b);
  } catch(e) { console.error(`❌ businesses mine GET:`, e.message); res.status(500).json({ error: e.message }); }
});

app.patch('/api/businesses/mine', auth, role('owner'), async (req, res) => {
  try {
  
  const b = await q1('SELECT * FROM businesses WHERE owner_id=$1',[req.user.id]);
  if (!b) return res.status(404).json({ error:'No tenés ningún negocio' });
  const { name, category, address, phone, logo_emoji, delivery_cost, is_open, plan, delivery_time, city, department, lat, lng, delivery_radius_km, accepts_cash, accepts_card_pos } = req.body;
  await q(`UPDATE businesses SET name=COALESCE($1,name),category=COALESCE($2,category),address=COALESCE($3,address),phone=COALESCE($4,phone),logo_emoji=COALESCE($5,logo_emoji),delivery_cost=COALESCE($6,delivery_cost),is_open=COALESCE($7,is_open),plan=COALESCE($8,plan),delivery_time=COALESCE($9,delivery_time),city=COALESCE($10,city),department=COALESCE($11,department),lat=COALESCE($13,lat),lng=COALESCE($14,lng),delivery_radius_km=COALESCE($15,delivery_radius_km),accepts_cash=COALESCE($16,accepts_cash),accepts_card_pos=COALESCE($17,accepts_card_pos) WHERE owner_id=$12`,
    [name,category,address,phone,logo_emoji,delivery_cost,is_open!=null?Boolean(is_open):null,plan,delivery_time,city,department,req.user.id,lat!=null?parseFloat(lat):null,lng!=null?parseFloat(lng):null,delivery_radius_km!=null?parseFloat(delivery_radius_km):null,accepts_cash!=null?Boolean(accepts_cash):null,accepts_card_pos!=null?Boolean(accepts_card_pos):null]);
  // Auto-geocode address if address changed and no explicit lat/lng provided
  if (address && lat == null && lng == null) {
    try {
      const query = encodeURIComponent(`${address}, ${city||''}, Uruguay`);
      const geoRes = await fetch(`https://nominatim.openstreetmap.org/search?q=${query}&format=json&limit=1`, {
        headers: { 'User-Agent': 'BlowApp/1.0' }
      });
      const geoData = await geoRes.json();
      if (geoData && geoData[0]) {
        await q('UPDATE businesses SET lat=$1, lng=$2 WHERE owner_id=$3',
          [parseFloat(geoData[0].lat), parseFloat(geoData[0].lon), req.user.id]);
      }
    } catch(e) { /* geocode failed silently */ }
  }
  res.json(await q1('SELECT * FROM businesses WHERE owner_id=$1',[req.user.id]));
  } catch(e) { console.error(`❌ businesses mine PATCH:`, e.message); res.status(500).json({ error: e.message }); }
});

// ── Schedule ──────────────────────────────────────────
// ── Onboarding complete ────────────────────────────────────
app.post('/api/businesses/mine/onboarding-done', auth, role('owner'), async (req, res) => {
  try {
  await q('UPDATE businesses SET onboarding_done=TRUE WHERE owner_id=$1', [req.user.id]);
  res.json({ ok: true });
  } catch(e) { console.error("❌ route error:", req.method, req.path, e.message); if (!res.headersSent) res.status(500).json({ error: e.message }); }
});

app.get('/api/businesses/mine/schedule', auth, role('owner'), async (req, res) => {
  try {
  const b = await q1('SELECT schedule, schedule_enabled FROM businesses WHERE owner_id=$1',[req.user.id]);
  if (!b) return res.status(404).json({ error:'Sin negocio' });
  res.json({ schedule: b.schedule, schedule_enabled: b.schedule_enabled });
  } catch(e) { console.error("❌ route error:", req.method, req.path, e.message); if (!res.headersSent) res.status(500).json({ error: e.message }); }
});

app.patch('/api/businesses/mine/schedule', auth, role('owner'), async (req, res) => {
  try {
  const { schedule, schedule_enabled } = req.body;
  const b = await q1('SELECT id FROM businesses WHERE owner_id=$1',[req.user.id]);
  if (!b) return res.status(404).json({ error:'Sin negocio' });
  await q('UPDATE businesses SET schedule=$1, schedule_enabled=$2 WHERE id=$3',
    [schedule ? JSON.stringify(schedule) : null, !!schedule_enabled, b.id]);
  // Immediately apply schedule if enabled
  if (schedule_enabled && schedule) {
    const isOpen = isBusinessOpenNow(schedule);
    await q('UPDATE businesses SET is_open=$1 WHERE id=$2', [isOpen, b.id]);
  }
  res.json({ success: true });
  } catch(e) { console.error("❌ route error:", req.method, req.path, e.message); if (!res.headersSent) res.status(500).json({ error: e.message }); }
});

// ── Toggle open/closed ──────────────────────────────────
app.post('/api/businesses/mine/toggle', auth, role('owner'), async (req, res) => {
  try {
  const b = await q1('SELECT id, is_open FROM businesses WHERE owner_id=$1', [req.user.id]);
  if (!b) return res.status(404).json({ error: 'Sin negocio' });
  const newState = req.body.is_open !== undefined ? Boolean(req.body.is_open) : !b.is_open;
  await q('UPDATE businesses SET is_open=$1 WHERE id=$2', [newState, b.id]);
  res.json({ is_open: newState });
  } catch(e) { console.error("❌ route error:", req.method, req.path, e.message); if (!res.headersSent) res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════
//  CATEGORÍAS
// ════════════════════════════════════════════════
app.get('/api/businesses/mine/categories', auth, role('owner'), async (req, res) => {
  try {
  const b = await q1('SELECT id FROM businesses WHERE owner_id=$1',[req.user.id]);
  if (!b) return res.status(404).json({ error:'Sin negocio' });
  res.json(await qa('SELECT * FROM product_categories WHERE business_id=$1 ORDER BY sort_order',[b.id]));
  } catch(e) { console.error("❌ route error:", req.method, req.path, e.message); if (!res.headersSent) res.status(500).json({ error: e.message }); }
});
app.post('/api/businesses/mine/categories', auth, role('owner'), async (req, res) => {
  try {
  
  const b = await q1('SELECT id FROM businesses WHERE owner_id=$1',[req.user.id]);
  if (!b) return res.status(404).json({ error:'Sin negocio' });
  const { name, parent_id=null, sort_order=0 } = req.body;
  if (!name) return res.status(400).json({ error:'name es obligatorio' });
  const id = uuid();
  await q('INSERT INTO product_categories (id,business_id,parent_id,name,sort_order) VALUES ($1,$2,$3,$4,$5)',[id,b.id,parent_id||null,name.trim(),sort_order]);
  res.status(201).json(await q1('SELECT * FROM product_categories WHERE id=$1',[id]));
  } catch(e) { console.error(`❌ categories POST:`, e.message); res.status(500).json({ error: e.message }); }
});
app.patch('/api/businesses/mine/categories/:cid', auth, role('owner'), async (req, res) => {
  try {
  const b = await q1('SELECT id FROM businesses WHERE owner_id=$1',[req.user.id]);
  if (!b) return res.status(404).json({ error:'Sin negocio' });
  const { name, parent_id, sort_order } = req.body;
  await q('UPDATE product_categories SET name=COALESCE($1,name),parent_id=COALESCE($2,parent_id),sort_order=COALESCE($3,sort_order) WHERE id=$4 AND business_id=$5',
    [name,parent_id,sort_order,req.params.cid,b.id]);
  res.json(await q1('SELECT * FROM product_categories WHERE id=$1',[req.params.cid]));
  } catch(e) { console.error("❌ route error:", req.method, req.path, e.message); if (!res.headersSent) res.status(500).json({ error: e.message }); }
});
app.delete('/api/businesses/mine/categories/:cid', auth, role('owner'), async (req, res) => {
  try {
  
  const b = await q1('SELECT id FROM businesses WHERE owner_id=$1',[req.user.id]);
  if (!b) return res.status(404).json({ error:'Sin negocio' });
  const cat = await q1('SELECT * FROM product_categories WHERE id=$1',[req.params.cid]);
  if (cat) await q('UPDATE product_categories SET parent_id=$1 WHERE parent_id=$2',[cat.parent_id,req.params.cid]);
  await q('UPDATE products SET category_id=NULL WHERE category_id=$1 AND business_id=$2',[req.params.cid,b.id]);
  await q('DELETE FROM product_categories WHERE id=$1 AND business_id=$2',[req.params.cid,b.id]);
  res.json({ success:true });
  } catch(e) { console.error(`❌ categories DELETE:`, e.message); res.status(500).json({ error: e.message }); }
});


// GET products + categories for owner app menu tab
app.get('/api/businesses/mine/products', auth, role('owner'), async (req, res) => {
  try {
  
  const b = await q1('SELECT * FROM businesses WHERE owner_id=$1', [req.user.id]);
  if (!b) return res.status(404).json({ error: 'Sin negocio' });
  const rawProds = await qa('SELECT * FROM products WHERE business_id=$1 ORDER BY created_at DESC', [b.id]);
  const products = await Promise.all(rawProds.map(async p => ({
    ...p,
    photos:   await qa('SELECT id,url,sort_order FROM product_photos WHERE product_id=$1 ORDER BY sort_order', [p.id]),
    variants: await qa('SELECT * FROM product_variants WHERE product_id=$1 ORDER BY group_name,sort_order', [p.id]),
  })));
  const categories = await qa('SELECT * FROM product_categories WHERE business_id=$1 ORDER BY sort_order', [b.id]);
  res.json({ products, categories });
  } catch(e) { console.error(`❌ products GET:`, e.message); res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════
//  PRODUCTOS
// ════════════════════════════════════════════════
app.post('/api/businesses/mine/products', auth, role('owner'), async (req, res) => {
  try {
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
  } catch(e) { console.error("❌ route error:", req.method, req.path, e.message); if (!res.headersSent) res.status(500).json({ error: e.message }); }
});

app.patch('/api/businesses/mine/products/:pid', auth, role('owner'), async (req, res) => {
  try {
  const b = await q1('SELECT id FROM businesses WHERE owner_id=$1',[req.user.id]);
  if (!b) return res.status(404).json({ error:'No tenés ningún negocio' });
  const { name, description, price, emoji, is_available, is_featured, discount_percent, category_id, photos, variants, stock } = req.body;
  await q(`UPDATE products SET name=COALESCE($1,name),description=COALESCE($2,description),price=COALESCE($3,price),emoji=COALESCE($4,emoji),is_available=COALESCE($5,is_available),category_id=COALESCE($6,category_id),is_featured=COALESCE($7,is_featured),discount_percent=COALESCE($8,discount_percent),stock=CASE WHEN $11::text IS NULL THEN stock ELSE $11::integer END WHERE id=$9 AND business_id=$10`,
    [name,description,price!=null?parseFloat(price):null,emoji,is_available!=null?Boolean(is_available):null,category_id||null,is_featured!=null?Boolean(is_featured):null,discount_percent!=null?parseInt(discount_percent):null,req.params.pid,b.id,stock!==undefined?(stock===null?null:parseInt(stock)):null]);
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
  } catch(e) { console.error("❌ route error:", req.method, req.path, e.message); if (!res.headersSent) res.status(500).json({ error: e.message }); }
});

app.delete('/api/businesses/mine/products/:pid', auth, role('owner'), async (req, res) => {
  try {
  
  const b = await q1('SELECT id FROM businesses WHERE owner_id=$1',[req.user.id]);
  if (!b) return res.status(404).json({ error:'No tenés ningún negocio' });
  await q('UPDATE products SET is_available=FALSE WHERE id=$1 AND business_id=$2',[req.params.pid,b.id]);
  res.json({ success:true });
  } catch(e) { console.error(`❌ product DELETE:`, e.message); res.status(500).json({ error: e.message }); }
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

    // ── MODO GRATUITO TEMPORAL — skip payment (DESACTIVADO) ──
    // return res.json({ reg_id: regId, demo: true });

    // ── Preapproval: recurring subscription ──
    // Si MP no está configurado, usar modo demo como fallback
    if (!mp || !process.env.MP_ACCESS_TOKEN?.startsWith('APP_USR-')) {
      console.warn('⚠️  MP no configurado — usando modo demo para registro');
      return res.json({ reg_id: regId, demo: true });
    }
    const backUrl = `${APP_URL}/?reg=${regId}&payment=success`;
    console.log('🔗 Preapproval back_url:', backUrl);
    const preapproval = await mp.preapproval.create({
      reason: `Blow — Plan mensual negocios`,
      external_reference: `reg:${regId}`,
      payer_email: emailLow,
      auto_recurring: {
        frequency: 1,
        frequency_type: 'months',
        transaction_amount: Math.max(PLAN_PRICE || 2990, 1),
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
  try {
  
  const b = await q1('SELECT * FROM businesses WHERE owner_id=$1',[req.user.id]);
  if (!b) return res.status(404).json({ error:'Sin negocio' });
  const sub = await q1('SELECT * FROM subscriptions WHERE business_id=$1',[b.id]);
  res.json({ subscription: sub, plan_price: PLAN_PRICE });
  } catch(e) { console.error(`❌ subscription GET:`, e.message); res.status(500).json({ error: e.message }); }
});

// Renew/reactivate subscription (for suspended accounts)
app.post('/api/subscription/renew', auth, role('owner'), async (req, res) => {
  try {
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
  } catch(e) { console.error("❌ route error:", req.method, req.path, e.message); if (!res.headersSent) res.status(500).json({ error: e.message }); }
});

// Cancel subscription
app.post('/api/subscription/cancel', auth, role('owner'), async (req, res) => {
  try {
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
  } catch(e) { console.error("❌ route error:", req.method, req.path, e.message); if (!res.headersSent) res.status(500).json({ error: e.message }); }
});

// Admin — view all subscriptions
app.get('/api/admin/subscriptions', auth, role('admin'), async (req, res) => {
  try {
  res.json(await qa(`SELECT s.*,b.name as business_name,u.email as owner_email,u.name as owner_name
    FROM subscriptions s
    JOIN businesses b ON s.business_id=b.id
    JOIN users u ON s.owner_id=u.id
    ORDER BY s.created_at DESC`,[]));
  } catch(e) { console.error("❌ route error:", req.method, req.path, e.message); if (!res.headersSent) res.status(500).json({ error: e.message }); }
});
// Admin — manually activate a subscription
app.post('/api/admin/subscriptions/:id/activate', auth, role('admin'), async (req, res) => {
  try {
  const periodEnd = new Date(); periodEnd.setMonth(periodEnd.getMonth()+1);
  await q("UPDATE subscriptions SET status='active',current_period_start=NOW(),current_period_end=$1,updated_at=NOW() WHERE id=$2",
    [periodEnd.toISOString(), req.params.id]);
  res.json({ success:true });
  } catch(e) { console.error("❌ route error:", req.method, req.path, e.message); if (!res.headersSent) res.status(500).json({ error: e.message }); }
});
// Admin — create subscription for a business that has none
app.post('/api/admin/businesses/:id/activate', auth, role('admin'), async (req, res) => {
  try {
    const b = await q1('SELECT * FROM businesses WHERE id=$1', [req.params.id]);
    if (!b) return res.status(404).json({ error:'Negocio no encontrado' });
    const periodEnd = new Date(); periodEnd.setMonth(periodEnd.getMonth()+1);
    await q(`INSERT INTO subscriptions (id,business_id,owner_id,plan,status,current_period_start,current_period_end)
      VALUES ($1,$2,$3,'active','active',NOW(),$4)
      ON CONFLICT (business_id) DO UPDATE SET status='active',current_period_start=NOW(),current_period_end=$4,updated_at=NOW()`,
      [uuid(), b.id, b.owner_id, periodEnd.toISOString()]);
    res.json({ success:true });
  } catch(e) { res.status(500).json({ error:e.message }); }
});
// Admin — suspend a subscription
app.post('/api/admin/subscriptions/:id/suspend', auth, role('admin'), async (req, res) => {
  try {
  await q("UPDATE subscriptions SET status='suspended',updated_at=NOW() WHERE id=$1",[req.params.id]);
  res.json({ success:true });
  } catch(e) { console.error("❌ route error:", req.method, req.path, e.message); if (!res.headersSent) res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════
//  PEDIDOS
// ════════════════════════════════════════════════
// ── Error tracking ───────────────────────────
let Sentry = null;
try {
  Sentry = require('@sentry/node');
  if (process.env.SENTRY_DSN) {
    Sentry.init({
      dsn: process.env.SENTRY_DSN,
      environment: process.env.NODE_ENV || 'development',
      tracesSampleRate: 0.1,
    });
    console.log('✅ Sentry inicializado');
  }
} catch(e) { console.warn('Sentry no disponible:', e.message); }

// Recibir errores del frontend (cuando no hay Sentry en el cliente)
app.post('/api/client-error', (req, res) => {
  const { message, source, line, stack, url, userAgent } = req.body || {};
  const entry = { message, source, line, stack: stack?.slice(0,500), url, userAgent, t: new Date().toISOString() };
  console.error('[CLIENT ERROR]', JSON.stringify(entry));
  if (Sentry && process.env.SENTRY_DSN) {
    Sentry.captureException(new Error(message || 'Client error'), { extra: entry });
  }
  res.json({ ok: true });
});

// ── Fraud detection ───────────────────────────
async function checkFraud(userId, ip) {
  const issues = [];
  // 1. Too many orders in last hour (>5)
  const recentOrders = await q1(
    `SELECT COUNT(*) as c FROM orders WHERE customer_id=$1 AND created_at > NOW() - INTERVAL '1 hour'`,
    [userId]
  );
  if (parseInt(recentOrders.c) >= 5) issues.push('rate_limit_orders');

  // 2. High refund rate (>50% of last 20 delivered orders were refunded)
  const refundStats = await q1(
    `SELECT COUNT(*) FILTER (WHERE refund_status='approved') as refunded,
            COUNT(*) FILTER (WHERE status='delivered') as delivered
     FROM orders WHERE customer_id=$1 ORDER BY created_at DESC LIMIT 20`,
    [userId]
  );
  const refundRate = parseInt(refundStats.delivered) > 5
    ? parseInt(refundStats.refunded) / parseInt(refundStats.delivered)
    : 0;
  if (refundRate > 0.5) issues.push('high_refund_rate');

  // 3. Multiple pending unpaid orders (>3)
  const pendingUnpaid = await q1(
    `SELECT COUNT(*) as c FROM orders WHERE customer_id=$1 AND status='pending' AND created_at > NOW() - INTERVAL '2 hours'`,
    [userId]
  );
  if (parseInt(pendingUnpaid.c) >= 3) issues.push('too_many_pending');

  return { blocked: issues.includes('rate_limit_orders') || issues.includes('too_many_pending'), issues };
}

app.post('/api/orders', auth, role('customer'), async (req, res) => {
  try {
  // Check business is open
  const bizCheck = await q1('SELECT is_open FROM businesses WHERE id=$1', [req.body.business_id]);
  if (bizCheck && !bizCheck.is_open) {
    return res.status(400).json({ error: 'Este negocio está cerrado en este momento. Intentá más tarde.' });
  }
  // Fraud check
  const clientIp = req.headers['x-forwarded-for']?.split(',')[0] || req.ip;
  const fraud = await checkFraud(req.user.id, clientIp).catch(() => ({ blocked: false, issues: [] }));
  if (fraud.blocked) {
    console.warn(`🚨 Fraude bloqueado: user=${req.user.id} ip=${clientIp} issues=${fraud.issues.join(',')}`);
    return res.status(429).json({ error: 'Demasiados pedidos en poco tiempo. Esperá unos minutos.' });
  }
  if (fraud.issues.includes('high_refund_rate')) {
    // Log but don't block — flag for manual review
    console.warn(`⚠️ Alta tasa de reembolsos: user=${req.user.id} issues=${fraud.issues.join(',')}`);
  }
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
      // Stock check
      if (p.stock !== null && p.stock !== undefined && p.stock < qty) {
        if (p.stock === 0) return res.status(400).json({ error:`"${p.name}" está sin stock` });
        return res.status(400).json({ error:`Solo quedan ${p.stock} unidades de "${p.name}"` });
      }
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
    const scheduledFor = req.body.scheduled_for ? new Date(req.body.scheduled_for) : null;
    const isScheduled = !!scheduledFor;
    // Pay-on-delivery: validate the business accepts it
    const payOnDelivery = !!req.body.pay_on_delivery;
    const paymentMethod = req.body.payment_method || 'online'; // 'online' | 'cash' | 'card_pos'
    if (payOnDelivery) {
      if (paymentMethod === 'cash' && !biz.accepts_cash)
        return res.status(400).json({ error: 'Este negocio no acepta pago en efectivo' });
      if (paymentMethod === 'card_pos' && !biz.accepts_card_pos)
        return res.status(400).json({ error: 'Este negocio no acepta tarjeta en persona' });
    }
    await q(`INSERT INTO orders (id,customer_id,business_id,status,subtotal,delivery_fee,total,address,business_amount,delivery_amount,platform_amount,scheduled_for,is_scheduled,pay_on_delivery,payment_method) VALUES ($1,$2,$3,'pending',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [orderId,req.user.id,business_id,subtotal,fee,total,address||cust.address||'',bizAmt,fee,plat,scheduledFor,isScheduled,payOnDelivery,paymentMethod]);
    for (const i of lineItems) {
      const n = i.variant_label ? `${i.name} (${i.variant_label})` : i.name;
      await q('INSERT INTO order_items (id,order_id,product_id,name,emoji,price,quantity) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [uuid(),orderId,i.id,n,i.emoji||'🍽️',i.unit_price,i.quantity]);
    }
    notify(biz.owner_id,{ type:'new_order',message:`🔔 Nuevo pedido #${orderId.slice(-6).toUpperCase()} — $${total}`,order_id:orderId,total });
    const mpReady = mp && process.env.MP_ACCESS_TOKEN && process.env.MP_ACCESS_TOKEN.startsWith('APP_USR-');
    const isProduction = process.env.NODE_ENV === 'production';

    // Pay-on-delivery: skip MP, confirm order immediately
    if (payOnDelivery) {
      await q(`UPDATE orders SET status='confirmed', confirmed_at=NOW() WHERE id=$1`, [orderId]);
      notify(biz.owner_id, { type:'new_order', message:`🔔 Nuevo pedido #${orderId.slice(-6).toUpperCase()} — $${total} (pago al recibir)`, order_id:orderId, total });
      notify(req.user.id, { type:'status_change', message:'✅ Pedido confirmado. Pagás al recibir.', status:'confirmed', order_id:orderId });
      return res.json({ order_id:orderId, pay_on_delivery:true });
    }

    if (mpReady) {
      const pref = await mp.preferences.create({
        items: lineItems.map(i=>({ title:i.name,quantity:i.quantity,unit_price:i.unit_price,currency_id:'UYU' })),
        payer: { name:cust.name,email:cust.email },
        external_reference: orderId,
        back_urls:{ success:`${APP_URL}/`,failure:`${APP_URL}/`,pending:`${APP_URL}/` },
        auto_return:'approved',
        notification_url:`${APP_URL}/api/webhooks/mp`,
      });
      res.json({ order_id:orderId,payment:{ id:pref.body.id,init_point:pref.body.init_point } });
    } else if (isProduction) {
      // In production without MP → delete order and fail loudly. Never silently confirm unpaid orders.
      await q('DELETE FROM order_items WHERE order_id=$1', [orderId]);
      await q('DELETE FROM orders WHERE id=$1', [orderId]);
      console.error('🚨 PROD: Intento de pedido sin MP configurado. Orden eliminada:', orderId);
      return res.status(503).json({ error: 'El sistema de pagos no está disponible. Contactá soporte en hola@blow.uy' });
    } else {
      // Dev/staging only — demo mode, never runs in production
      await q(`UPDATE orders SET status='confirmed',updated_at=NOW() WHERE id=$1`,[orderId]);
      notify(biz.owner_id,{ type:'new_order',message:`💰 [DEV] Pedido #${orderId.slice(-6).toUpperCase()}`,order_id:orderId,total });
      notify(req.user.id,{ type:'status_change',message:'✅ Pedido confirmado (modo dev)',status:'confirmed',order_id:orderId });
      res.json({ order_id:orderId,demo:true });
    }
  } catch(e) { console.error(e); res.status(500).json({ error:e.message }); }
  } catch(e) { console.error("❌ route error:", req.method, req.path, e.message); if (!res.headersSent) res.status(500).json({ error: e.message }); }
});

app.get('/api/orders', auth, async (req, res) => {
  try {
  
  let orders;
  if (req.user.role==='customer') orders=await qa(`SELECT o.*,b.name as business_name,b.logo_emoji,
    EXISTS(SELECT 1 FROM reviews r WHERE r.order_id=o.id) as has_review
    FROM orders o JOIN businesses b ON o.business_id=b.id WHERE o.customer_id=$1 ORDER BY o.created_at DESC`,[req.user.id]);
  else if (req.user.role==='delivery') orders=await qa(`SELECT o.*,b.name as business_name,b.address as business_address,u.name as customer_name,u.phone as customer_phone FROM orders o JOIN businesses b ON o.business_id=b.id JOIN users u ON o.customer_id=u.id WHERE o.status IN ('ready','on_way') OR o.delivery_id=$1 ORDER BY o.created_at DESC`,[req.user.id]);
  else orders=await qa('SELECT o.*,b.name as business_name FROM orders o JOIN businesses b ON o.business_id=b.id ORDER BY o.created_at DESC LIMIT 100',[]);
  const result=await Promise.all(orders.map(async o=>({...o,items:await qa('SELECT * FROM order_items WHERE order_id=$1',[o.id])})));
  res.json(result);
  } catch(e) { console.error(`❌ orders GET:`, e.message); res.status(500).json({ error: e.message }); }
});

app.get('/api/orders/:id', auth, async (req, res) => {
  try {
  
  const o=await q1('SELECT o.*,b.name as business_name,b.address as business_address,b.logo_emoji,u.name as customer_name FROM orders o JOIN businesses b ON o.business_id=b.id JOIN users u ON o.customer_id=u.id WHERE o.id=$1',[req.params.id]);
  if (!o) return res.status(404).json({ error:'Pedido no encontrado' });
  o.items=await qa('SELECT * FROM order_items WHERE order_id=$1',[o.id]);
  res.json(o);
  } catch(e) { console.error(`❌ order get by id:`, e.message); res.status(500).json({ error: e.message }); }
});

app.patch('/api/orders/:id/status', auth, async (req, res) => {
  try {
  
  const { status } = req.body;
  const order=await q1('SELECT * FROM orders WHERE id=$1',[req.params.id]);
  if (!order) return res.status(404).json({ error:'Pedido no encontrado' });
  const allowed={ owner:{confirmed:'preparing',preparing:'ready',ready:'on_way',on_way:'delivered'},delivery:{ready:'on_way',on_way:'delivered'},admin:{pending:'confirmed',confirmed:'preparing',preparing:'ready',ready:'on_way',on_way:'delivered'} };
  const ra=allowed[req.user.role];
  if (!ra || ra[order.status]!==status) return res.status(400).json({ error:`No podés cambiar de ${order.status} a ${status}` });
  if (req.user.role==='owner') {
    const b=await q1('SELECT id FROM businesses WHERE owner_id=$1',[req.user.id]);
    if (!b||b.id!==order.business_id) return res.status(403).json({ error:'No es tu pedido' });
  }
  await q('UPDATE orders SET status=$1,updated_at=NOW() WHERE id=$2',[status,order.id]);
  if (status==='on_way') await q('UPDATE orders SET delivery_id=$1 WHERE id=$2',[req.user.id,order.id]);
  // Record per-status timestamps and set ETA when confirmed
  if (status==='confirmed') {
    const biz = await q1('SELECT delivery_time FROM businesses WHERE id=$1',[order.business_id]);
    // Parse delivery_time like "20-35" → take upper bound, or plain number
    let etaMin = 30;
    if (biz?.delivery_time) {
      const parts = biz.delivery_time.toString().split('-');
      etaMin = parseInt(parts[parts.length - 1]) || 30;
    }
    // Allow owner to override ETA via body
    if (req.body.eta_minutes && parseInt(req.body.eta_minutes) > 0) {
      etaMin = parseInt(req.body.eta_minutes);
    }
    await q('UPDATE orders SET confirmed_at=NOW(), eta_minutes=$1 WHERE id=$2',[etaMin, order.id]);
  }
  if (status==='preparing') await q('UPDATE orders SET preparing_at=NOW() WHERE id=$1',[order.id]);
  if (status==='ready')     await q('UPDATE orders SET ready_at=NOW() WHERE id=$1',[order.id]);
  // Decrement stock when confirmed
  if (status==='confirmed') {
    const items = await db.query('SELECT * FROM order_items WHERE order_id=$1',[order.id]);
    for (const item of items.rows) {
      await q('UPDATE products SET stock = stock - $1 WHERE id=$2 AND stock IS NOT NULL AND stock > 0',
        [item.quantity, item.product_id]);
    }
  }
  if (status==='delivered') {
    // Since owner does their own delivery, credit them business + delivery amounts
    const totalOwnerAmount = parseFloat(order.business_amount||0) + parseFloat(order.delivery_amount||0);
    await credit(order.business_id,'business',totalOwnerAmount,`Pedido #${order.id.slice(-6).toUpperCase()}`,order.id);
    await credit('platform','platform',order.platform_amount,`Comisión #${order.id.slice(-6).toUpperCase()}`,order.id);
    // Award loyalty points to customer
    await awardLoyaltyPoints(order.customer_id, order.business_id, order.id, order.subtotal || order.total);
  }
  // Calculate remaining ETA for notification
  const updatedOrder = await q1('SELECT * FROM orders WHERE id=$1',[order.id]);
  let etaRemaining = null;
  if (updatedOrder.confirmed_at && updatedOrder.eta_minutes) {
    const elapsed = (Date.now() - new Date(updatedOrder.confirmed_at).getTime()) / 60000;
    etaRemaining = Math.max(0, Math.round(updatedOrder.eta_minutes - elapsed));
  }
  const statusMessages = {
    confirmed:  `✅ Pedido aceptado${etaRemaining ? ` · llega en ~${etaRemaining} min` : ''}`,
    preparing:  '👨‍🍳 Están preparando tu pedido',
    ready:      '📦 Tu pedido está listo para entrega',
    on_way:     '🛵 Tu pedido está en camino',
    delivered:  '🏁 ¡Pedido entregado!'
  };
  notify(order.customer_id,{
    type:'status_change',
    message: statusMessages[status] || `Tu pedido: ${status}`,
    status, order_id:order.id,
    eta_minutes: updatedOrder.eta_minutes,
    confirmed_at: updatedOrder.confirmed_at,
    eta_remaining: etaRemaining,
  });
  const biz=await q1('SELECT owner_id FROM businesses WHERE id=$1',[order.business_id]);
  if (biz) notify(biz.owner_id,{ type:'order_update',status,order_id:order.id });
  res.json(updatedOrder);
  } catch(e) { console.error(`❌ order status PATCH:`, e.message); res.status(500).json({ error: e.message }); }
});

// Owner sends a message to the customer about their order
// ── ETA ───────────────────────────────────────
app.get('/api/orders/:id/eta', auth, async (req, res) => {
  try {
  
  const order = await q1('SELECT id,status,confirmed_at,eta_minutes,business_id FROM orders WHERE id=$1',[req.params.id]);
  if (!order) return res.status(404).json({ error:'No encontrado' });
  if (!order.confirmed_at || !order.eta_minutes) return res.json({ eta_minutes: null, remaining: null, status: order.status });
  const elapsedMin = (Date.now() - new Date(order.confirmed_at).getTime()) / 60000;
  const remaining = Math.max(0, Math.round(order.eta_minutes - elapsedMin));
  const percent = Math.min(100, Math.round((elapsedMin / order.eta_minutes) * 100));
  res.json({ eta_minutes: order.eta_minutes, remaining, elapsed: Math.round(elapsedMin), percent, status: order.status });
  } catch(e) { console.error("❌ orders/:id/eta:", e.message); res.status(500).json({ error: e.message }); }
});

app.patch('/api/orders/:id/eta', auth, role('owner'), async (req, res) => {
  try {
  const { eta_minutes } = req.body;
  if (!eta_minutes || parseInt(eta_minutes) < 1) return res.status(400).json({ error: 'ETA inválido' });
  const order = await q1('SELECT * FROM orders WHERE id=$1',[req.params.id]);
  if (!order) return res.status(404).json({ error:'No encontrado' });
  const biz = await q1('SELECT id FROM businesses WHERE owner_id=$1',[req.user.id]);
  if (!biz || biz.id !== order.business_id) return res.status(403).json({ error:'No es tu pedido' });
  // Reset confirmed_at to now so countdown restarts from new ETA
  await q('UPDATE orders SET eta_minutes=$1, confirmed_at=NOW() WHERE id=$2',[parseInt(eta_minutes), order.id]);
  notify(order.customer_id, {
    type: 'eta_update',
    message: `🕐 El negocio ajustó el tiempo: ~${eta_minutes} min`,
    order_id: order.id,
    eta_minutes: parseInt(eta_minutes),
  });
  res.json({ ok: true, eta_minutes: parseInt(eta_minutes) });
  } catch(e) { console.error("❌ route error:", req.method, req.path, e.message); if (!res.headersSent) res.status(500).json({ error: e.message }); }
});

app.post('/api/orders/:id/message', auth, role('owner'), async (req, res) => {
  try {
  
  const { message } = req.body;
  if (!message?.trim()) return res.status(400).json({ error: 'Mensaje vacío' });
  const order = await q1('SELECT * FROM orders WHERE id=$1', [req.params.id]);
  if (!order) return res.status(404).json({ error: 'Pedido no encontrado' });
  const biz = await q1('SELECT id, name FROM businesses WHERE owner_id=$1', [req.user.id]);
  if (!biz || biz.id !== order.business_id) return res.status(403).json({ error: 'No es tu pedido' });
  await q('UPDATE orders SET owner_message=$1, owner_message_at=NOW() WHERE id=$2', [message.trim(), order.id]);
  notify(order.customer_id, {
    type: 'owner_message',
    message: message.trim(),
    business_name: biz.name,
    order_id: order.id,
  });
  res.json({ ok: true });
  } catch(e) { console.error("❌ orders/:id/message:", e.message); res.status(500).json({ error: e.message }); }
});

// ── Refund helper ──────────────────────────────────────────
async function issueRefund(order) {
  if (!order.mp_payment_id || order.mp_status !== 'approved') return { ok: false, reason: 'no_payment' };
  if (order.refund_status === 'approved') return { ok: true, reason: 'already_refunded' };
  try {
    if (!mp || !process.env.MP_ACCESS_TOKEN?.startsWith('APP_USR-')) {
      await q(`UPDATE orders SET refund_status='approved',refunded_at=NOW() WHERE id=$1`, [order.id]);
      return { ok: true, reason: 'demo' };
    }
    const refundRes = await fetch(
      `https://api.mercadopago.com/v1/payments/${order.mp_payment_id}/refunds`,
      { method: 'POST',
        headers: { 'Authorization': `Bearer ${process.env.MP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({}) }
    );
    const refundData = await refundRes.json();
    if (refundData.id || refundData.status === 'approved') {
      await q(`UPDATE orders SET refund_status='approved',refund_id=$1,refunded_at=NOW() WHERE id=$2`,
        [String(refundData.id || 'mp-refunded'), order.id]);
      return { ok: true, refund_id: refundData.id };
    } else {
      await q(`UPDATE orders SET refund_status='failed' WHERE id=$1`, [order.id]);
      return { ok: false, reason: refundData.message || 'mp_error' };
    }
  } catch(e) {
    await q(`UPDATE orders SET refund_status='failed' WHERE id=$1`, [order.id]);
    return { ok: false, reason: e.message };
  }
}

app.post('/api/orders/:id/cancel', auth, async (req, res) => {
  try {
  
  const order=await q1('SELECT * FROM orders WHERE id=$1',[req.params.id]);
  if (!order) return res.status(404).json({ error:'No encontrado' });
  if (!['pending','confirmed'].includes(order.status)) return res.status(400).json({ error:'No se puede cancelar' });
  if (req.user.role==='customer'&&order.customer_id!==req.user.id) return res.status(403).json({ error:'No es tu pedido' });
  await q("UPDATE orders SET status='cancelled',updated_at=NOW() WHERE id=$1",[order.id]);
  const biz=await q1('SELECT owner_id,name FROM businesses WHERE id=$1',[order.business_id]);
  if (biz) notify(biz.owner_id,{ type:'order_cancelled',message:`❌ Pedido cancelado`,order_id:order.id });
  let refund = { ok: false, reason: 'no_payment' };
  if (order.mp_payment_id && order.mp_status === 'approved') {
    refund = await issueRefund(order);
    if (refund.ok) notify(order.customer_id, { type:'refund_issued', message:`💸 Reembolso procesado por $${order.total}`, order_id: order.id });
  }
  res.json({ success:true, refund });
  } catch(e) { console.error(`❌ order cancel:`, e.message); res.status(500).json({ error: e.message }); }
});


// Poll order payment status (frontend polls while waiting for MP webhook)
// Manual refund endpoint (admin or owner)
app.post('/api/orders/:id/refund', auth, async (req, res) => {
  try {
  
  const order = await q1('SELECT * FROM orders WHERE id=$1', [req.params.id]);
  if (!order) return res.status(404).json({ error: 'No encontrado' });
  // Only admin or the business owner can trigger manual refund
  if (req.user.role === 'customer') return res.status(403).json({ error: 'Sin permisos' });
  if (req.user.role === 'owner') {
    const biz = await q1('SELECT id FROM businesses WHERE owner_id=$1', [req.user.id]);
    if (!biz || biz.id !== order.business_id) return res.status(403).json({ error: 'No es tu negocio' });
  }
  if (order.refund_status === 'approved') return res.status(400).json({ error: 'Ya fue reembolsado' });
  const refund = await issueRefund(order);
  if (refund.ok) {
    notify(order.customer_id, { type:'refund_issued', message:`💸 Reembolso procesado por $${order.total}`, order_id: order.id });
  }
  res.json({ ok: refund.ok, refund });
  } catch(e) { console.error(`❌ order refund:`, e.message); res.status(500).json({ error: e.message }); }
});

app.get('/api/orders/:id/payment-status', auth, async (req, res) => {
  try {
  const order = await q1('SELECT id,status,mp_status,total,created_at FROM orders WHERE id=$1 AND customer_id=$2',[req.params.id, req.user.id]);
  if (!order) return res.status(404).json({ error:'No encontrado' });
  res.json({ status: order.status, mp_status: order.mp_status, total: order.total });
  } catch(e) { console.error("❌ route error:", req.method, req.path, e.message); if (!res.headersSent) res.status(500).json({ error: e.message }); }
});

// ── Reviews ──────────────────────────────────────
// Post a review for a delivered order
app.post('/api/orders/:id/review', auth, role('customer'), async (req, res) => {
  try {
    const { rating, comment } = req.body;
    if (!rating || rating < 1 || rating > 5) return res.status(400).json({ error: 'Rating debe ser entre 1 y 5' });
    const order = await q1('SELECT * FROM orders WHERE id=$1 AND customer_id=$2', [req.params.id, req.user.id]);
    if (!order) return res.status(404).json({ error: 'Pedido no encontrado' });
    if (order.status !== 'delivered') return res.status(400).json({ error: 'Solo podés reseñar pedidos entregados' });
    // Check not already reviewed
    const existing = await q1('SELECT id FROM reviews WHERE order_id=$1', [order.id]);
    if (existing) return res.status(400).json({ error: 'Ya reseñaste este pedido' });
    // Insert review
    await q('INSERT INTO reviews (id,order_id,business_id,customer_id,rating,comment) VALUES ($1,$2,$3,$4,$5,$6)',
      [uuid(), order.id, order.business_id, req.user.id, parseInt(rating), comment||'']);
    // Recalculate business rating — only apply when 3+ reviews exist
    const revCount = await q1('SELECT COUNT(*) as c FROM reviews WHERE business_id=$1', [order.business_id]);
    const count = parseInt(revCount?.c || 0);
    if (count >= 3) {
      const avg = await q1('SELECT ROUND(AVG(rating)::numeric, 1) as avg FROM reviews WHERE business_id=$1', [order.business_id]);
      if (avg?.avg) await q('UPDATE businesses SET rating=$1 WHERE id=$2', [parseFloat(avg.avg), order.business_id]);
    } else {
      await q('UPDATE businesses SET rating=NULL WHERE id=$1', [order.business_id]);
    }
    res.json({ success: true });
  } catch(e) {
    if (e.code === '23505') return res.status(400).json({ error: 'Ya reseñaste este pedido' });
    res.status(500).json({ error: e.message });
  }
});

// Get reviews for a business (public)

// ── Global search ──────────────────────────────────────────
// ── Wallet summary — split online vs in-person ──────────
app.get('/api/owner/wallet-summary', auth, role('owner'), async (req, res) => {
  try {
  
  const b = await q1('SELECT id FROM businesses WHERE owner_id=$1', [req.user.id]);
  if (!b) return res.status(404).json({ error: 'Sin negocio' });
  const wallet = await q1('SELECT balance FROM wallets WHERE owner_id=$1', [b.id]) || { balance: 0 };
  const inPerson = await q1(`
    SELECT
      COALESCE(SUM(CASE WHEN payment_method='cash'     THEN total ELSE 0 END),0) as cash_total,
      COALESCE(SUM(CASE WHEN payment_method='card_pos' THEN total ELSE 0 END),0) as card_pos_total,
      COUNT(*) FILTER (WHERE pay_on_delivery=TRUE AND status='delivered') as in_person_orders
    FROM orders
    WHERE business_id=$1 AND pay_on_delivery=TRUE AND status='delivered'
  `, [b.id]);
  const today = await q1(`
    SELECT
      COALESCE(SUM(CASE WHEN pay_on_delivery=FALSE THEN total ELSE 0 END),0) as online_today,
      COALESCE(SUM(CASE WHEN pay_on_delivery=TRUE  THEN total ELSE 0 END),0) as in_person_today
    FROM orders
    WHERE business_id=$1 AND status='delivered' AND DATE(created_at)=CURRENT_DATE
  `, [b.id]);
  res.json({
    online_balance:   parseFloat(wallet.balance) || 0,
    cash_total:       parseFloat(inPerson.cash_total) || 0,
    card_pos_total:   parseFloat(inPerson.card_pos_total) || 0,
    in_person_orders: parseInt(inPerson.in_person_orders) || 0,
    online_today:     parseFloat(today.online_today) || 0,
    in_person_today:  parseFloat(today.in_person_today) || 0,
  });
  } catch(e) { console.error(`❌ wallet summary:`, e.message); res.status(500).json({ error: e.message }); }
});

app.get('/api/search', async (req, res) => {
  try {
    const rawQ = (req.query.q || '').trim();
    if (!rawQ || rawQ.length < 2) return res.json({ products: [], businesses: [] });
    const { city, department } = req.query;

    // Build tsquery: each word becomes a prefix lexeme for partial matching
    const tsquery = rawQ.split(/\s+/)
      .filter(w => w.length > 1)
      .map(w => w.replace(/[^a-záéíóúüñA-ZÁÉÍÓÚÜÑ0-9]/g, '') + ':*')
      .filter(Boolean)
      .join(' & ');
    if (!tsquery) return res.json({ products: [], businesses: [] });

    // Fallback ILIKE for very short or special queries
    const like = `%${rawQ.toLowerCase()}%`;

    let locFilter = '';
    const baseParams = [tsquery, like];
    let pi = 3;
    if (city)       { locFilter += ` AND LOWER(b.city)=LOWER($${pi++})`;       baseParams.push(city); }
    if (department) { locFilter += ` AND LOWER(b.department)=LOWER($${pi++})`; baseParams.push(department); }

    // Products — FTS with relevance ranking, fallback to ILIKE
    const products = await db.query(`
      SELECT p.id, p.name, p.description, p.price, p.emoji, p.photo_url,
             p.discount_percent, p.is_available, p.stock,
             b.id as business_id, b.name as business_name, b.logo_emoji,
             b.logo_url, b.is_open, b.delivery_cost, b.delivery_time, b.category,
             ts_rank(to_tsvector('spanish', p.name || ' ' || COALESCE(p.description,'')), to_tsquery('spanish', $1)) as rank
      FROM products p
      JOIN businesses b ON p.business_id = b.id
      LEFT JOIN subscriptions s ON s.business_id = b.id
      WHERE (s.status = 'active' OR s.id IS NULL)
        AND p.is_available = TRUE
        AND (
          to_tsvector('spanish', p.name || ' ' || COALESCE(p.description,'')) @@ to_tsquery('spanish', $1)
          OR LOWER(p.name) LIKE $2
        )
        ${locFilter}
      ORDER BY b.is_open DESC, rank DESC, b.blow_plus DESC NULLS LAST
      LIMIT 30
    `, baseParams).catch(() =>
      // Fallback to ILIKE if FTS fails (e.g. invalid tsquery)
      db.query(`
        SELECT p.id, p.name, p.description, p.price, p.emoji, p.photo_url,
               p.discount_percent, p.is_available, p.stock,
               b.id as business_id, b.name as business_name, b.logo_emoji,
               b.logo_url, b.is_open, b.delivery_cost, b.delivery_time, b.category
        FROM products p JOIN businesses b ON p.business_id = b.id
        WHERE p.is_available = TRUE AND (LOWER(p.name) LIKE $1 OR LOWER(p.description) LIKE $1)
        ORDER BY b.is_open DESC LIMIT 30
      `, [like])
    );

    // Businesses — FTS + ILIKE fallback
    const bizParams = [tsquery, like, like];
    let bizLocFilter = '';
    let bpi = 4;
    if (city)       { bizLocFilter += ` AND LOWER(b.city)=LOWER($${bpi++})`;       bizParams.push(city); }
    if (department) { bizLocFilter += ` AND LOWER(b.department)=LOWER($${bpi++})`; bizParams.push(department); }

    const businesses = await db.query(`
      SELECT b.id, b.name, b.category, b.logo_emoji, b.logo_url,
             b.is_open, b.delivery_cost, b.delivery_time, b.rating, (SELECT COUNT(*) FROM reviews WHERE business_id=b.id) AS review_count,
             ts_rank(to_tsvector('spanish', b.name), to_tsquery('spanish', $1)) as rank
      FROM businesses b
      LEFT JOIN subscriptions s ON s.business_id = b.id
      WHERE (s.status = 'active' OR s.id IS NULL)
        AND (
          to_tsvector('spanish', b.name) @@ to_tsquery('spanish', $1)
          OR LOWER(b.name) LIKE $2 OR LOWER(b.category) LIKE $3
        )
        ${bizLocFilter}
      ORDER BY b.is_open DESC, rank DESC, b.blow_plus DESC NULLS LAST
      LIMIT 10
    `, bizParams).catch(() =>
      db.query(`
        SELECT b.id, b.name, b.category, b.logo_emoji, b.logo_url,
               b.is_open, b.delivery_cost, b.delivery_time, b.rating, (SELECT COUNT(*) FROM reviews WHERE business_id=b.id) AS review_count
        FROM businesses b WHERE LOWER(b.name) LIKE $1 OR LOWER(b.category) LIKE $1
        ORDER BY b.is_open DESC LIMIT 10
      `, [like])
    );

    res.json({ products: products.rows, businesses: businesses.rows });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/businesses/:id/reviews', async (req, res) => {
  try {
    const reviews = await qa(`
      SELECT r.*, u.name as customer_name
      FROM reviews r
      JOIN users u ON u.id = r.customer_id
      WHERE r.business_id=$1
      ORDER BY r.created_at DESC
      LIMIT 20
    `, [req.params.id]);
    res.json(reviews);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════
//  WALLET
// ════════════════════════════════════════════════
app.get('/api/wallet', auth, async (req, res) => {
  try {
  
  const ownerId=req.user.role==='owner'?(await q1('SELECT id FROM businesses WHERE owner_id=$1',[req.user.id]))?.id:req.user.id;
  if (!ownerId) return res.status(404).json({ error:'Sin negocio' });
  const wallet=await getWallet(ownerId,req.user.role);
  const txs=await qa('SELECT * FROM transactions WHERE wallet_id=$1 ORDER BY created_at DESC LIMIT 30',[wallet.id]);
  res.json({ balance:parseFloat(wallet.balance)||0,transactions:txs });
  } catch(e) { console.error(`❌ wallet GET:`, e.message); res.status(500).json({ error: e.message }); }
});





// ════════════════════════════════════════════════
//  BLOW+ CLIENTE
// ════════════════════════════════════════════════

// Get user Blow+ status
app.get('/api/user/blow-plus', auth, async (req, res) => {
  try {
  const u = await q1('SELECT blow_plus, blow_plus_since, blow_plus_expires FROM users WHERE id=$1', [req.user.id]);
  if (!u) return res.status(404).json({ error: 'Usuario no encontrado' });
  const now = new Date();
  const active = u.blow_plus && (!u.blow_plus_expires || new Date(u.blow_plus_expires) > now);
  res.json({ active, since: u.blow_plus_since, expires: u.blow_plus_expires });
  } catch(e) { console.error("❌ route error:", req.method, req.path, e.message); if (!res.headersSent) res.status(500).json({ error: e.message }); }
});

// Create MP preference for user Blow+
app.post('/api/user/blow-plus/subscribe', auth, async (req, res) => {
  try {
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
  } catch(e) { console.error("❌ route error:", req.method, req.path, e.message); if (!res.headersSent) res.status(500).json({ error: e.message }); }
});

// Cancel user Blow+
app.post('/api/user/blow-plus/cancel', auth, async (req, res) => {
  try {
  await q('UPDATE users SET blow_plus=FALSE WHERE id=$1', [req.user.id]);
  res.json({ success: true });
  } catch(e) { console.error("❌ route error:", req.method, req.path, e.message); if (!res.headersSent) res.status(500).json({ error: e.message }); }
});

// Admin: toggle user Blow+
app.patch('/api/admin/users/:id/blow-plus', auth, role('admin'), async (req, res) => {
  try {
  const { active } = req.body;
  if (active) {
    await q(`UPDATE users SET blow_plus=TRUE, blow_plus_since=NOW(), blow_plus_expires=NOW()+INTERVAL '30 days' WHERE id=$1`, [req.params.id]);
  } else {
    await q('UPDATE users SET blow_plus=FALSE WHERE id=$1', [req.params.id]);
  }
  res.json({ success: true });
  } catch(e) { console.error("❌ route error:", req.method, req.path, e.message); if (!res.headersSent) res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════
//  BLOW+ PREMIUM
// ════════════════════════════════════════════════

// Get Blow+ status
app.get('/api/businesses/mine/blow-plus', auth, role('owner'), async (req, res) => {
  try {
  const biz = await q1('SELECT blow_plus, blow_plus_since, blow_plus_expires FROM businesses WHERE owner_id=$1', [req.user.id]);
  if (!biz) return res.status(404).json({ error: 'Negocio no encontrado' });
  const now = new Date();
  const active = biz.blow_plus && (!biz.blow_plus_expires || new Date(biz.blow_plus_expires) > now);
  res.json({ active, since: biz.blow_plus_since, expires: biz.blow_plus_expires });
  } catch(e) { console.error("❌ route error:", req.method, req.path, e.message); if (!res.headersSent) res.status(500).json({ error: e.message }); }
});

// Create MP preference for Blow+ subscription
app.post('/api/businesses/mine/blow-plus/subscribe', auth, role('owner'), async (req, res) => {
  try {
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
  } catch(e) { console.error("❌ route error:", req.method, req.path, e.message); if (!res.headersSent) res.status(500).json({ error: e.message }); }
});

// Cancel Blow+
app.post('/api/businesses/mine/blow-plus/cancel', auth, role('owner'), async (req, res) => {
  try {
  const biz = await q1('SELECT id FROM businesses WHERE owner_id=$1', [req.user.id]);
  if (!biz) return res.status(404).json({ error: 'Negocio no encontrado' });
  await q('UPDATE businesses SET blow_plus=FALSE WHERE id=$1', [biz.id]);
  res.json({ success: true, message: 'Blow+ cancelado. Seguirá activo hasta el vencimiento.' });
  } catch(e) { console.error("❌ route error:", req.method, req.path, e.message); if (!res.headersSent) res.status(500).json({ error: e.message }); }
});

// Admin: manually toggle Blow+ for a business
app.patch('/api/admin/businesses/:id/blow-plus', auth, role('admin'), async (req, res) => {
  try {
  const { active } = req.body;
  if (active) {
    await q(`UPDATE businesses SET blow_plus=TRUE, blow_plus_since=NOW(), blow_plus_expires=NOW()+INTERVAL '30 days' WHERE id=$1`, [req.params.id]);
  } else {
    await q('UPDATE businesses SET blow_plus=FALSE WHERE id=$1', [req.params.id]);
  }
  res.json({ success: true });
  } catch(e) { console.error("❌ route error:", req.method, req.path, e.message); if (!res.headersSent) res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════
//  PHOTO UPLOAD ROUTES
// ════════════════════════════════════════════════

// Upload business cover photo
app.post('/api/businesses/mine/upload-cover', auth, role('owner'), uploadMiddleware('photo'), async (req, res) => {
  try {
  if (!req.file) return res.status(400).json({ error: 'No se recibio imagen' });
  const url = req.file.path || req.file.secure_url;
  await q('UPDATE businesses SET cover_url=$1 WHERE owner_id=$2', [url, req.user.id]);
  res.json({ url });
  } catch(e) { console.error("❌ route error:", req.method, req.path, e.message); if (!res.headersSent) res.status(500).json({ error: e.message }); }
});

app.post('/api/businesses/mine/upload-logo', auth, role('owner'), uploadMiddleware('photo'), async (req, res) => {
  try {
  if (!req.file) return res.status(400).json({ error: 'No se recibio imagen' });
  const url = req.file.path || req.file.secure_url;
  await q('UPDATE businesses SET logo_url=$1 WHERE owner_id=$2', [url, req.user.id]);
  res.json({ url });
  } catch(e) { console.error("❌ route error:", req.method, req.path, e.message); if (!res.headersSent) res.status(500).json({ error: e.message }); }
});

app.post('/api/businesses/mine/products/:id/upload-photo', auth, role('owner'), uploadMiddleware('photo'), async (req, res) => {
  try {
  if (!req.file) return res.status(400).json({ error: 'No se recibio imagen' });
  const url = req.file.path || req.file.secure_url;
  const biz = await q1('SELECT id FROM businesses WHERE owner_id=$1', [req.user.id]);
  if (!biz) return res.status(404).json({ error: 'Negocio no encontrado' });
  await q('UPDATE products SET photo_url=$1 WHERE id=$2 AND business_id=$3', [url, req.params.id, biz.id]);
  res.json({ url });
  } catch(e) { console.error("❌ route error:", req.method, req.path, e.message); if (!res.headersSent) res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/businesses/:id/upload-cover', auth, role('admin'), uploadMiddleware('photo'), async (req, res) => {
  try {
  if (!req.file) return res.status(400).json({ error: 'No se recibio imagen' });
  const url = req.file.path || req.file.secure_url;
  await q('UPDATE businesses SET cover_url=$1 WHERE id=$2', [url, req.params.id]);
  res.json({ url });
  } catch(e) { console.error("❌ route error:", req.method, req.path, e.message); if (!res.headersSent) res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/businesses/:id/upload-logo', auth, role('admin'), uploadMiddleware('photo'), async (req, res) => {
  try {
  if (!req.file) return res.status(400).json({ error: 'No se recibio imagen' });
  const url = req.file.path || req.file.secure_url;
  await q('UPDATE businesses SET logo_url=$1 WHERE id=$2', [url, req.params.id]);
  res.json({ url });
  } catch(e) { console.error("❌ route error:", req.method, req.path, e.message); if (!res.headersSent) res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════
//  PROMOTIONS
// ═══════════════════════════════════════════════


// Owner: toggle Blow+ free delivery
app.patch('/api/businesses/mine/blow-plus-delivery', auth, role('owner'), async (req, res) => {
  try {
  const { enabled } = req.body;
  await q('UPDATE businesses SET blow_plus_free_delivery=$1 WHERE owner_id=$2', [!!enabled, req.user.id]);
  res.json({ success: true });
  } catch(e) { console.error("❌ route error:", req.method, req.path, e.message); if (!res.headersSent) res.status(500).json({ error: e.message }); }
});

// Owner: list own promotions
app.get('/api/businesses/mine/promotions', auth, role('owner'), async (req, res) => {
  try {
  
  const biz = await q1('SELECT id FROM businesses WHERE owner_id=$1',[req.user.id]);
  if (!biz) return res.status(404).json({ error:'Negocio no encontrado' });
  const promos = await qa('SELECT * FROM promotions WHERE business_id=$1 ORDER BY created_at DESC',[biz.id]);
  res.json(promos.map(p => ({ ...p, combo_products: safeJson(p.combo_products, []) })));
  } catch(e) { console.error(`❌ promotions GET:`, e.message); res.status(500).json({ error: e.message }); }
});

// Owner: create promotion
app.post('/api/businesses/mine/promotions', auth, role('owner'), async (req, res) => {
  try {
  
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
  } catch(e) { console.error(`❌ promotions POST:`, e.message); res.status(500).json({ error: e.message }); }
});

// Owner: update promotion
app.patch('/api/businesses/mine/promotions/:id', auth, role('owner'), async (req, res) => {
  try {
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
  } catch(e) { console.error("❌ route error:", req.method, req.path, e.message); if (!res.headersSent) res.status(500).json({ error: e.message }); }
});

// Owner: delete promotion
app.delete('/api/businesses/mine/promotions/:id', auth, role('owner'), async (req, res) => {
  try {
  const biz = await q1('SELECT id FROM businesses WHERE owner_id=$1',[req.user.id]);
  if (!biz) return res.status(404).json({ error:'Negocio no encontrado' });
  await q('DELETE FROM promotions WHERE id=$1 AND business_id=$2',[req.params.id,biz.id]);
  res.json({ success:true });
  } catch(e) { console.error("❌ route error:", req.method, req.path, e.message); if (!res.headersSent) res.status(500).json({ error: e.message }); }
});

app.post('/api/businesses', auth, role('owner'), async (req, res) => {
  try {
  if (await q1('SELECT id FROM businesses WHERE owner_id=$1',[req.user.id]))
    return res.status(409).json({ error:'Ya tenés un negocio registrado' });
  const { name, category, address='', phone='', logo_emoji='🏪', delivery_cost=50, delivery_time='20-35', city='', department='' } = req.body;
  if (!name || !category) return res.status(400).json({ error:'name y category son obligatorios' });
  if (!city.trim()) return res.status(400).json({ error:'La ciudad es obligatoria' });
  const id = uuid();
  await q('INSERT INTO businesses (id,owner_id,name,category,address,phone,logo_emoji,delivery_cost,delivery_time,city,department) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
    [id, req.user.id, name.trim(), category, address, phone, logo_emoji, delivery_cost, delivery_time, city.trim(), department]);
  res.status(201).json(await q1('SELECT * FROM businesses WHERE id=$1',[id]));
  } catch(e) { console.error("❌ route error:", req.method, req.path, e.message); if (!res.headersSent) res.status(500).json({ error: e.message }); }
});
app.get('/api/businesses/:id', async (req, res) => {
  try {
  const b = await q1('SELECT * FROM businesses WHERE id=$1',[req.params.id]);
  if (!b) return res.status(404).json({ error:'Negocio no encontrado' });
  const rawP = await qa('SELECT * FROM products WHERE business_id=$1 AND is_available=TRUE',[b.id]);
  const prods = await Promise.all(rawP.map(async p => ({
    ...p,
    photos:   await qa('SELECT id,url,sort_order FROM product_photos WHERE product_id=$1 ORDER BY sort_order',[p.id]),
    variants: await qa('SELECT * FROM product_variants WHERE product_id=$1 ORDER BY group_name,sort_order',[p.id]),
  })));
  const cats = await qa('SELECT * FROM product_categories WHERE business_id=$1 ORDER BY sort_order',[b.id]);
  const reviewStats = await q1('SELECT COUNT(*) as count, ROUND(AVG(rating)::numeric,1) as avg FROM reviews WHERE business_id=$1',[b.id]);
  const reviewCount = parseInt(reviewStats?.count||0);
  const rating = reviewCount >= 3 ? parseFloat(reviewStats.avg) : null;
  res.json({ ...b, products:prods, categories:cats, review_count: reviewCount, rating });
  } catch(e) { console.error("❌ route error:", req.method, req.path, e.message); if (!res.headersSent) res.status(500).json({ error: e.message }); }
});

// Public: get active promotions for a business
app.get('/api/businesses/:id/promotions', async (req, res) => {
  try {
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
  } catch(e) { console.error("❌ route error:", req.method, req.path, e.message); if (!res.headersSent) res.status(500).json({ error: e.message }); }
});

// Public: validate promo code
app.post('/api/businesses/:id/promotions/validate-code', async (req, res) => {
  try {
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
  } catch(e) { console.error("❌ route error:", req.method, req.path, e.message); if (!res.headersSent) res.status(500).json({ error: e.message }); }
});

app.post('/api/wallet/withdraw', auth, async (req, res) => {
  try {
  
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
  } catch(e) { console.error(`❌ wallet withdraw:`, e.message); res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════
//  ADMIN
// ════════════════════════════════════════════════
app.post('/api/admin/setup', async (req, res) => {
  try {
  if (await q1("SELECT id FROM users WHERE role='admin'",[]))
    return res.status(403).json({ error:'Ya existe un administrador' });
  const { name,email,password } = req.body;
  if (!name||!email||!password) return res.status(400).json({ error:'Faltan datos' });
  const id=uuid();
  await q('INSERT INTO users (id,name,email,password,role) VALUES ($1,$2,$3,$4,$5)',[id,name,email.toLowerCase(),await bcrypt.hash(password,10),'admin']);
  const user={id,name,email,role:'admin'};
  res.status(201).json({ token:sign(user),user });
  } catch(e) { console.error("❌ route error:", req.method, req.path, e.message); if (!res.headersSent) res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/stats', auth, role('admin'), async (req, res) => {
  try {
  const userStats  =await qa('SELECT role,COUNT(*) as c FROM users GROUP BY role',[]);
  const orderStats =await qa('SELECT status,COUNT(*) as c FROM orders GROUP BY status',[]);
  const revenue    =await q1("SELECT COALESCE(SUM(total),0) as total FROM orders WHERE status='delivered'",[]);
  const today      =await q1(`SELECT COUNT(*) as orders,COALESCE(SUM(total),0) as revenue FROM orders WHERE DATE(created_at)=CURRENT_DATE AND status NOT IN ('cancelled','pending')`,[]);
  const week       =await q1(`SELECT COUNT(*) as orders,COALESCE(SUM(total),0) as revenue FROM orders WHERE created_at>=NOW()-INTERVAL '7 days' AND status NOT IN ('cancelled','pending')`,[]);
  const businesses =await q1('SELECT COUNT(*) as c FROM businesses',[]);
  const pendingW   =await q1("SELECT COUNT(*) as c FROM withdrawals WHERE status='pending'",[]);
  res.json({ userStats,orderStats,revenue:parseFloat(revenue.total),today,week,businesses:parseInt(businesses.c),pendingWithdrawals:parseInt(pendingW.c) });
  } catch(e) { console.error("❌ route error:", req.method, req.path, e.message); if (!res.headersSent) res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/users', auth, role('admin'), async (req, res) => {
  try {
  const { role:r,search } = req.query;
  let sql='SELECT u.*,(SELECT COUNT(*) FROM orders WHERE customer_id=u.id) as order_count FROM users u WHERE TRUE';
  const params=[]; let i=1;
  if (r) { sql+=` AND u.role=$${i++}`;params.push(r); }
  if (search) { sql+=` AND (u.name ILIKE $${i} OR u.email ILIKE $${i++})`;params.push(`%${search}%`); }
  res.json(await qa(sql+' ORDER BY u.created_at DESC',params));
  } catch(e) { console.error("❌ route error:", req.method, req.path, e.message); if (!res.headersSent) res.status(500).json({ error: e.message }); }
});

app.patch('/api/admin/users/:id', auth, role('admin'), async (req, res) => {
  try {
  const { name,email,role:r,phone }=req.body;
  await q('UPDATE users SET name=COALESCE($1,name),email=COALESCE($2,email),role=COALESCE($3,role),phone=COALESCE($4,phone) WHERE id=$5',[name,email,r,phone,req.params.id]);
  res.json(await q1('SELECT id,name,email,role,phone,created_at FROM users WHERE id=$1',[req.params.id]));
  } catch(e) { console.error("❌ route error:", req.method, req.path, e.message); if (!res.headersSent) res.status(500).json({ error: e.message }); }
});
app.delete('/api/admin/users/:id', auth, role('admin'), async (req, res) => {
  try {
  await q("DELETE FROM users WHERE id=$1 AND role!='admin'",[req.params.id]);
  res.json({ success:true });
  } catch(e) { console.error("❌ route error:", req.method, req.path, e.message); if (!res.headersSent) res.status(500).json({ error: e.message }); }
});
app.post('/api/admin/users/:id/reset-password', auth, role('admin'), async (req, res) => {
  try {
  const { password }=req.body;
  if (!password||password.length<6) return res.status(400).json({ error:'Mínimo 6 caracteres' });
  await q('UPDATE users SET password=$1 WHERE id=$2',[await bcrypt.hash(password,10),req.params.id]);
  res.json({ success:true });
  } catch(e) { console.error("❌ route error:", req.method, req.path, e.message); if (!res.headersSent) res.status(500).json({ error: e.message }); }
});
app.get('/api/admin/businesses', auth, role('admin'), async (req, res) =>
  res.json(await qa(`SELECT b.*,u.name as owner_name,u.email as owner_email,s.status as sub_status,(SELECT COUNT(*) FROM orders WHERE business_id=b.id AND status='delivered') as completed_orders,(SELECT COALESCE(SUM(total),0) FROM orders WHERE business_id=b.id AND status='delivered') as total_revenue FROM businesses b JOIN users u ON b.owner_id=u.id LEFT JOIN subscriptions s ON s.business_id=b.id ORDER BY b.created_at DESC`,[])));
app.patch('/api/admin/businesses/:id', auth, role('admin'), async (req, res) => {
  try {
  const { name,category,address,phone,logo_emoji,delivery_cost,is_open,plan,delivery_time,city,department }=req.body;
  await q(`UPDATE businesses SET name=COALESCE($1,name),category=COALESCE($2,category),address=COALESCE($3,address),phone=COALESCE($4,phone),logo_emoji=COALESCE($5,logo_emoji),delivery_cost=COALESCE($6,delivery_cost),is_open=COALESCE($7,is_open),plan=COALESCE($8,plan),delivery_time=COALESCE($9,delivery_time),city=COALESCE($10,city),department=COALESCE($11,department) WHERE id=$12`,
    [name,category,address,phone,logo_emoji,delivery_cost,is_open!=null?Boolean(is_open):null,plan,delivery_time,city,department,req.params.id]);
  res.json(await q1('SELECT * FROM businesses WHERE id=$1',[req.params.id]));
  } catch(e) { console.error("❌ route error:", req.method, req.path, e.message); if (!res.headersSent) res.status(500).json({ error: e.message }); }
});
app.delete('/api/admin/businesses/:id', auth, role('admin'), async (req, res) => {
  try {
  await q('DELETE FROM businesses WHERE id=$1',[req.params.id]);
  res.json({ success:true });
  } catch(e) { console.error("❌ route error:", req.method, req.path, e.message); if (!res.headersSent) res.status(500).json({ error: e.message }); }
});
app.get('/api/admin/orders', auth, role('admin'), async (req, res) => {
  try {
  const { status,search }=req.query;
  let sql='SELECT o.*,u.name as customer_name,b.name as business_name FROM orders o JOIN users u ON o.customer_id=u.id JOIN businesses b ON o.business_id=b.id WHERE TRUE';
  const params=[]; let i=1;
  if (status) { sql+=` AND o.status=$${i++}`;params.push(status); }
  if (search) { sql+=` AND (u.name ILIKE $${i} OR b.name ILIKE $${i++})`;params.push(`%${search}%`); }
  const rows=await qa(sql+' ORDER BY o.created_at DESC LIMIT 200',params);
  res.json(await Promise.all(rows.map(async o=>({...o,items:await qa('SELECT * FROM order_items WHERE order_id=$1',[o.id])}))));
  } catch(e) { console.error("❌ route error:", req.method, req.path, e.message); if (!res.headersSent) res.status(500).json({ error: e.message }); }
});
app.get('/api/admin/withdrawals', auth, role('admin'), async (req, res) =>
  res.json(await qa('SELECT * FROM withdrawals ORDER BY created_at DESC',[])));
app.post('/api/admin/withdrawals/:id/approve', auth, role('admin'), async (req, res) => {
  try {
  await q("UPDATE withdrawals SET status='completed',processed_at=NOW() WHERE id=$1",[req.params.id]);
  res.json({ success:true });
  } catch(e) { console.error("❌ route error:", req.method, req.path, e.message); if (!res.headersSent) res.status(500).json({ error: e.message }); }
});
app.post('/api/admin/withdrawals/:id/reject', auth, role('admin'), async (req, res) => {
  try {
  const w=await q1('SELECT * FROM withdrawals WHERE id=$1',[req.params.id]);
  if (!w) return res.status(404).json({ error:'No encontrado' });
  await q("UPDATE withdrawals SET status='rejected',processed_at=NOW() WHERE id=$1",[req.params.id]);
  await q('UPDATE wallets SET balance=balance+$1,updated_at=NOW() WHERE id=$2',[w.amount,w.wallet_id]);
  await q('INSERT INTO transactions (id,wallet_id,type,amount,description) VALUES ($1,$2,$3,$4,$5)',[uuid(),w.wallet_id,'credit',w.amount,'Retiro rechazado — saldo devuelto']);
  res.json({ success:true });
  } catch(e) { console.error("❌ route error:", req.method, req.path, e.message); if (!res.headersSent) res.status(500).json({ error: e.message }); }
});
app.get('/api/admin/settings', auth, role('admin'), async (req, res) => {
  try {
  const rows=await qa('SELECT * FROM app_settings',[]);
  const obj={};
  rows.forEach(r=>{ try{obj[r.key]=JSON.parse(r.value);}catch{obj[r.key]=r.value;} });
  res.json(obj);
  } catch(e) { console.error("❌ route error:", req.method, req.path, e.message); if (!res.headersSent) res.status(500).json({ error: e.message }); }
});
app.post('/api/admin/settings', auth, role('admin'), async (req, res) => {
  try {
  for (const [k,v] of Object.entries(req.body))
    await q('INSERT INTO app_settings (key,value,updated_at) VALUES ($1,$2,NOW()) ON CONFLICT(key) DO UPDATE SET value=$2,updated_at=NOW()',[k,JSON.stringify(v)]);
  await loadPlanPrice(); // reload in-memory price
  res.json({ success:true });
  } catch(e) { console.error("❌ route error:", req.method, req.path, e.message); if (!res.headersSent) res.status(500).json({ error: e.message }); }
});
app.get('/api/admin/platform', auth, role('admin'), async (req, res) => {
  try {
  const wallet=await q1("SELECT * FROM wallets WHERE owner_id='platform'",[]);
  const txs=wallet?.id?await qa('SELECT * FROM transactions WHERE wallet_id=$1 ORDER BY created_at DESC LIMIT 30',[wallet.id]):[];
  res.json({ balance:parseFloat(wallet?.balance)||0,transactions:txs,fee_percent:process.env.PLATFORM_FEE_PERCENT||0 });
  } catch(e) { console.error("❌ route error:", req.method, req.path, e.message); if (!res.headersSent) res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════
//  WEBHOOK MERCADOPAGO
// ════════════════════════════════════════════════
app.post('/api/webhooks/mp', async (req, res) => {
  try {
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
  } catch(e) { console.error("❌ route error:", req.method, req.path, e.message); if (!res.headersSent) res.status(500).json({ error: e.message }); }
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

// ── Debug: show all businesses with their city/dept ──
app.get('/api/debug/businesses', async (_,res) => {
  const rows = await qa('SELECT id,name,city,department,is_active FROM businesses ORDER BY name',[]);
  res.json(rows);
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
  try {
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
  } catch(e) { console.error("❌ route error:", req.method, req.path, e.message); if (!res.headersSent) res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/coupons', auth, async (req, res) => {
  try {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Sin permisos' });
  try { res.json(await q('SELECT c.*, b.name as business_name FROM coupons c LEFT JOIN businesses b ON b.id=c.business_id ORDER BY c.created_at DESC')); }
  catch(e) { res.status(500).json({ error: e.message }); }
  } catch(e) { console.error("❌ route error:", req.method, req.path, e.message); if (!res.headersSent) res.status(500).json({ error: e.message }); }
});

app.patch('/api/admin/coupons/:id', auth, async (req, res) => {
  try {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Sin permisos' });
  try { await q('UPDATE coupons SET active=$1 WHERE id=$2', [req.body.active, req.params.id]); res.json({ ok: true }); }
  catch(e) { res.status(500).json({ error: e.message }); }
  } catch(e) { console.error("❌ route error:", req.method, req.path, e.message); if (!res.headersSent) res.status(500).json({ error: e.message }); }
});

app.delete('/api/admin/coupons/:id', auth, async (req, res) => {
  try {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Sin permisos' });
  try { await q('DELETE FROM coupons WHERE id=$1', [req.params.id]); res.json({ ok: true }); }
  catch(e) { res.status(500).json({ error: e.message }); }
  } catch(e) { console.error("❌ route error:", req.method, req.path, e.message); if (!res.headersSent) res.status(500).json({ error: e.message }); }
});

app.post('/api/owner/coupons', auth, async (req, res) => {
  try {
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
  } catch(e) { console.error("❌ route error:", req.method, req.path, e.message); if (!res.headersSent) res.status(500).json({ error: e.message }); }
});

app.get('/api/owner/coupons', auth, async (req, res) => {
  try {
  if (req.user.role !== 'owner') return res.status(403).json({ error: 'Sin permisos' });
  try {
    const biz = await q1('SELECT id FROM businesses WHERE owner_id=$1', [req.user.id]);
    if (!biz) return res.json([]);
    res.json(await q('SELECT * FROM coupons WHERE business_id=$1 ORDER BY created_at DESC', [biz.id]));
  } catch(e) { res.status(500).json({ error: e.message }); }
  } catch(e) { console.error("❌ route error:", req.method, req.path, e.message); if (!res.headersSent) res.status(500).json({ error: e.message }); }
});

app.delete('/api/owner/coupons/:id', auth, async (req, res) => {
  try {
  if (req.user.role !== 'owner') return res.status(403).json({ error: 'Sin permisos' });
  try {
    const biz = await q1('SELECT id FROM businesses WHERE owner_id=$1', [req.user.id]);
    await q('DELETE FROM coupons WHERE id=$1 AND business_id=$2', [req.params.id, biz?.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
  } catch(e) { console.error("❌ route error:", req.method, req.path, e.message); if (!res.headersSent) res.status(500).json({ error: e.message }); }
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
    // Send email notification to support
    try {
      await sendEmail('soporte@blow.uy', `Nueva consulta de soporte — ${name||email}`,
        `<p><b>De:</b> ${name||'Anónimo'} &lt;${email}&gt;</p><p><b>Mensaje:</b><br>${message.replace(/\n/g,'<br>')}</p>`);
    } catch(e) { /* email failure is non-critical */ }
    res.status(201).json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// User's own tickets
app.get('/api/help/mine', auth, async (req, res) => {
  try {
    const tickets = await qa('SELECT id,message,status,admin_reply,created_at FROM help_messages WHERE user_id=$1 ORDER BY created_at DESC LIMIT 10', [req.user.id]);
    res.json(tickets);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/help', auth, async (req, res) => {
  try {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Sin permisos' });
  try { res.json(await q('SELECT * FROM help_messages ORDER BY created_at DESC LIMIT 100')); }
  catch(e) { res.status(500).json({ error: e.message }); }
  } catch(e) { console.error("❌ route error:", req.method, req.path, e.message); if (!res.headersSent) res.status(500).json({ error: e.message }); }
});

app.patch('/api/admin/help/:id', auth, async (req, res) => {
  try {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Sin permisos' });
  try {
    const { reply } = req.body;
    const msg = await q1('SELECT * FROM help_messages WHERE id=$1', [req.params.id]);
    if (!msg) return res.status(404).json({ error: 'No encontrado' });
    await q("UPDATE help_messages SET admin_reply=$1, status='resolved' WHERE id=$2", [reply, req.params.id]);
    await sendEmail(msg.user_email, 'Respuesta de soporte — Blow', '<p>Hola <b>' + msg.user_name + '</b>, respondimos tu consulta:</p><blockquote>' + reply + '</blockquote>');
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
  } catch(e) { console.error("❌ route error:", req.method, req.path, e.message); if (!res.headersSent) res.status(500).json({ error: e.message }); }
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

// ── Main Banner Endpoints ──────────────────────────────────────
app.get('/api/main-banners', async (req,res)=>{
  try {
    const rows = await db.query("SELECT * FROM main_banners WHERE active=TRUE ORDER BY slot ASC");
    res.json(rows.rows);
  } catch(e){ res.json([]); }
});

// GET all (admin)
app.get('/api/admin/main-banners', auth, async (req,res)=>{
  try {
    if(req.user.role!=='admin') return res.status(403).json({error:'No autorizado'});
    const rows = await db.query("SELECT * FROM main_banners ORDER BY slot ASC");
    res.json(rows.rows);
  } catch(e){ res.status(500).json({error:e.message}); }
});

// PATCH (admin) - update a banner
app.patch('/api/admin/main-banners/:id', auth, async (req,res)=>{
  try {
    if(req.user.role!=='admin') return res.status(403).json({error:'No autorizado'});
    const {tag, title, subtitle, subtitle_highlight, emoji, bg_color, cta_text, active} = req.body;
    await db.query(
      "UPDATE main_banners SET tag=COALESCE($1,tag), title=COALESCE($2,title), subtitle=COALESCE($3,subtitle), subtitle_highlight=COALESCE($4,subtitle_highlight), emoji=COALESCE($5,emoji), bg_color=COALESCE($6,bg_color), cta_text=COALESCE($7,cta_text), active=COALESCE($8,active) WHERE id=$9",
      [tag||null, title||null, subtitle||null, subtitle_highlight||null, emoji||null, bg_color||null, cta_text||null, active!=null?active:null, req.params.id]
    );
    res.json({ok:true});
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.get('/api/admin/banners', auth, async (req,res)=>{
  try {
  if(req.user.role!=='admin') return res.status(403).json({error:'No autorizado'});
  const rows = await db.query("SELECT * FROM promo_banners ORDER BY sort_order ASC, created_at DESC");
  res.json(rows.rows);
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.post('/api/admin/banners', auth, async (req,res)=>{
  try {
  if(req.user.role!=='admin') return res.status(403).json({error:'No autorizado'});
  const {title,subtitle,highlight,emoji,bg_color,link,sort_order} = req.body;
  const id = 'ban_'+Date.now();
  await db.query("INSERT INTO promo_banners(id,title,subtitle,highlight,emoji,bg_color,link,sort_order) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
    [id,title||'',subtitle||'',highlight||'',emoji||'🍔',bg_color||'#FA0050',link||'',sort_order||0]);
  res.json({ok:true,id});
  } catch(e) { console.error("❌ route error:", req.method, req.path, e.message); if (!res.headersSent) res.status(500).json({ error: e.message }); }
});
app.patch('/api/admin/banners/:id', auth, async (req,res)=>{
  try {
  if(req.user.role!=='admin') return res.status(403).json({error:'No autorizado'});
  const {title,subtitle,highlight,emoji,bg_color,link,sort_order,active,image_url} = req.body;
  await db.query("UPDATE promo_banners SET title=COALESCE($1,title),subtitle=COALESCE($2,subtitle),highlight=COALESCE($3,highlight),emoji=COALESCE($4,emoji),bg_color=COALESCE($5,bg_color),link=COALESCE($6,link),sort_order=COALESCE($7,sort_order),active=COALESCE($8,active),image_url=COALESCE($9,image_url) WHERE id=$10",
    [title,subtitle,highlight,emoji,bg_color,link,sort_order,active,image_url,req.params.id]);
  res.json({ok:true});
  } catch(e) { console.error("❌ route error:", req.method, req.path, e.message); if (!res.headersSent) res.status(500).json({ error: e.message }); }
});
app.delete('/api/admin/banners/:id', auth, async (req,res)=>{
  try {
  if(req.user.role!=='admin') return res.status(403).json({error:'No autorizado'});
  await db.query("DELETE FROM promo_banners WHERE id=$1",[req.params.id]);
  res.json({ok:true});
  } catch(e) { console.error("❌ route error:", req.method, req.path, e.message); if (!res.headersSent) res.status(500).json({ error: e.message }); }
});
app.post('/api/admin/banners/:id/image', auth, uploadMiddleware('image'), async (req,res)=>{
  try {
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
  } catch(e) { console.error("❌ route error:", req.method, req.path, e.message); if (!res.headersSent) res.status(500).json({ error: e.message }); }
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
  try {
  if(req.user.role!=='admin') return res.status(403).json({error:'No autorizado'});
  const rows = await db.query(`SELECT fs.*, b.name as biz_name FROM featured_slots fs LEFT JOIN businesses b ON fs.business_id=b.id ORDER BY fs.sort_order ASC`);
  res.json(rows.rows);
  } catch(e) { console.error("❌ route error:", req.method, req.path, e.message); if (!res.headersSent) res.status(500).json({ error: e.message }); }
});
app.post('/api/admin/featured', auth, async (req,res)=>{
  try {
  if(req.user.role!=='admin') return res.status(403).json({error:'No autorizado'});
  const {business_id,custom_title,sort_order} = req.body;
  const id = 'feat_'+Date.now();
  await db.query("INSERT INTO featured_slots(id,business_id,custom_title,sort_order) VALUES($1,$2,$3,$4)",[id,business_id,custom_title||'',sort_order||0]);
  res.json({ok:true,id});
  } catch(e) { console.error("❌ route error:", req.method, req.path, e.message); if (!res.headersSent) res.status(500).json({ error: e.message }); }
});
app.post('/api/admin/featured/:id/image', auth, uploadMiddleware('image'), async (req,res)=>{
  try {
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
  } catch(e) { console.error("❌ route error:", req.method, req.path, e.message); if (!res.headersSent) res.status(500).json({ error: e.message }); }
});
app.patch('/api/admin/featured/:id', auth, async (req,res)=>{
  try {
  if(req.user.role!=='admin') return res.status(403).json({error:'No autorizado'});
  const {active,sort_order,custom_title} = req.body;
  await db.query("UPDATE featured_slots SET active=COALESCE($1,active),sort_order=COALESCE($2,sort_order),custom_title=COALESCE($3,custom_title) WHERE id=$4",[active,sort_order,custom_title,req.params.id]);
  res.json({ok:true});
  } catch(e) { console.error("❌ route error:", req.method, req.path, e.message); if (!res.headersSent) res.status(500).json({ error: e.message }); }
});
app.delete('/api/admin/featured/:id', auth, async (req,res)=>{
  try {
  if(req.user.role!=='admin') return res.status(403).json({error:'No autorizado'});
  await db.query("DELETE FROM featured_slots WHERE id=$1",[req.params.id]);
  res.json({ok:true});
  } catch(e) { console.error("❌ route error:", req.method, req.path, e.message); if (!res.headersSent) res.status(500).json({ error: e.message }); }
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
  try {
  if(req.user.role!=='admin') return res.status(403).json({error:'No autorizado'});
  const {title, subtitle} = req.body;
  await db.query("INSERT INTO app_config(key,value) VALUES('blowplus_banner',$1) ON CONFLICT(key) DO UPDATE SET value=$1",
    [JSON.stringify({title, subtitle})]);
  res.json({ok:true});
  } catch(e) { console.error("❌ route error:", req.method, req.path, e.message); if (!res.headersSent) res.status(500).json({ error: e.message }); }
});


// ── TOP CUSTOMERS (admin: all app, owner: their business) ──
app.get('/api/admin/top-customers', auth, async (req,res)=>{
  try {
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
  } catch(e) { console.error("❌ route error:", req.method, req.path, e.message); if (!res.headersSent) res.status(500).json({ error: e.message }); }
});

app.get('/api/owner/stats/history', auth, async (req,res)=>{
  try {
  if(req.user.role!=='owner') return res.status(403).json({error:'No autorizado'});
  try {
    const biz = await q1('SELECT id FROM businesses WHERE owner_id=$1',[req.user.id]);
    if(!biz) return res.json({});
    const days = parseInt(req.query.days)||30;
    const interval = days + ' days';

    const daily = await db.query(`
      SELECT DATE(created_at AT TIME ZONE 'America/Montevideo') as day,
             COUNT(*) as orders,
             COALESCE(SUM(total),0) as revenue
      FROM orders
      WHERE business_id=$1
        AND created_at >= NOW() - INTERVAL '` + interval + `'
        AND status NOT IN ('cancelled','pending')
      GROUP BY day ORDER BY day ASC
    `,[biz.id]);

    const summary = await q1(`
      SELECT COUNT(*) as orders,
             COALESCE(SUM(total),0) as revenue,
             COUNT(DISTINCT customer_id) as unique_customers,
             COALESCE(AVG(total),0) as avg_ticket
      FROM orders
      WHERE business_id=$1
        AND created_at >= NOW() - INTERVAL '` + interval + `'
        AND status NOT IN ('cancelled','pending')
    `,[biz.id]);

    const topProducts = await db.query(`
      SELECT oi.name as name,
             SUM(oi.quantity) as qty,
             SUM(oi.price * oi.quantity) as revenue
      FROM order_items oi
      JOIN orders o ON oi.order_id = o.id
      WHERE o.business_id=$1
        AND o.created_at >= NOW() - INTERVAL '` + interval + `'
        AND o.status NOT IN ('cancelled','pending')
      GROUP BY oi.name ORDER BY qty DESC LIMIT 5
    `,[biz.id]);

    const topCustomers = await db.query(`
      SELECT u.name, COUNT(o.id) as orders, SUM(o.total) as spent
      FROM orders o JOIN users u ON o.customer_id=u.id
      WHERE o.business_id=$1
        AND o.created_at >= NOW() - INTERVAL '` + interval + `'
        AND o.status NOT IN ('cancelled','pending')
      GROUP BY u.id, u.name ORDER BY spent DESC LIMIT 5
    `,[biz.id]);

    res.json({ daily: daily.rows, summary, topProducts: topProducts.rows, topCustomers: topCustomers.rows });
  } catch(e){ res.status(500).json({error:e.message}); }
  } catch(e) { console.error("❌ route error:", req.method, req.path, e.message); if (!res.headersSent) res.status(500).json({ error: e.message }); }
});

// ── Advanced analytics ────────────────────────
app.get('/api/owner/analytics', auth, role('owner'), async (req, res) => {
  try {
    const biz = await q1('SELECT id FROM businesses WHERE owner_id=$1', [req.user.id]);
    if (!biz) return res.status(404).json({ error: 'Negocio no encontrado' });
    const days = Math.min(parseInt(req.query.days) || 30, 365);
    const interval = days + ' days';
    const bizId = biz.id;

    const [peakHours, retention, cancelReasons, productAbandon, revenueByDay, clv] = await Promise.all([
      // Peak hours heatmap
      db.query(`
        SELECT EXTRACT(hour FROM created_at AT TIME ZONE 'America/Montevideo') as hour,
               EXTRACT(dow FROM created_at AT TIME ZONE 'America/Montevideo') as dow,
               COUNT(*) as orders
        FROM orders WHERE business_id=$1 AND status='delivered'
          AND created_at >= NOW() - INTERVAL '${interval}'
        GROUP BY hour, dow ORDER BY hour, dow
      `, [bizId]),

      // Weekly retention: customers who ordered in week N and returned in week N+1
      db.query(`
        WITH weekly AS (
          SELECT customer_id,
                 DATE_TRUNC('week', created_at AT TIME ZONE 'America/Montevideo') as week
          FROM orders WHERE business_id=$1 AND status='delivered'
          GROUP BY customer_id, week
        )
        SELECT w1.week, COUNT(DISTINCT w2.customer_id) as retained, COUNT(DISTINCT w1.customer_id) as total
        FROM weekly w1
        LEFT JOIN weekly w2 ON w1.customer_id=w2.customer_id AND w2.week=w1.week + INTERVAL '1 week'
        WHERE w1.week >= NOW() - INTERVAL '${interval}'
        GROUP BY w1.week ORDER BY w1.week DESC LIMIT 8
      `, [bizId]),

      // Cancellation rate and timing
      db.query(`
        SELECT
          COUNT(*) FILTER (WHERE status='cancelled') as cancelled,
          COUNT(*) FILTER (WHERE status='delivered') as delivered,
          AVG(EXTRACT(epoch FROM (updated_at - created_at))/60) FILTER (WHERE status='cancelled') as avg_cancel_min
        FROM orders WHERE business_id=$1 AND created_at >= NOW() - INTERVAL '${interval}'
      `, [bizId]),

      // Top products with low conversion (viewed but not in completed orders)
      db.query(`
        SELECT oi.name, COUNT(DISTINCT o.id) as in_orders,
               COALESCE(SUM(oi.quantity),0) as units_sold,
               COALESCE(SUM(oi.price * oi.quantity),0) as revenue
        FROM order_items oi
        JOIN orders o ON o.id=oi.order_id
        WHERE o.business_id=$1 AND o.status='delivered'
          AND o.created_at >= NOW() - INTERVAL '${interval}'
        GROUP BY oi.name ORDER BY revenue DESC LIMIT 10
      `, [bizId]),

      // Revenue 30-day trend with moving average
      db.query(`
        SELECT DATE(created_at AT TIME ZONE 'America/Montevideo') as day,
               COALESCE(SUM(total),0) as revenue,
               COUNT(*) as orders,
               AVG(total) as avg_ticket
        FROM orders WHERE business_id=$1 AND status='delivered'
          AND created_at >= NOW() - INTERVAL '${interval}'
        GROUP BY day ORDER BY day ASC
      `, [bizId]),

      // Customer lifetime value segments
      db.query(`
        SELECT
          CASE
            WHEN total_orders=1 THEN 'nuevo'
            WHEN total_orders<=3 THEN 'casual'
            WHEN total_orders<=10 THEN 'regular'
            ELSE 'vip'
          END as segment,
          COUNT(*) as customers,
          AVG(total_spent) as avg_spent,
          AVG(total_orders) as avg_orders
        FROM (
          SELECT customer_id, COUNT(*) as total_orders, SUM(total) as total_spent
          FROM orders WHERE business_id=$1 AND status='delivered'
          GROUP BY customer_id
        ) sub GROUP BY segment
      `, [bizId]),
    ]);

    res.json({
      peak_hours: peakHours.rows,
      retention: retention.rows,
      cancellations: cancelReasons.rows[0],
      top_products: productAbandon.rows,
      revenue_trend: revenueByDay.rows,
      customer_segments: clv.rows,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/owner/top-customers', auth, async (req,res)=>{
  try {
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
  } catch(e) { console.error("❌ route error:", req.method, req.path, e.message); if (!res.headersSent) res.status(500).json({ error: e.message }); }
});

// ── ASSIGN COUPON TO USER ──
app.post('/api/admin/coupons/:id/assign', auth, async (req,res)=>{
  try {
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
  } catch(e) { console.error("❌ route error:", req.method, req.path, e.message); if (!res.headersSent) res.status(500).json({ error: e.message }); }
});

app.post('/api/owner/coupons/:id/assign', auth, async (req,res)=>{
  try {
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
  } catch(e) { console.error("❌ route error:", req.method, req.path, e.message); if (!res.headersSent) res.status(500).json({ error: e.message }); }
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
  try {
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
  } catch(e) { console.error("❌ route error:", req.method, req.path, e.message); if (!res.headersSent) res.status(500).json({ error: e.message }); }
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
  try {
  await loadPlanPrice(); // always fresh from DB
  res.json({ price: PLAN_PRICE });
  } catch(e) { console.error("❌ route error:", req.method, req.path, e.message); if (!res.headersSent) res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════
//  SEO LANDING PAGES
// ═══════════════════════════════════════════════
function seoPage({ title, description, url, image, bodyContent }) {
  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <meta name="description" content="${description}">
  <meta property="og:title" content="${title}">
  <meta property="og:description" content="${description}">
  <meta property="og:url" content="${APP_URL}${url}">
  <meta property="og:type" content="website">
  <meta property="og:image" content="${image || APP_URL + '/icons/icon-512.png'}">
  <meta name="twitter:card" content="summary_large_image">
  <link rel="canonical" href="${APP_URL}${url}">
  <script type="application/ld+json">${JSON.stringify({
    "@context": "https://schema.org",
    "@type": "WebPage",
    "name": title,
    "description": description,
    "url": APP_URL + url,
  })}</script>
  <style>
    *{margin:0;padding:0;box-sizing:border-box;}
    body{font-family:'Inter',system-ui,sans-serif;color:#1a1a1a;background:#fff;}
    .hero{background:linear-gradient(135deg,#FA0050,#c0003c);color:#fff;padding:60px 20px;text-align:center;}
    .hero h1{font-size:clamp(24px,5vw,42px);font-weight:900;line-height:1.2;margin-bottom:12px;}
    .hero p{font-size:16px;opacity:.85;max-width:500px;margin:0 auto 24px;}
    .cta{display:inline-block;background:#fff;color:#FA0050;border-radius:16px;padding:16px 32px;font-size:16px;font-weight:900;text-decoration:none;transition:transform .2s;}
    .cta:hover{transform:scale(1.03);}
    .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:20px;max-width:1000px;margin:40px auto;padding:0 20px;}
    .card{border:1px solid #f0f0f0;border-radius:20px;padding:20px;text-decoration:none;color:inherit;transition:box-shadow .2s;}
    .card:hover{box-shadow:0 4px 24px rgba(0,0,0,.1);}
    .card-emoji{font-size:40px;margin-bottom:12px;}
    .card-name{font-size:18px;font-weight:800;margin-bottom:4px;}
    .card-meta{font-size:13px;color:#888;}
    .footer{text-align:center;padding:40px 20px;color:#aaa;font-size:13px;}
    .footer a{color:#FA0050;text-decoration:none;}
    h2{font-size:22px;font-weight:800;text-align:center;padding:40px 20px 0;}
  </style>
</head>
<body>
  ${bodyContent}
  <footer class="footer">
    <p>© ${new Date().getFullYear()} <a href="${APP_URL}">Blow</a> · Delivery en Uruguay · <a href="${APP_URL}">Abrir app</a></p>
  </footer>
  <script>
    // Redirect to SPA with deep link params
    const path = window.location.pathname;
    const storeMatch = path.match(/\/negocio\/([^/]+)/);
    const cityMatch  = path.match(/\/delivery\/([^/]+)/);
    const catMatch   = path.match(/\/categoria\/([^/]+)/);
    if (storeMatch) window.location.replace('/?store=' + storeMatch[1]);
    else if (cityMatch) window.location.replace('/?city=' + cityMatch[1]);
    else if (catMatch) window.location.replace('/?category=' + catMatch[1]);
  </script>
</body>
</html>`;
}

// City landing pages: /delivery/montevideo, /delivery/maldonado, etc.
app.get('/delivery/:city', async (req, res) => {
  try {
  const city = decodeURIComponent(req.params.city).replace(/-/g,' ');
  const cityTitle = city.charAt(0).toUpperCase() + city.slice(1);
  try {
    const businesses = await qa(`
      SELECT id, name, category, logo_emoji, logo_url, rating, delivery_time, delivery_cost
      FROM businesses WHERE LOWER(city)=LOWER($1) AND plan IS NOT NULL AND is_open=TRUE
      ORDER BY COALESCE(rating,0) DESC LIMIT 20
    `, [city]);
    const cards = businesses.map(b => `
      <a class="card" href="${APP_URL}/?store=${b.id}">
        <div class="card-emoji">${b.logo_emoji || '🏪'}</div>
        <div class="card-name">${b.name}</div>
        <div class="card-meta">${b.rating ? `⭐ ${parseFloat(b.rating).toFixed(1)} · ` : ''}${b.delivery_time || '30'} min · $${b.delivery_cost || 0} envío</div>
      </a>`).join('');
    res.send(seoPage({
      title: `Delivery en ${cityTitle} — Blow`,
      description: `Pedidos a domicilio en ${cityTitle}. ${businesses.length} negocios disponibles. Comida, mercados, farmacias y más.`,
      url: `/delivery/${req.params.city}`,
      bodyContent: `
        <div class="hero">
          <h1>Delivery en ${cityTitle}</h1>
          <p>${businesses.length} negocios disponibles ahora mismo</p>
          <a class="cta" href="${APP_URL}/">Ver todos en la app →</a>
        </div>
        <h2>Negocios abiertos en ${cityTitle}</h2>
        <div class="grid">${cards || '<p style="text-align:center;color:#aaa;padding:20px;">Todavía no hay negocios registrados en esta ciudad.</p>'}</div>`,
    }));
  } catch(e) { res.redirect('/'); }
  } catch(e) { console.error("❌ route error:", req.method, req.path, e.message); if (!res.headersSent) res.status(500).json({ error: e.message }); }
});

// Category landing pages: /categoria/restaurantes, /categoria/farmacias
app.get('/categoria/:cat', async (req, res) => {
  try {
  const catMap = { restaurantes:'food', mercados:'market', farmacias:'pharmacy', bebidas:'drinks', postres:'desserts', cafes:'cafe' };
  const cat = catMap[req.params.cat] || req.params.cat;
  const catTitle = req.params.cat.charAt(0).toUpperCase() + req.params.cat.slice(1);
  try {
    const businesses = await qa(`
      SELECT id, name, category, logo_emoji, rating, delivery_time, delivery_cost, city
      FROM businesses WHERE category=$1 AND plan IS NOT NULL
      ORDER BY COALESCE(rating,0) DESC LIMIT 30
    `, [cat]);
    const cards = businesses.map(b => `
      <a class="card" href="${APP_URL}/?store=${b.id}">
        <div class="card-emoji">${b.logo_emoji || '🏪'}</div>
        <div class="card-name">${b.name}</div>
        <div class="card-meta">${b.city ? `📍 ${b.city} · ` : ''}${b.rating ? `⭐ ${parseFloat(b.rating).toFixed(1)} · ` : ''}${b.delivery_time || '30'} min</div>
      </a>`).join('');
    res.send(seoPage({
      title: `${catTitle} con delivery — Blow Uruguay`,
      description: `Los mejores ${catTitle} con delivery a domicilio en Uruguay. Pedí online y recibí en tu casa.`,
      url: `/categoria/${req.params.cat}`,
      bodyContent: `
        <div class="hero">
          <h1>${catTitle} con delivery</h1>
          <p>Los mejores ${catTitle} de Uruguay en un solo lugar</p>
          <a class="cta" href="${APP_URL}/">Ver en la app →</a>
        </div>
        <h2>${businesses.length} opciones disponibles</h2>
        <div class="grid">${cards}</div>`,
    }));
  } catch(e) { res.redirect('/'); }
  } catch(e) { console.error("❌ route error:", req.method, req.path, e.message); if (!res.headersSent) res.status(500).json({ error: e.message }); }
});

// Business profile page: /negocio/slug-del-nombre
app.get('/negocio/:id', async (req, res) => {
  try {
    const biz = await q1('SELECT * FROM businesses WHERE id=$1', [req.params.id]);
    if (!biz) return res.redirect('/');
    const products = await qa('SELECT * FROM products WHERE business_id=$1 AND is_available=TRUE ORDER BY is_featured DESC LIMIT 20', [biz.id]);
    const prodHTML = products.map(p => `
      <div style="display:flex;justify-content:space-between;align-items:center;padding:12px 0;border-bottom:1px solid #f5f5f5;">
        <div>
          <div style="font-size:14px;font-weight:700;">${p.emoji||''} ${p.name}</div>
          ${p.description ? `<div style="font-size:12px;color:#888;margin-top:2px;">${p.description}</div>` : ''}
        </div>
        <div style="font-size:15px;font-weight:900;color:#FA0050;margin-left:12px;">$${p.price}</div>
      </div>`).join('');
    res.send(seoPage({
      title: `${biz.name} — Delivery online | Blow`,
      description: `Pedí de ${biz.name} en Blow. Delivery a domicilio${biz.city ? ` en ${biz.city}` : ''}, ${biz.delivery_time || '30-45'} minutos.`,
      url: `/negocio/${biz.id}`,
      image: biz.cover_url || biz.logo_url,
      bodyContent: `
        <div class="hero">
          <h1>${biz.logo_emoji || '🏪'} ${biz.name}</h1>
          <p>${biz.city ? `📍 ${biz.city}` : ''} ${biz.rating ? `⭐ ${parseFloat(biz.rating).toFixed(1)}` : ''} · ${biz.delivery_time || '30-45'} min</p>
          <a class="cta" href="${APP_URL}/?store=${biz.id}">Pedir ahora →</a>
        </div>
        <div style="max-width:600px;margin:0 auto;padding:20px;">
          <h2 style="text-align:left;padding:20px 0 16px;">Menú</h2>
          ${prodHTML}
        </div>`,
    }));
  } catch(e) { res.redirect('/'); }
});

// Sitemap.xml
app.get('/sitemap.xml', async (req, res) => {
  try {
    const [businesses, cities] = await Promise.all([
      qa('SELECT id, updated_at FROM businesses WHERE plan IS NOT NULL LIMIT 500', []),
      qa("SELECT DISTINCT LOWER(city) as city FROM businesses WHERE city != '' AND plan IS NOT NULL", []),
    ]);
    const cats = ['restaurantes','mercados','farmacias','bebidas','postres'];
    const urls = [
      `<url><loc>${APP_URL}/</loc><changefreq>daily</changefreq><priority>1.0</priority></url>`,
      ...cats.map(c => `<url><loc>${APP_URL}/categoria/${c}</loc><changefreq>weekly</changefreq><priority>0.8</priority></url>`),
      ...cities.map(r => `<url><loc>${APP_URL}/delivery/${encodeURIComponent(r.city)}</loc><changefreq>daily</changefreq><priority>0.7</priority></url>`),
      ...businesses.map(b => `<url><loc>${APP_URL}/negocio/${b.id}</loc><lastmod>${(b.updated_at||new Date()).toISOString().split('T')[0]}</lastmod><changefreq>weekly</changefreq><priority>0.6</priority></url>`),
    ];
    res.set('Content-Type', 'application/xml');
    res.send(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.join('')}</urlset>`);
  } catch(e) { res.status(500).send('Error generating sitemap'); }
});

// robots.txt
app.get('/robots.txt', (req, res) => {
  res.type('text/plain');
  res.send(`User-agent: *\nAllow: /\nAllow: /delivery/\nAllow: /categoria/\nAllow: /negocio/\nDisallow: /api/\nDisallow: /blow-admin-panel\nSitemap: ${APP_URL}/sitemap.xml\n`);
});

app.get('*',(_,res)=>res.sendFile(path.join(__dirname,'public','index.html')));

// ── Start ─────────────────────────────────────
initDB().then(async ()=>{
  await initVapid();
  
// ── Global error handler ─────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('❌ Unhandled error:', err.message, '| route:', req.method, req.path);
  if (res.headersSent) return next(err);
  res.status(err.status || 500).json({ error: err.message || 'Error interno del servidor' });
});

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


