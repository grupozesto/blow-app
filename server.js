// ════════════════════════════════════════════════
//  Blow — Backend v3.0
//  Node.js + Express + PostgreSQL + Cloudinary + MercadoPago + WebSockets
// ════════════════════════════════════════════════
require('dotenv').config();
const IS_PROD = process.env.NODE_ENV === 'production';
// ── Conditional logging — suppress verbose logs in production ──
const _origLog = console.log;
const _origWarn = console.warn;
if (IS_PROD) {
  console.log = (...args) => {
    // In production, only log startup messages and critical info
    const msg = args[0]?.toString?.() || '';
    if (msg.includes('✅') || msg.includes('❌') || msg.includes('⚡')) _origLog(...args);
  };
  // Keep warn and error always active in production
}
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
if (IS_PROD && JWT_SECRET === 'dev_secret_cambiar_en_prod') {
  console.error('❌ FATAL: JWT_SECRET no está configurado en producción. Configuralo en Railway.');
  process.exit(1);
}
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
    get price() { return PLAN_PRICE; }, // Dynamic — reflects loadPlanPrice() updates
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
const clients = new Map(); // userId → Set of ws connections (multi-device)
wss.on('connection', ws => {
  ws.isAlive = true;
  ws._msgCount = 0;
  ws._msgReset = Date.now();
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', msg => {
    // Rate limit: máx 5 mensajes por minuto por conexión
    const now = Date.now();
    if (now - ws._msgReset > 60000) { ws._msgCount = 0; ws._msgReset = now; }
    ws._msgCount++;
    if (ws._msgCount > 5) { ws.close(4002, 'Rate limit'); return; }
    try {
      const { token } = JSON.parse(msg);
      const u = jwt.verify(token, JWT_SECRET);
      // Re-validate password_changed_at on every WS message
      if (u.iat) {
        q1('SELECT password_changed_at FROM users WHERE id=$1', [u.id]).then(row => {
          if (row?.password_changed_at) {
            const changedAt = Math.floor(new Date(row.password_changed_at).getTime() / 1000);
            if (u.iat < changedAt) { ws.close(4001, 'Token invalidated'); return; }
          }
          if (!clients.has(u.id)) clients.set(u.id, new Set());
          clients.get(u.id).add(ws);
          ws.userId = u.id;
        }).catch(() => {});
      } else {
        if (!clients.has(u.id)) clients.set(u.id, new Set());
        clients.get(u.id).add(ws);
        ws.userId = u.id;
      }
    } catch { ws.close(4000, 'Invalid token'); }
  });
  ws.on('close', () => {
    if (ws.userId && clients.has(ws.userId)) {
      clients.get(ws.userId).delete(ws);
      if (clients.get(ws.userId).size === 0) clients.delete(ws.userId);
    }
  });
});
// Ping clients every 30s, terminate dead connections
const wsHeartbeat = setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.isAlive) {
      if (ws.userId && clients.has(ws.userId)) {
        clients.get(ws.userId).delete(ws);
        if (clients.get(ws.userId).size === 0) clients.delete(ws.userId);
      }
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);
function notify(userId, payload) {
  const wsSet = clients.get(userId);
  if (wsSet) {
    const msg = JSON.stringify(payload);
    for (const ws of wsSet) {
      if (ws.readyState === 1) ws.send(msg);
    }
  }
  // Always send push for order events (owner may have tab closed)
  // Map internal payload to push-friendly format
  const pushTypes = ['new_order','status_change','order_cancelled','order_update','chat_message','subscription_cancelled','account_banned'];
  if (pushTypes.includes(payload.type)) {
    const pushPayload = buildPushPayload(payload);
    // Fire-and-forget, don't await
    sendPushToOwner(userId, pushPayload).catch(() => {});
  }
}

function buildPushPayload(payload) {
  const icons = { new_order:'🔔', status_change:'📦', order_cancelled:'❌', order_update:'📦', chat_message:'💬', subscription_cancelled:'📋', account_banned:'⛔' };
  const icon = icons[payload.type] || '🔔';
  let title = 'Blow';
  let body  = payload.message || '';
  let url   = '/';
  if (payload.type === 'new_order') {
    title = '🔔 Nuevo pedido';
    body  = payload.message || `Pedido #${(payload.order_id||'').slice(-6).toUpperCase()} — $${payload.total||0}`;
    url   = '/business';
  } else if (payload.type === 'status_change' || payload.type === 'order_update') {
    title = '📦 Tu pedido';
    body  = payload.message || `Estado actualizado: ${payload.status||''}`;
    url   = payload.order_id ? `/?order=${payload.order_id}` : '/';
  } else if (payload.type === 'order_cancelled') {
    title = '❌ Pedido cancelado';
    body  = payload.message || 'Un pedido fue cancelado';
    url   = '/business';
  } else if (payload.type === 'chat_message') {
    title = '💬 Nuevo mensaje';
    body  = payload.body || 'Tenés un mensaje nuevo';
    url   = payload.order_id ? (payload.sender_role === 'customer' ? '/business' : `/?order=${payload.order_id}`) : '/';
  } else if (payload.type === 'subscription_cancelled') {
    title = '📋 Suscripción cancelada';
    body  = payload.message || 'Tu suscripción fue cancelada';
    url   = '/business';
  } else if (payload.type === 'account_banned') {
    title = '⛔ Cuenta suspendida';
    body  = payload.message || 'Tu cuenta fue suspendida';
  }
  return { title, body, url, tag: payload.type + (payload.order_id ? '-' + payload.order_id.slice(-6) : ''), icon: '/icons/icon-192.png', badge: '/icons/icon-72.png' };
}

// ── PostgreSQL ─────────────────────────────────
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: (process.env.DATABASE_URL || '').includes('railway') || process.env.DB_SSL === 'true'
    ? { rejectUnauthorized: false } : false,
  max: 25,                    // max connections (default was 10)
  idleTimeoutMillis: 30000,   // close idle connections after 30s
  connectionTimeoutMillis: 5000, // fail fast if can't connect in 5s
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
    CREATE TABLE IF NOT EXISTS bank_accounts (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      label TEXT NOT NULL,
      method TEXT NOT NULL,
      destination TEXT NOT NULL,
      is_default BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW()
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
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS tip REAL DEFAULT 0;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS priority BOOLEAN DEFAULT FALSE;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS priority_fee REAL DEFAULT 0;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_method TEXT DEFAULT 'mercadopago';
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS notes TEXT DEFAULT '';
    ALTER TABLE businesses ADD COLUMN IF NOT EXISTS cover_url TEXT DEFAULT NULL;
    ALTER TABLE businesses ADD COLUMN IF NOT EXISTS logo_url TEXT DEFAULT NULL;
    ALTER TABLE businesses ADD COLUMN IF NOT EXISTS description TEXT DEFAULT '';
    ALTER TABLE businesses ADD COLUMN IF NOT EXISTS tags TEXT DEFAULT '[]';
    ALTER TABLE products ADD COLUMN IF NOT EXISTS photo_url TEXT DEFAULT NULL;
    ALTER TABLE products ADD COLUMN IF NOT EXISTS is_featured BOOLEAN DEFAULT FALSE;
    ALTER TABLE products ADD COLUMN IF NOT EXISTS preparation_time INTEGER DEFAULT NULL;
    ALTER TABLE products ADD COLUMN IF NOT EXISTS calories INTEGER DEFAULT NULL;
    ALTER TABLE products ADD COLUMN IF NOT EXISTS allergens TEXT DEFAULT '';
    ALTER TABLE products ADD COLUMN IF NOT EXISTS stock INTEGER DEFAULT NULL;
    ALTER TABLE products ADD COLUMN IF NOT EXISTS available_from TIME DEFAULT NULL;
    ALTER TABLE products ADD COLUMN IF NOT EXISTS available_until TIME DEFAULT NULL;
    ALTER TABLE products ADD COLUMN IF NOT EXISTS ingredients TEXT DEFAULT '';
    ALTER TABLE product_variants ADD COLUMN IF NOT EXISTS is_required BOOLEAN DEFAULT FALSE;
    ALTER TABLE product_variants ADD COLUMN IF NOT EXISTS is_multi BOOLEAN DEFAULT FALSE;
    ALTER TABLE product_variants ADD COLUMN IF NOT EXISTS max_selections INTEGER DEFAULT 1;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ DEFAULT NULL;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS platform_fee REAL DEFAULT 0;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS mp_payment_id TEXT DEFAULT NULL;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS mp_status TEXT DEFAULT NULL;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS internal_notes TEXT DEFAULT '';
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS cancel_reason TEXT DEFAULT '';
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS estimated_ready_at TIMESTAMPTZ DEFAULT NULL;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS scheduled_for TIMESTAMPTZ DEFAULT NULL;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS password_changed_at TIMESTAMPTZ DEFAULT NULL;
    ALTER TABLE businesses ADD COLUMN IF NOT EXISTS blow_plus BOOLEAN DEFAULT FALSE;
    ALTER TABLE businesses ADD COLUMN IF NOT EXISTS blow_plus_since TIMESTAMPTZ DEFAULT NULL;
    ALTER TABLE businesses ADD COLUMN IF NOT EXISTS blow_plus_expires TIMESTAMPTZ DEFAULT NULL;
    ALTER TABLE businesses ADD COLUMN IF NOT EXISTS offers_priority BOOLEAN DEFAULT TRUE;
    ALTER TABLE businesses ADD COLUMN IF NOT EXISTS priority_percent INTEGER DEFAULT 50;
    ALTER TABLE businesses ADD COLUMN IF NOT EXISTS blow_plus_mp_id TEXT DEFAULT NULL;
    ALTER TABLE businesses ADD COLUMN IF NOT EXISTS blow_plus_free_delivery BOOLEAN DEFAULT FALSE;
    ALTER TABLE businesses ADD COLUMN IF NOT EXISTS schedule JSONB DEFAULT NULL;
    ALTER TABLE businesses ADD COLUMN IF NOT EXISTS rating_count INTEGER DEFAULT 0;
    CREATE TABLE IF NOT EXISTS order_messages (
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      sender_id TEXT NOT NULL REFERENCES users(id),
      sender_role TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      seen BOOLEAN DEFAULT FALSE
    );
    CREATE INDEX IF NOT EXISTS idx_order_messages_order ON order_messages(order_id);
    CREATE TABLE IF NOT EXISTS reviews (
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
      customer_id TEXT NOT NULL REFERENCES users(id),
      rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
      comment TEXT DEFAULT '',
      owner_reply TEXT DEFAULT NULL,
      owner_replied_at TIMESTAMPTZ DEFAULT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(order_id)
    );
    CREATE INDEX IF NOT EXISTS idx_reviews_business ON reviews(business_id);
    CREATE INDEX IF NOT EXISTS idx_orders_customer   ON orders(customer_id);
    CREATE INDEX IF NOT EXISTS idx_orders_business   ON orders(business_id);
    CREATE INDEX IF NOT EXISTS idx_orders_status     ON orders(status);
    CREATE INDEX IF NOT EXISTS idx_orders_created    ON orders(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_orders_mp_payment ON orders(mp_payment_id) WHERE mp_payment_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_products_business ON products(business_id);
    CREATE INDEX IF NOT EXISTS idx_products_avail    ON products(business_id, is_available);
    CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);
    CREATE INDEX IF NOT EXISTS idx_businesses_city   ON businesses(city);
    CREATE INDEX IF NOT EXISTS idx_subs_status       ON subscriptions(status);
    CREATE INDEX IF NOT EXISTS idx_wallets_owner     ON wallets(owner_id);
    CREATE INDEX IF NOT EXISTS idx_subs_period_end   ON subscriptions(current_period_end) WHERE status='active';
    CREATE INDEX IF NOT EXISTS idx_orders_pending_created ON orders(created_at) WHERE status IN ('pending','paid');
    CREATE INDEX IF NOT EXISTS idx_push_subs_user    ON push_subscriptions(user_id);
    CREATE TABLE IF NOT EXISTS app_config (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS audit_log (
      id TEXT PRIMARY KEY,
      admin_id TEXT NOT NULL,
      action TEXT NOT NULL,
      target_id TEXT,
      details JSONB,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS processed_webhooks (
      id TEXT PRIMARY KEY,
      processed_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_processed_webhooks_ts ON processed_webhooks(processed_at);
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
    CREATE UNIQUE INDEX IF NOT EXISTS idx_coupon_uses_unique ON coupon_uses(coupon_id, user_id) WHERE (SELECT per_user FROM coupons WHERE id=coupon_id LIMIT 1) <= 1;
    ALTER TABLE coupon_uses ADD COLUMN IF NOT EXISTS use_count INTEGER DEFAULT 1;

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
    CREATE TABLE IF NOT EXISTS support_chat (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      sender_role TEXT NOT NULL DEFAULT 'customer',
      body TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    ALTER TABLE promotions ADD COLUMN IF NOT EXISTS blow_plus_only BOOLEAN DEFAULT FALSE;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS phone TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS banned BOOLEAN DEFAULT FALSE;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS ban_reason TEXT;

    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      endpoint TEXT NOT NULL,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(user_id, endpoint)
    );

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
      banner_type TEXT DEFAULT 'promo',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    ALTER TABLE promo_banners ADD COLUMN IF NOT EXISTS highlight_label TEXT DEFAULT '';
    ALTER TABLE promo_banners ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();
    ALTER TABLE promo_banners ADD COLUMN IF NOT EXISTS banner_type TEXT DEFAULT 'promo';
    CREATE TABLE IF NOT EXISTS favorites (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      product_id TEXT NOT NULL,
      business_id TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(user_id, product_id)
    );
    CREATE INDEX IF NOT EXISTS idx_favorites_user ON favorites(user_id);

    CREATE TABLE IF NOT EXISTS business_subcategories (
      id TEXT PRIMARY KEY,
      category_id TEXT NOT NULL,
      name TEXT NOT NULL,
      emoji TEXT DEFAULT '🍽️',
      image_url TEXT DEFAULT NULL,
      sort_order INTEGER DEFAULT 0,
      is_active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_business_subcategories_cat ON business_subcategories(category_id);

    CREATE TABLE IF NOT EXISTS category_banners (
      id TEXT PRIMARY KEY,
      category_id TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      subtitle TEXT DEFAULT '',
      image_url TEXT DEFAULT '',
      bg_color TEXT DEFAULT '#FA0050',
      link_business_id TEXT DEFAULT NULL,
      sort_order INTEGER DEFAULT 0,
      active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_category_banners_cat ON category_banners(category_id);

    CREATE TABLE IF NOT EXISTS category_featured (
      id TEXT PRIMARY KEY,
      category_id TEXT NOT NULL,
      business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
      custom_title TEXT DEFAULT NULL,
      custom_image TEXT DEFAULT NULL,
      sort_order INTEGER DEFAULT 0,
      active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_category_featured_cat ON category_featured(category_id);
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
  // Seed default subcategories if none exist
  const subCount = await q1('SELECT COUNT(*) as c FROM business_subcategories',[]);
  if (parseInt(subCount.c) === 0) {
    const defaultSubs = [
      {cat:'food',name:'Hamburguesas',emoji:'🍔'},{cat:'food',name:'Pizzas',emoji:'🍕'},{cat:'food',name:'Empanadas',emoji:'🥟'},
      {cat:'food',name:'Sándwiches',emoji:'🥪'},{cat:'food',name:'Sushi',emoji:'🍣'},{cat:'food',name:'Pastas',emoji:'🍝'},
      {cat:'food',name:'Parrilla',emoji:'🥩'},{cat:'food',name:'Milanesas',emoji:'🍗'},{cat:'food',name:'Pollo',emoji:'🍗'},
      {cat:'food',name:'Saludable',emoji:'🥗'},{cat:'food',name:'Desayunos',emoji:'🥐'},
      {cat:'market',name:'Supermercado',emoji:'🏪'},{cat:'market',name:'Almacén',emoji:'🏠'},{cat:'market',name:'Verdulería',emoji:'🥦'},
      {cat:'market',name:'Carnicería',emoji:'🥩'},{cat:'market',name:'Dietética',emoji:'🌾'},
      {cat:'pharmacy',name:'24 horas',emoji:'🕐'},{cat:'pharmacy',name:'Perfumería',emoji:'💄'},
      {cat:'drinks',name:'Cerveza',emoji:'🍺'},{cat:'drinks',name:'Vinos',emoji:'🍷'},{cat:'drinks',name:'Licores',emoji:'🥃'},{cat:'drinks',name:'Gaseosas',emoji:'🥤'},
      {cat:'desserts',name:'Helados',emoji:'🍦'},{cat:'desserts',name:'Tortas',emoji:'🎂'},{cat:'desserts',name:'Panaderías',emoji:'🥖'},{cat:'desserts',name:'Chocolates',emoji:'🍫'},
      {cat:'cafe',name:'Cafetería',emoji:'☕'},{cat:'cafe',name:'Té',emoji:'🍵'},{cat:'cafe',name:'Brunch',emoji:'🧇'},
    ];
    for (let i=0;i<defaultSubs.length;i++) {
      const s = defaultSubs[i];
      await q('INSERT INTO business_subcategories (id,category_id,name,emoji,sort_order) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',
        [`subcat-${s.cat}-${i}`, s.cat, s.name, s.emoji, i]);
    }
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
      cloudinary.config({ cloudinary_url: process.env.CLOUDINARY_URL.trim() });
    } else {
      cloudinary.config({
        cloud_name: (process.env.CLOUDINARY_CLOUD_NAME || '').trim(),
        api_key:    (process.env.CLOUDINARY_API_KEY    || '').trim(),
        api_secret: (process.env.CLOUDINARY_API_SECRET || '').trim(),
      });
    }
    console.log('✅ Cloudinary listo');
  } else {
    console.warn('⚠️  Cloudinary no configurado — fotos no disponibles');
    cloudinary = null;
  }
} catch(e) { console.warn('⚠️  cloudinary no instalado'); cloudinary = null; }

// ── Web Push (VAPID) ──────────────────────────
let webpush = null;
try {
  webpush = require('web-push');
  const pubKey  = process.env.VAPID_PUBLIC_KEY;
  const privKey = process.env.VAPID_PRIVATE_KEY;
  if (pubKey && privKey) {
    webpush.setVapidDetails('mailto:hola@blow.uy', pubKey, privKey);
    console.log('🔔 web-push VAPID configurado');
  } else {
    console.warn('⚠️  VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY no definidas — push desactivado');
    webpush = null;
  }
} catch(e) { console.warn('⚠️  web-push no instalado:', e.message); webpush = null; }

async function sendPushToOwner(ownerId, payload) {
  if (!webpush) return;
  try {
    const subs = await qa('SELECT * FROM push_subscriptions WHERE user_id=$1', [ownerId]);
    for (const sub of subs) {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          JSON.stringify(payload),
          { TTL: 60 * 60 * 24 } // 24h TTL
        );
      } catch(e) {
        if (e.statusCode === 404 || e.statusCode === 410 || e.statusCode === 400) {
          await q('DELETE FROM push_subscriptions WHERE id=$1', [sub.id]);
        } else {
          console.warn('Push send error:', e.statusCode, e.message?.slice(0,80));
        }
      }
    }
  } catch(e) { console.error('sendPushToOwner error:', e.message); }
}
// Alias semántico para notificar clientes (misma lógica)
const sendPushToUser = sendPushToOwner;

async function uploadPhoto(base64Data, mimeType) {
  if (!cloudinary) throw new Error('Cloudinary no configurado. Agregá las variables CLOUDINARY_* en Railway.');
  const dataUri = `data:${mimeType};base64,${base64Data}`;
  const result  = await cloudinary.uploader.upload(dataUri, {
    folder: 'blow/products'
  });
  return { url: result.secure_url, cloudinary_id: result.public_id };
}
async function deletePhoto(cloudinaryId) {
  if (cloudinary && cloudinaryId) {
    try { await cloudinary.uploader.destroy(cloudinaryId); } catch {}
  }
}

// ════════════════════════════════════════════════
//  MULTER + CLOUDINARY UPLOAD
// ════════════════════════════════════════════════
let multerUpload = null;
try {
  const multer = require('multer');
  // Always use memory storage — upload manually to Cloudinary to avoid signature issues
  multerUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
      const allowed = ['image/jpeg','image/png','image/webp','image/gif'];
      if (allowed.includes(file.mimetype)) cb(null, true);
      else cb(new Error('Solo se permiten imágenes (JPG, PNG, WebP, GIF)'));
    }
  });
} catch(e) { console.log('Multer not available:', e.message); }

function uploadMiddleware(field) {
  return (req, res, next) => {
    if (!multerUpload) return res.status(503).json({ error: 'Upload no disponible' });
    multerUpload.single(field)(req, res, async (err) => {
      if (err) return res.status(400).json({ error: 'Archivo inválido. Verificá el formato y tamaño.' });
      // If we have a file buffer and cloudinary, upload now
      if (req.file && req.file.buffer && cloudinary) {
        try {
          const b64 = req.file.buffer.toString('base64');
          const up = await uploadPhoto(b64, req.file.mimetype || 'image/jpeg');
          req.file.path = up.url;
          req.file.secure_url = up.url;
          req.file.cloudinary_id = up.cloudinary_id;
        } catch(upErr) {
          return res.status(500).json({ error: 'Error subiendo imagen: ' + upErr.message });
        }
      }
      next();
    });
  };
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
    windowMs: 15 * 60 * 1000, max: 300,
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
  // Limiter más agresivo para forgot/reset: 5 intentos por hora
  const passwordResetLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, max: 5,
    message: { error: 'Demasiados intentos de recuperación. Esperá 1 hora.' },
    standardHeaders: true, legacyHeaders: false,
    validate: { xForwardedForHeader: false },
  });
  app.use('/api/', generalLimiter);
  app.use('/api/auth/', authLimiter);
  app.use('/api/auth/forgot-password', passwordResetLimiter);
  app.use('/api/auth/reset-password', passwordResetLimiter);
  // Limiter para endpoints públicos pesados (búsqueda y listado de negocios)
  const publicHeavyLimiter = rateLimit({
    windowMs: 60 * 1000, max: 30,
    message: { error: 'Demasiadas búsquedas. Esperá un momento.' },
    standardHeaders: true, legacyHeaders: false,
    validate: { xForwardedForHeader: false },
  });
  app.use('/api/search', publicHeavyLimiter);
  app.use('/api/businesses', publicHeavyLimiter);
}

// 🔒 Fallback login rate limiting (works even if express-rate-limit not installed)
const _loginAttempts = new Map();
function checkLoginRate(ip) {
  const now = Date.now();
  const key = `login_${ip}`;
  const attempts = _loginAttempts.get(key) || [];
  const recent = attempts.filter(t => now - t < 15 * 60 * 1000);
  if (recent.length >= 10) return false;
  recent.push(now);
  _loginAttempts.set(key, recent);
  if (Math.random() < 0.01) _loginAttempts.forEach((v, k) => { if (!v.some(t => now - t < 20 * 60 * 1000)) _loginAttempts.delete(k); });
  return true;
}

// Rate limit para verify-payment: máx 5 llamadas por minuto por usuario
const _verifyPaymentAttempts = new Map();
function checkVerifyPaymentRate(userId) {
  const now = Date.now();
  const attempts = (_verifyPaymentAttempts.get(userId) || []).filter(t => now - t < 60 * 1000);
  if (attempts.length >= 5) return false;
  attempts.push(now);
  _verifyPaymentAttempts.set(userId, attempts);
  if (Math.random() < 0.05) _verifyPaymentAttempts.forEach((v, k) => { if (!v.some(t => now - t < 2 * 60 * 1000)) _verifyPaymentAttempts.delete(k); });
  return true;
}

app.use(cors({ origin: process.env.NODE_ENV === 'production' ? ['https://blow.uy', 'https://www.blow.uy', 'https://blow-app-production.up.railway.app'] : '*' }));
app.use(express.json({ limit: '15mb' })); // fotos de productos en base64 (hasta 4 x 3MB)
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1d' }));

// Logo estático con cache largo (1 año)
app.get('/logo.png', (req, res) => {
  res.set({ 'Cache-Control': 'public, max-age=31536000', 'Content-Type': 'image/png' });
  res.sendFile(path.join(__dirname, 'public', 'logo.png'));
});

// PWA manifest
app.get('/manifest.json', (req, res) => {
  res.set({ 'Content-Type': 'application/manifest+json', 'Cache-Control': 'public, max-age=86400' });
  res.sendFile(path.join(__dirname, 'public', 'manifest.json'));
});

// PWA icons
app.get('/icons/:file', (req, res) => {
  const allowed = ['icon-72.png','icon-96.png','icon-128.png','icon-144.png','icon-152.png','icon-192.png','icon-384.png','icon-512.png'];
  if (!allowed.includes(req.params.file)) return res.sendStatus(404);
  res.set({ 'Cache-Control': 'public, max-age=31536000', 'Content-Type': 'image/png' });
  res.sendFile(path.join(__dirname, 'public', 'icons', req.params.file));
});

// ── Helpers ───────────────────────────────────
const sign = u => jwt.sign({ id:u.id, name:u.name, email:u.email, role:u.role }, JWT_SECRET, { expiresIn:'7d' });
async function auth(req, res, next) {
  const h = req.headers.authorization;
  if (!h || !h.startsWith('Bearer ')) return res.status(401).json({ error:'Token requerido' });
  try {
    const decoded = jwt.verify(h.split(' ')[1], JWT_SECRET);
    // Invalidar tokens emitidos antes del último cambio de contraseña + verificar ban
    if (decoded.iat) {
      const u = await q1('SELECT password_changed_at, banned FROM users WHERE id=$1', [decoded.id]);
      if (u?.banned) return res.status(403).json({ error:'Tu cuenta fue suspendida. Contactá al soporte.' });
      if (u?.password_changed_at) {
        const changedAt = Math.floor(new Date(u.password_changed_at).getTime() / 1000);
        if (decoded.iat < changedAt) return res.status(401).json({ error:'Sesión expirada. Por favor iniciá sesión de nuevo.' });
      }
    }
    req.user = decoded;
    next();
  } catch { res.status(401).json({ error:'Token inválido' }); }
}
const role = (...roles) => (req, res, next) =>
  roles.includes(req.user && req.user.role) ? next() : res.status(403).json({ error:`Rol requerido: ${roles.join('/')}` });

async function getWallet(ownerId, ownerType) {
  // Usar ON CONFLICT para ser race-safe: si dos entregas simultáneas llaman esto, no falla
  const id = uuid();
  await q('INSERT INTO wallets (id,owner_id,owner_type,balance) VALUES ($1,$2,$3,0) ON CONFLICT (owner_id) DO NOTHING', [id, ownerId, ownerType]);
  return await q1('SELECT * FROM wallets WHERE owner_id=$1', [ownerId]);
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
function escHtml(str) {
  if (typeof str !== 'string') return '';
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
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

// ── Order status email notifications ───────────────
async function sendOrderStatusEmail(order, status, bizName) {
  if (!order.customer_id) return;
  const customer = await q1('SELECT name,email FROM users WHERE id=$1', [order.customer_id]);
  if (!customer?.email) return;
  const code = '#' + order.id.slice(-6).toUpperCase();
  const name = escHtml(customer.name?.split(' ')[0] || 'Cliente');
  const biz = escHtml(bizName || 'el negocio');
  const total = '$' + (order.total || 0);

  const templates = {
    confirmed: {
      subject: `✅ Pedido ${code} confirmado — Blow`,
      emoji: '✅', title: '¡Tu pedido fue confirmado!',
      body: `<b>${biz}</b> aceptó tu pedido ${code} por ${total}. Te avisaremos cuando esté en preparación.`,
      color: '#22c55e'
    },
    preparing: {
      subject: `👨‍🍳 Pedido ${code} en preparación — Blow`,
      emoji: '👨‍🍳', title: 'Estamos preparando tu pedido',
      body: `Tu pedido ${code} de <b>${biz}</b> está siendo preparado. ¡Ya falta poco!`,
      color: '#f59e0b'
    },
    ready: {
      subject: `🟢 Pedido ${code} listo — Blow`,
      emoji: '🟢', title: '¡Tu pedido está listo!',
      body: `Tu pedido ${code} de <b>${biz}</b> ya está listo para ser entregado o retirado.`,
      color: '#3b82f6'
    },
    on_way: {
      subject: `🛵 Pedido ${code} en camino — Blow`,
      emoji: '🛵', title: '¡Tu pedido está en camino!',
      body: `Tu pedido ${code} de <b>${biz}</b> ya salió. Preparate para recibirlo.`,
      color: '#8b5cf6'
    },
    delivered: {
      subject: `🎉 Pedido ${code} entregado — Blow`,
      emoji: '🎉', title: '¡Buen provecho!',
      body: `Tu pedido ${code} de <b>${biz}</b> fue entregado. ¡Esperamos que lo disfrutes!<br><br>¿Cómo fue tu experiencia? Dejá tu reseña en la app.`,
      color: '#ea356b'
    },
    cancelled: {
      subject: `❌ Pedido ${code} cancelado — Blow`,
      emoji: '❌', title: 'Tu pedido fue cancelado',
      body: `Tu pedido ${code} de <b>${biz}</b> fue cancelado. Si tenés dudas, contactanos desde la app.`,
      color: '#ef4444'
    }
  };
  const t = templates[status];
  if (!t) return;
  const html = `
    <div style="max-width:480px;margin:0 auto;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
      <div style="background:${t.color};padding:24px;text-align:center;border-radius:12px 12px 0 0;">
        <div style="font-size:48px;margin-bottom:8px;">${t.emoji}</div>
        <div style="font-size:22px;font-weight:800;color:#fff;">${t.title}</div>
      </div>
      <div style="background:#fff;padding:24px;border:1px solid #eee;border-top:none;border-radius:0 0 12px 12px;">
        <p style="font-size:15px;color:#333;line-height:1.6;margin:0 0 16px;">Hola <b>${name}</b>,</p>
        <p style="font-size:15px;color:#333;line-height:1.6;margin:0 0 20px;">${t.body}</p>
        <div style="background:#f8f9fa;border-radius:8px;padding:14px;margin-bottom:16px;">
          <div style="font-size:12px;color:#999;margin-bottom:4px;">PEDIDO</div>
          <div style="font-size:18px;font-weight:800;color:#0f172a;">${code}</div>
        </div>
        <a href="https://blow.uy" style="display:block;text-align:center;background:${t.color};color:#fff;text-decoration:none;padding:14px;border-radius:10px;font-weight:700;font-size:15px;">Ver mi pedido en Blow</a>
        <p style="font-size:12px;color:#aaa;margin-top:20px;text-align:center;">Blow — Pedidos a domicilio</p>
      </div>
    </div>`;
  sendEmail(customer.email, t.subject, html).catch(() => {});
}

app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, email, phone='', password } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error:'Nombre, email y contraseña son obligatorios' });
    if (password.length < 6) return res.status(400).json({ error:'La contraseña debe tener al menos 6 caracteres' });
    const emailLow = email.toLowerCase().trim();
    // Generate 6-digit code
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const id = uuid();
    const hashed = await bcrypt.hash(password, 10);
    // Si el email ya existe, respondemos igual que si enviamos el código (anti-enumeration)
    const existing = await q1('SELECT id FROM users WHERE email=$1', [emailLow]);
    if (existing) return res.status(200).json({ pending: true, message:'Código enviado a ' + emailLow });
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
  } catch(e) { console.error('Server error:', e.message); res.status(500).json({ error:'Error interno. Intentá de nuevo.' }); }
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
  } catch(e) { console.error('Server error:', e.message); res.status(500).json({ error:'Error interno. Intentá de nuevo.' }); }
});

// Verificar código de email para business.html (no crea cuenta, solo valida)
app.post('/api/auth/check-verification', async (req, res) => {
  try {
    const { email, code } = req.body;
    if (!email || !code) return res.status(400).json({ error:'Email y código requeridos' });
    const emailLow = email.toLowerCase().trim();
    const row = await q1('SELECT * FROM email_verifications WHERE email=$1 AND expires_at > NOW()', [emailLow]);
    if (!row) return res.status(400).json({ error:'Código expirado. Solicitá uno nuevo.' });
    if (row.code !== code.trim()) return res.status(400).json({ error:'Código incorrecto' });
    res.json({ valid: true });
  } catch(e) { res.status(500).json({ error:'Error interno. Intentá de nuevo.' }); }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    if (!checkLoginRate(req.ip)) return res.status(429).json({ error:'Demasiados intentos. Esperá 15 minutos.' });
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
  } catch(e) { console.error('Server error:', e.message); res.status(500).json({ error:'Error interno. Intentá de nuevo.' }); }
});


// ── Registro de negocio desde business.html ──────────────────
// Alias de /api/auth/register con role=owner + crea negocio
app.post('/api/auth/register-business', async (req, res) => {
  try {
    const { name, email, phone='', password, business_name, address='', city='', department='', description='', business_type='food' } = req.body;
    if (!name || !email || !password || !business_name) return res.status(400).json({ error:'Faltan datos obligatorios' });
    if (password.length < 6) return res.status(400).json({ error:'La contraseña debe tener al menos 6 caracteres' });
    const emailLow = email.toLowerCase().trim();
    if (await q1('SELECT id FROM users WHERE email=$1', [emailLow])) return res.status(400).json({ error:'No se pudo completar el registro. Revisá los datos e intentá de nuevo.' });
    const hashed = await bcrypt.hash(password, 10);
    const userId = uuid();
    await q('INSERT INTO users (id,name,email,phone,password,role,city,department) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [userId, name.trim(), emailLow, phone, hashed, 'owner', city, department||'']);
    const bizId = uuid();
    await q('INSERT INTO businesses (id,owner_id,name,category,address,city,department,description) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [bizId, userId, business_name.trim(), business_type||'food', address, city, department||'', description||'']);
    const user = { id:userId, name:name.trim(), email:emailLow, role:'owner' };
    res.status(201).json({ token: sign(user), user, business_id: bizId });
  } catch(e) { res.status(500).json({ error: 'Error interno. Intentá de nuevo.' }); }
});

// ── Envío de código de verificación de email (desde business.html) ──
// El código se genera server-side para evitar manipulación
app.post('/api/auth/send-verification', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error:'Email requerido' });
    const emailLow = email.toLowerCase().trim();
    if (!isValidEmail(emailLow)) return res.status(400).json({ error:'Email inválido' });
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    // Guardar código en DB (no devolverlo en la respuesta)
    await q('DELETE FROM email_verifications WHERE email=$1', [emailLow]);
    await q('INSERT INTO email_verifications (id,email,code,data,expires_at) VALUES ($1,$2,$3,$4,NOW()+INTERVAL\'15 minutes\')',
      [uuid(), emailLow, code, JSON.stringify({ biz_verify: true })]);
    const sent = await sendEmail(emailLow, 'Tu código de verificación — Blow',
      `<div style="font-family:sans-serif;max-width:400px;margin:0 auto;padding:32px;">
        <h2 style="color:#FA0050;">⚡ Blow</h2>
        <p>Tu código de verificación es:</p>
        <div style="font-size:40px;font-weight:900;letter-spacing:8px;color:#FA0050;text-align:center;padding:24px;background:#fff5f7;border-radius:12px;margin:20px 0;">${code}</div>
        <p style="color:#888;font-size:13px;">Válido por 15 minutos. Si no solicitaste este código ignorá este mensaje.</p>
      </div>`);
    // Solo devolver sent — nunca el código
    res.json({ sent: !!sent });
  } catch(e) { res.status(500).json({ error: 'Error al enviar verificación. Intentá de nuevo.' }); }
});

// ── Olvidé mi contraseña — paso 1: enviar código ──────────────
app.post('/api/auth/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email requerido' });
    const emailLow = email.toLowerCase().trim();
    const u = await q1('SELECT id, name FROM users WHERE email=$1', [emailLow]);
    // Siempre responder ok para no revelar si el email existe
    if (!u) return res.json({ ok: true });
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    await q('DELETE FROM email_verifications WHERE email=$1', [emailLow]);
    await q('INSERT INTO email_verifications (id,email,code,data) VALUES ($1,$2,$3,$4)',
      [uuid(), emailLow, code, JSON.stringify({ reset: true, user_id: u.id })]);
    await sendEmail(emailLow, 'Recuperá tu contraseña — Blow',
      `<div style="font-family:sans-serif;max-width:400px;margin:0 auto;padding:32px;">
        <h2 style="color:#FA0050;">⚡ Blow</h2>
        <p>Hola <strong>${u.name}</strong>, recibimos una solicitud para restablecer tu contraseña.</p>
        <div style="font-size:40px;font-weight:900;letter-spacing:8px;color:#FA0050;text-align:center;padding:24px;background:#fff5f7;border-radius:12px;margin:20px 0;">${code}</div>
        <p style="color:#888;font-size:13px;">Válido por 15 minutos. Si no solicitaste esto, ignorá este mensaje.</p>
      </div>`);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: 'Error interno. Intentá de nuevo.' }); }
});

// ── Olvidé mi contraseña — paso 2: verificar código + nueva contraseña ──
app.post('/api/auth/reset-password', async (req, res) => {
  try {
    const { email, code, new_password } = req.body;
    if (!email || !code || !new_password) return res.status(400).json({ error: 'Faltan campos' });
    if (new_password.length < 6) return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });
    const emailLow = email.toLowerCase().trim();
    const row = await q1('SELECT * FROM email_verifications WHERE email=$1 AND expires_at > NOW()', [emailLow]);
    if (!row) return res.status(400).json({ error: 'Código expirado o no encontrado. Pedí uno nuevo.' });
    if (row.code !== code.trim()) return res.status(400).json({ error: 'Código incorrecto' });
    const data = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
    if (!data.reset) return res.status(400).json({ error: 'Código inválido' });
    const hashed = await bcrypt.hash(new_password, 10);
    await q('UPDATE users SET password=$1, password_changed_at=NOW() WHERE id=$2', [hashed, data.user_id]);
    await q('DELETE FROM email_verifications WHERE email=$1', [emailLow]);
    const u = await q1('SELECT id,name,email,role FROM users WHERE id=$1', [data.user_id]);
    res.json({ ok: true, token: sign(u), user: { id:u.id, name:u.name, email:u.email, role:u.role } });
  } catch(e) { console.error('Reset password error:', e.message); res.status(500).json({ error:'Error interno. Intentá de nuevo.' }); }
});

app.get('/api/auth/me', auth, async (req, res) => {
  try {
    const u = await q1('SELECT id,name,email,phone,role,address,city,department,avatar_url,blow_plus,blow_plus_expires FROM users WHERE id=$1', [req.user.id]);
    if (!u) return res.status(404).json({ error:'No encontrado' });
    u.addresses = await qa('SELECT * FROM user_addresses WHERE user_id=$1 ORDER BY is_active DESC,created_at DESC', [req.user.id]);
    res.json(u);
  } catch(e) { res.status(500).json({ error:'Error interno. Intentá de nuevo.' }); }
});

app.patch('/api/auth/me', auth, async (req, res) => {
  try {
    const { name, phone, address, city, department } = req.body;
    const cleanName = name ? sanitize(name, 100) : null;
    const cleanPhone = phone ? sanitize(phone, 30) : null;
    const cleanAddress = address ? sanitize(address, 300) : null;
    const cleanCity = city ? sanitize(city, 100) : null;
    const cleanDept = department ? sanitize(department, 100) : null;
    await q('UPDATE users SET name=COALESCE($1,name),phone=COALESCE($2,phone),address=COALESCE($3,address),city=COALESCE($4,city),department=COALESCE($5,department) WHERE id=$6',
      [cleanName, cleanPhone, cleanAddress, cleanCity, cleanDept, req.user.id]);
    res.json(await q1('SELECT id,name,email,phone,role,address,city,department,avatar_url,blow_plus,blow_plus_expires FROM users WHERE id=$1', [req.user.id]));
  } catch(e) { res.status(500).json({ error:'Error interno. Intentá de nuevo.' }); }
});

// ════════════════════════════════════════════════
//  DIRECCIONES
// ════════════════════════════════════════════════
app.get('/api/addresses', auth, async (req, res) => {
  try {
    res.json(await qa('SELECT * FROM user_addresses WHERE user_id=$1 ORDER BY is_active DESC,created_at DESC', [req.user.id]));
  } catch(e) { res.status(500).json({ error:'Error interno.' }); }
});

app.post('/api/addresses', auth, async (req, res) => {
  try {
    const { label, full_address, city, department='', lat=null, lng=null } = req.body;
    if (!full_address || !city) return res.status(400).json({ error:'full_address y city son obligatorios' });
    const parsedLat = lat != null ? parseFloat(lat) : null;
    const parsedLng = lng != null ? parseFloat(lng) : null;
    if (parsedLat !== null && (isNaN(parsedLat) || parsedLat < -90 || parsedLat > 90)) return res.status(400).json({ error:'Latitud inválida' });
    if (parsedLng !== null && (isNaN(parsedLng) || parsedLng < -180 || parsedLng > 180)) return res.status(400).json({ error:'Longitud inválida' });
    const cnt = await q1('SELECT COUNT(*) as c FROM user_addresses WHERE user_id=$1', [req.user.id]);
    if (parseInt(cnt.c) >= 10) return res.status(400).json({ error:'Máximo 10 direcciones guardadas' });
    const isFirst = parseInt(cnt.c) === 0;
    const id = uuid();
    await q('INSERT INTO user_addresses (id,user_id,label,full_address,city,department,lat,lng,is_active) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [id, req.user.id, sanitize(label||'Mi dirección',50), sanitize(full_address,300).trim(), sanitize(city,100).trim(), sanitize(department,100), parsedLat, parsedLng, isFirst]);
    if (isFirst) await q('UPDATE users SET city=$1,department=$2 WHERE id=$3', [city.trim(), department, req.user.id]);
    res.status(201).json(await q1('SELECT * FROM user_addresses WHERE id=$1', [id]));
  } catch(e) { res.status(500).json({ error:'Error interno. Intentá de nuevo.' }); }
});

app.post('/api/addresses/:id/activate', auth, async (req, res) => {
  try {
    const addr = await q1('SELECT * FROM user_addresses WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id]);
    if (!addr) return res.status(404).json({ error:'Dirección no encontrada' });
    await q('UPDATE user_addresses SET is_active=FALSE WHERE user_id=$1', [req.user.id]);
    await q('UPDATE user_addresses SET is_active=TRUE WHERE id=$1', [req.params.id]);
    await q('UPDATE users SET city=$1,department=$2,address=$3 WHERE id=$4', [addr.city, addr.department, addr.full_address, req.user.id]);
    res.json({ success:true, active: await q1('SELECT * FROM user_addresses WHERE id=$1', [req.params.id]) });
  } catch(e) { console.error('addresses activate error:', e.message); res.status(500).json({ error:'Error interno. Intentá de nuevo.' }); }
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
  } catch(e) { console.error('addresses DELETE error:', e.message); res.status(500).json({ error:'Error interno. Intentá de nuevo.' }); }
});

// ════════════════════════════════════════════════
//  NEGOCIOS
// ════════════════════════════════════════════════

app.get('/api/businesses', async (req, res) => {
  try {
  const { category, city, department } = req.query;
  // Lightweight query: rating is already on businesses table, count products/promos with subqueries
  const baseSql = `SELECT b.*,
    (SELECT COUNT(*) FROM products p WHERE p.business_id=b.id AND p.is_available=TRUE)::int as product_count,
    (SELECT COUNT(*) FROM promotions prm WHERE prm.business_id=b.id AND (prm.ends_at IS NULL OR prm.ends_at > NOW()))::int as promo_count
    FROM businesses b`;
  
  const mapRow = b => ({
    ...b,
    rating: b.rating ? parseFloat(b.rating) : null,
    product_count: parseInt(b.product_count || 0),
    promo_count: parseInt(b.promo_count || 0),
  });

  // Try with all filters first
  let sql = baseSql + ' WHERE 1=1';
  const params = [];
  let i = 1;
  if (category)   { sql += ` AND b.category=$${i++}`;            params.push(category); }
  if (city)       { sql += ` AND (LOWER(b.city)=LOWER($${i}) OR b.city IS NULL OR b.city='')`; params.push(city); i++; }
  if (department) { sql += ` AND LOWER(b.department)=LOWER($${i++})`; params.push(department); }
  sql += ` ORDER BY b.blow_plus DESC NULLS LAST, b.created_at DESC`;
  
  let rows = await qa(sql, params);
  
  // If city filter returned 0 results, return ALL businesses (city might not be set)
  if (rows.length === 0 && (city || department)) {
    let fallbackSql = baseSql + ' WHERE 1=1';
    const fbParams = [];
    let j = 1;
    if (category) { fallbackSql += ` AND b.category=$${j++}`; fbParams.push(category); }
    fallbackSql += ` ORDER BY b.blow_plus DESC NULLS LAST, b.created_at DESC`;
    rows = await qa(fallbackSql, fbParams);
  }
  
  res.json(rows.map(mapRow));
  } catch(e) { console.error('businesses error:', e.message); res.status(500).json({ error:'Error al cargar negocios.' }); }
});

// ── Búsqueda global: negocios + productos ────
app.get('/api/search', async (req, res) => {
  const { q, city, department } = req.query;
  if (!q || q.trim().length < 2) return res.json({ businesses: [], products: [] });
  // Escape LIKE wildcards to prevent unintended matching
  const escaped = q.trim().toLowerCase().replace(/%/g, '\\%').replace(/_/g, '\\_');
  const term = `%${escaped}%`;

  const bizParams = [term, term];
  let bizWhere = `(LOWER(b.name) LIKE $1 OR LOWER(b.category) LIKE $2 OR LOWER(b.description) LIKE $1 OR LOWER(b.tags::text) LIKE $1)`;
  if (city) { bizWhere += ` AND LOWER(b.city)=LOWER($${bizParams.length+1})`; bizParams.push(city); }
  else if (department) { bizWhere += ` AND LOWER(b.department)=LOWER($${bizParams.length+1})`; bizParams.push(department); }

  const prodParams = [term, term];
  let prodWhere = `p.is_available=TRUE AND (LOWER(p.name) LIKE $1 OR LOWER(p.description) LIKE $2)`;
  if (city) { prodWhere += ` AND LOWER(b.city)=LOWER($${prodParams.length+1})`; prodParams.push(city); }
  else if (department) { prodWhere += ` AND LOWER(b.department)=LOWER($${prodParams.length+1})`; prodParams.push(department); }

  try {
    const [businesses, products] = await Promise.all([
      qa(`SELECT b.* FROM businesses b WHERE ${bizWhere} ORDER BY b.blow_plus DESC NULLS LAST LIMIT 15`, bizParams),
      qa(`SELECT p.id as product_id, p.name as product_name, p.price, p.emoji, p.photo_url, p.discount_percent,
          b.id as biz_id, b.name as biz_name, b.logo_emoji, b.logo_url, b.delivery_time, b.delivery_cost, b.is_open, b.blow_plus
          FROM products p JOIN businesses b ON p.business_id=b.id
          WHERE ${prodWhere} ORDER BY b.blow_plus DESC NULLS LAST LIMIT 20`, prodParams)
    ]);
    res.json({ businesses, products });
  } catch(e) { res.status(500).json({ error: 'Error en la búsqueda.' }); }
});

// Public APIs
app.get('/api/plans', async (_, res) => {
  try {
    const plans = await qa('SELECT * FROM subscription_plans WHERE is_active=TRUE ORDER BY sort_order',[]);
    res.json(plans.map(p => ({ ...p, features: (() => { try { return JSON.parse(p.features||'[]'); } catch { return []; } })() })));
  } catch(e) { res.status(500).json({ error:'Error al cargar planes.' }); }
});
app.get('/api/business-categories', async (_, res) => {
  try {
    res.json(await qa('SELECT * FROM business_categories WHERE is_active=TRUE ORDER BY sort_order',[]));
  } catch(e) { res.status(500).json({ error:'Error al cargar categorías.' }); }
});

// ── Admin: business categories CRUD ──
app.get('/api/admin/business-categories', auth, role('admin'), async (req, res) => {
  try {
    res.json(await qa('SELECT * FROM business_categories ORDER BY sort_order',[]));
  } catch(e) { console.error('business-categories GET error:', e.message); res.status(500).json({ error:'Error interno. Intentá de nuevo.' }); }
});
app.post('/api/admin/business-categories', auth, role('admin'), async (req, res) => {
  try {
    const { name, emoji='🏪', sort_order=99 } = req.body;
    if (!name) return res.status(400).json({ error:'name requerido' });
    const id = 'cat-' + uuid().slice(0,8);
    await q('INSERT INTO business_categories (id,name,emoji,sort_order) VALUES ($1,$2,$3,$4)',[id,name,emoji,sort_order]);
    res.json({ success:true, id });
  } catch(e) { console.error('business-categories POST error:', e.message); res.status(500).json({ error:'Error interno. Intentá de nuevo.' }); }
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
  } catch(e) { console.error('business-categories PATCH error:', e.message); res.status(500).json({ error:'Error interno. Intentá de nuevo.' }); }
});
app.delete('/api/admin/business-categories/:id', auth, role('admin'), async (req, res) => {
  try {
    await q('DELETE FROM business_categories WHERE id=$1',[req.params.id]);
    // Also delete subcategories for this category
    await q('DELETE FROM business_subcategories WHERE category_id=$1',[req.params.id]);
    res.json({ success:true });
  } catch(e) { console.error('business-categories DELETE error:', e.message); res.status(500).json({ error:'Error interno. Intentá de nuevo.' }); }
});

// ═══════════════════════════════════════════════
//  ADMIN: SUBCATEGORÍAS
// ═══════════════════════════════════════════════
app.get('/api/subcategories', async (req, res) => {
  try {
    const { category_id } = req.query;
    let sql = 'SELECT * FROM business_subcategories WHERE is_active=TRUE';
    const params = [];
    if (category_id) { sql += ' AND category_id=$1'; params.push(category_id); }
    sql += ' ORDER BY sort_order ASC, name ASC';
    res.json(await qa(sql, params));
  } catch(e) { res.status(500).json({ error:'Error al cargar subcategorías.' }); }
});

app.get('/api/admin/subcategories', auth, role('admin'), async (req, res) => {
  try {
    const { category_id } = req.query;
    let sql = 'SELECT s.*, c.name as category_name FROM business_subcategories s LEFT JOIN business_categories c ON c.id=s.category_id';
    const params = [];
    if (category_id) { sql += ' WHERE s.category_id=$1'; params.push(category_id); }
    sql += ' ORDER BY s.category_id, s.sort_order ASC';
    res.json(await qa(sql, params));
  } catch(e) { console.error('admin/subcategories GET error:', e.message); res.status(500).json({ error:'Error interno. Intentá de nuevo.' }); }
});

app.post('/api/admin/subcategories', auth, role('admin'), async (req, res) => {
  try {
    const { category_id, name, emoji='🍽️', image_url, sort_order=0 } = req.body;
    if (!category_id || !name) return res.status(400).json({ error:'category_id y name son obligatorios' });
    const id = 'subcat-' + uuid().slice(0,8);
    await q('INSERT INTO business_subcategories (id,category_id,name,emoji,image_url,sort_order) VALUES ($1,$2,$3,$4,$5,$6)',
      [id, category_id, name.trim(), emoji, image_url||null, sort_order]);
    res.status(201).json(await q1('SELECT * FROM business_subcategories WHERE id=$1',[id]));
  } catch(e) { console.error('admin/subcategories POST error:', e.message); res.status(500).json({ error:'Error interno. Intentá de nuevo.' }); }
});

app.patch('/api/admin/subcategories/:id', auth, role('admin'), async (req, res) => {
  try {
    const { name, emoji, image_url, sort_order, is_active, category_id } = req.body;
    const updates=[]; const params=[]; let i=1;
    if (name!==undefined)        { updates.push(`name=$${i++}`);        params.push(name.trim()); }
    if (emoji!==undefined)       { updates.push(`emoji=$${i++}`);       params.push(emoji); }
    if (image_url!==undefined)   { updates.push(`image_url=$${i++}`);   params.push(image_url||null); }
    if (sort_order!==undefined)  { updates.push(`sort_order=$${i++}`);  params.push(sort_order); }
    if (is_active!==undefined)   { updates.push(`is_active=$${i++}`);   params.push(is_active); }
    if (category_id!==undefined) { updates.push(`category_id=$${i++}`); params.push(category_id); }
    if (!updates.length) return res.status(400).json({ error:'Nada que actualizar' });
    params.push(req.params.id);
    await q(`UPDATE business_subcategories SET ${updates.join(',')} WHERE id=$${i}`, params);
    res.json(await q1('SELECT * FROM business_subcategories WHERE id=$1',[req.params.id]));
  } catch(e) { console.error('admin/subcategories PATCH error:', e.message); res.status(500).json({ error:'Error interno. Intentá de nuevo.' }); }
});

app.delete('/api/admin/subcategories/:id', auth, role('admin'), async (req, res) => {
  try {
    await q('DELETE FROM business_subcategories WHERE id=$1',[req.params.id]);
    res.json({ success:true });
  } catch(e) { console.error('admin/subcategories DELETE error:', e.message); res.status(500).json({ error:'Error interno. Intentá de nuevo.' }); }
});

// Upload subcategory image
app.post('/api/admin/subcategories/:id/upload-image', auth, role('admin'), uploadMiddleware('photo'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error:'No se recibió imagen' });
    const url = req.file.secure_url || req.file.path;
    await q('UPDATE business_subcategories SET image_url=$1 WHERE id=$2', [url, req.params.id]);
    res.json({ url });
  } catch(e) { console.error('admin/subcategories upload-image error:', e.message); res.status(500).json({ error:'Error interno. Intentá de nuevo.' }); }
});

// ═══════════════════════════════════════════════
//  ADMIN: BANNERS DE CATEGORÍA
// ═══════════════════════════════════════════════
app.get('/api/category-banners', async (req, res) => {
  try {
    const { category_id } = req.query;
    let sql = 'SELECT * FROM category_banners WHERE active=TRUE';
    const params = [];
    if (category_id) { sql += ' AND category_id=$1'; params.push(category_id); }
    sql += ' ORDER BY sort_order ASC, created_at DESC';
    res.json(await qa(sql, params));
  } catch(e) { console.error('category-banners GET public error:', e.message); res.status(500).json({ error:'Error interno. Intentá de nuevo.' }); }
});

app.get('/api/admin/category-banners', auth, role('admin'), async (req, res) => {
  try {
    const { category_id } = req.query;
    let sql = 'SELECT cb.*, c.name as category_name, b.name as business_name FROM category_banners cb LEFT JOIN business_categories c ON c.id=cb.category_id LEFT JOIN businesses b ON b.id=cb.link_business_id';
    const params = [];
    if (category_id) { sql += ' WHERE cb.category_id=$1'; params.push(category_id); }
    sql += ' ORDER BY cb.category_id, cb.sort_order ASC';
    res.json(await qa(sql, params));
  } catch(e) { console.error('admin/category-banners GET error:', e.message); res.status(500).json({ error:'Error interno. Intentá de nuevo.' }); }
});

app.post('/api/admin/category-banners', auth, role('admin'), async (req, res) => {
  try {
    const { category_id, title, subtitle, image_url, bg_color, link_business_id, sort_order=0 } = req.body;
    if (!category_id) return res.status(400).json({ error:'category_id es obligatorio' });
    const id = 'catban-' + uuid().slice(0,8);
    await q('INSERT INTO category_banners (id,category_id,title,subtitle,image_url,bg_color,link_business_id,sort_order) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [id, category_id, title||'', subtitle||'', image_url||'', bg_color||'#FA0050', link_business_id||null, sort_order]);
    res.status(201).json(await q1('SELECT * FROM category_banners WHERE id=$1',[id]));
  } catch(e) { console.error('admin/category-banners POST error:', e.message); res.status(500).json({ error:'Error interno. Intentá de nuevo.' }); }
});

app.patch('/api/admin/category-banners/:id', auth, role('admin'), async (req, res) => {
  try {
    const { title, subtitle, image_url, bg_color, link_business_id, sort_order, active, category_id } = req.body;
    const updates=[]; const params=[]; let i=1;
    if (title!==undefined)            { updates.push(`title=$${i++}`);            params.push(title); }
    if (subtitle!==undefined)         { updates.push(`subtitle=$${i++}`);         params.push(subtitle); }
    if (image_url!==undefined)        { updates.push(`image_url=$${i++}`);        params.push(image_url); }
    if (bg_color!==undefined)         { updates.push(`bg_color=$${i++}`);         params.push(bg_color); }
    if (link_business_id!==undefined) { updates.push(`link_business_id=$${i++}`); params.push(link_business_id||null); }
    if (sort_order!==undefined)       { updates.push(`sort_order=$${i++}`);       params.push(sort_order); }
    if (active!==undefined)           { updates.push(`active=$${i++}`);           params.push(active); }
    if (category_id!==undefined)      { updates.push(`category_id=$${i++}`);      params.push(category_id); }
    if (!updates.length) return res.status(400).json({ error:'Nada que actualizar' });
    params.push(req.params.id);
    await q(`UPDATE category_banners SET ${updates.join(',')} WHERE id=$${i}`, params);
    res.json(await q1('SELECT * FROM category_banners WHERE id=$1',[req.params.id]));
  } catch(e) { console.error('admin/category-banners PATCH error:', e.message); res.status(500).json({ error:'Error interno. Intentá de nuevo.' }); }
});

app.delete('/api/admin/category-banners/:id', auth, role('admin'), async (req, res) => {
  try {
    await q('DELETE FROM category_banners WHERE id=$1',[req.params.id]);
    res.json({ success:true });
  } catch(e) { console.error('admin/category-banners DELETE error:', e.message); res.status(500).json({ error:'Error interno. Intentá de nuevo.' }); }
});

app.post('/api/admin/category-banners/:id/upload-image', auth, role('admin'), uploadMiddleware('photo'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error:'No se recibió imagen' });
    const url = req.file.secure_url || req.file.path;
    await q('UPDATE category_banners SET image_url=$1 WHERE id=$2', [url, req.params.id]);
    res.json({ url });
  } catch(e) { console.error('admin/category-banners upload-image error:', e.message); res.status(500).json({ error:'Error interno. Intentá de nuevo.' }); }
});

// ═══════════════════════════════════════════════
//  ADMIN: DESTACADOS POR CATEGORÍA
// ═══════════════════════════════════════════════
app.get('/api/category-featured', async (req, res) => {
  try {
    const { category_id } = req.query;
    let sql = `SELECT cf.*, b.name as business_name, b.logo_emoji, b.logo_url, b.cover_url, b.rating, b.delivery_time, b.delivery_cost, b.is_open, b.blow_plus
      FROM category_featured cf JOIN businesses b ON b.id=cf.business_id WHERE cf.active=TRUE`;
    const params = [];
    if (category_id) { sql += ' AND cf.category_id=$1'; params.push(category_id); }
    sql += ' ORDER BY cf.sort_order ASC';
    res.json(await qa(sql, params));
  } catch(e) { console.error('category-featured GET public error:', e.message); res.status(500).json({ error:'Error interno. Intentá de nuevo.' }); }
});

app.get('/api/admin/category-featured', auth, role('admin'), async (req, res) => {
  try {
    const { category_id } = req.query;
    let sql = `SELECT cf.*, b.name as business_name, b.logo_emoji, c.name as category_name
      FROM category_featured cf JOIN businesses b ON b.id=cf.business_id LEFT JOIN business_categories c ON c.id=cf.category_id`;
    const params = [];
    if (category_id) { sql += ' WHERE cf.category_id=$1'; params.push(category_id); }
    sql += ' ORDER BY cf.category_id, cf.sort_order ASC';
    res.json(await qa(sql, params));
  } catch(e) { console.error('admin/category-featured GET error:', e.message); res.status(500).json({ error:'Error interno. Intentá de nuevo.' }); }
});

app.post('/api/admin/category-featured', auth, role('admin'), async (req, res) => {
  try {
    const { category_id, business_id, custom_title, custom_image, sort_order=0 } = req.body;
    if (!category_id || !business_id) return res.status(400).json({ error:'category_id y business_id son obligatorios' });
    // Prevent duplicates
    const existing = await q1('SELECT id FROM category_featured WHERE category_id=$1 AND business_id=$2',[category_id, business_id]);
    if (existing) return res.status(409).json({ error:'Este negocio ya está destacado en esta categoría' });
    const id = 'catfeat-' + uuid().slice(0,8);
    await q('INSERT INTO category_featured (id,category_id,business_id,custom_title,custom_image,sort_order) VALUES ($1,$2,$3,$4,$5,$6)',
      [id, category_id, business_id, custom_title||null, custom_image||null, sort_order]);
    res.status(201).json(await q1('SELECT cf.*, b.name as business_name FROM category_featured cf JOIN businesses b ON b.id=cf.business_id WHERE cf.id=$1',[id]));
  } catch(e) { console.error('admin/category-featured POST error:', e.message); res.status(500).json({ error:'Error interno. Intentá de nuevo.' }); }
});

app.patch('/api/admin/category-featured/:id', auth, role('admin'), async (req, res) => {
  try {
    const { custom_title, custom_image, sort_order, active } = req.body;
    const updates=[]; const params=[]; let i=1;
    if (custom_title!==undefined) { updates.push(`custom_title=$${i++}`); params.push(custom_title||null); }
    if (custom_image!==undefined) { updates.push(`custom_image=$${i++}`); params.push(custom_image||null); }
    if (sort_order!==undefined)   { updates.push(`sort_order=$${i++}`);   params.push(sort_order); }
    if (active!==undefined)       { updates.push(`active=$${i++}`);       params.push(active); }
    if (!updates.length) return res.status(400).json({ error:'Nada que actualizar' });
    params.push(req.params.id);
    await q(`UPDATE category_featured SET ${updates.join(',')} WHERE id=$${i}`, params);
    res.json({ success:true });
  } catch(e) { console.error('admin/category-featured PATCH error:', e.message); res.status(500).json({ error:'Error interno. Intentá de nuevo.' }); }
});

app.delete('/api/admin/category-featured/:id', auth, role('admin'), async (req, res) => {
  try {
    await q('DELETE FROM category_featured WHERE id=$1',[req.params.id]);
    res.json({ success:true });
  } catch(e) { console.error('admin/category-featured DELETE error:', e.message); res.status(500).json({ error:'Error interno. Intentá de nuevo.' }); }
});

// ── Admin: subscription plans CRUD ──
app.get('/api/admin/subscription-plans', auth, role('admin'), async (req, res) => {
  try {
    res.json(await qa('SELECT * FROM subscription_plans ORDER BY sort_order',[]));
  } catch(e) { console.error('admin/subscription-plans GET error:', e.message); res.status(500).json({ error:'Error interno. Intentá de nuevo.' }); }
});
app.post('/api/admin/subscription-plans', auth, role('admin'), async (req, res) => {
  try {
    const { name, price, description='', sort_order=99, features='[]' } = req.body;
    if (!name || price===undefined) return res.status(400).json({ error:'name y price requeridos' });
    const id = 'plan-' + uuid().slice(0,8);
    const featStr = typeof features==='string' ? features : JSON.stringify(features);
    await q('INSERT INTO subscription_plans (id,name,price,description,features,sort_order) VALUES ($1,$2,$3,$4,$5,$6)',[id,name,price,description,featStr,sort_order]);
    res.json({ success:true, id });
  } catch(e) { console.error('admin/subscription-plans POST error:', e.message); res.status(500).json({ error:'Error interno. Intentá de nuevo.' }); }
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
  } catch(e) { console.error('admin/subscription-plans PATCH error:', e.message); res.status(500).json({ error:'Error interno. Intentá de nuevo.' }); }
});
app.delete('/api/admin/subscription-plans/:id', auth, role('admin'), async (req, res) => {
  try {
    await q('DELETE FROM subscription_plans WHERE id=$1',[req.params.id]);
    res.json({ success:true });
  } catch(e) { console.error('admin/subscription-plans DELETE error:', e.message); res.status(500).json({ error:'Error interno. Intentá de nuevo.' }); }
});

// ── Stats por período ──────────────────────────
app.get('/api/businesses/mine/stats', auth, role('owner'), async (req, res) => {
  try {
    const b = await q1('SELECT id FROM businesses WHERE owner_id=$1', [req.user.id]);
    if (!b) return res.status(404).json({ error:'No business' });
    const daysRaw = parseInt(req.query.days);
    const days = (!isNaN(daysRaw) && daysRaw > 0) ? Math.min(daysRaw, 90) : 30;
    const rows = await qa(`
      SELECT
        DATE(created_at AT TIME ZONE 'America/Montevideo') as day,
        COUNT(*) FILTER (WHERE status NOT IN ('cancelled','pending')) as orders,
        COALESCE(SUM(total) FILTER (WHERE status NOT IN ('cancelled','pending')),0) as revenue,
        COUNT(*) FILTER (WHERE status='cancelled') as cancelled
      FROM orders
      WHERE business_id=$1
        AND created_at >= NOW() - ($2::int * INTERVAL '1 day')
      GROUP BY day
      ORDER BY day ASC
    `, [b.id, days]);
    // Top productos
    const topProducts = await qa(`
      SELECT oi.name, oi.emoji, SUM(oi.quantity) as qty, SUM(oi.price*oi.quantity) as revenue
      FROM order_items oi
      JOIN orders o ON o.id=oi.order_id
      WHERE o.business_id=$1
        AND o.status NOT IN ('cancelled','pending')
        AND o.created_at >= NOW() - ($2::int * INTERVAL '1 day')
      GROUP BY oi.name, oi.emoji
      ORDER BY qty DESC
      LIMIT 5
    `, [b.id, days]);
    res.json({ days: rows, topProducts });
  } catch(e) { console.error('businesses/mine/stats error:', e.message); res.status(500).json({ error:'Error interno. Intentá de nuevo.' }); }
});

app.get('/api/businesses/mine/dashboard', auth, role('owner'), async (req, res) => {
  try {
    const b = await q1('SELECT * FROM businesses WHERE owner_id=$1', [req.user.id]);
    if (!b) return res.status(404).json({ error:'No tenés ningún negocio registrado aún' });
    const rawP     = await qa('SELECT * FROM products WHERE business_id=$1 ORDER BY created_at DESC', [b.id]);
    // Bulk load photos and variants (avoids N+1 queries)
    const pIds = rawP.map(p => p.id);
    const allPhotos = pIds.length ? await qa('SELECT * FROM product_photos WHERE product_id = ANY($1) ORDER BY sort_order', [pIds]) : [];
    const allVariants = pIds.length ? await qa('SELECT * FROM product_variants WHERE product_id = ANY($1) ORDER BY group_name,sort_order', [pIds]) : [];
    const products = rawP.map(p => ({
      ...p,
      photos: allPhotos.filter(ph => ph.product_id === p.id),
      variants: allVariants.filter(v => v.product_id === p.id),
    }));
    const categories  = await qa('SELECT * FROM product_categories WHERE business_id=$1 ORDER BY sort_order',[b.id]);
    const orders      = await qa(`SELECT o.*,u.name as customer_name,u.phone as customer_phone FROM orders o JOIN users u ON o.customer_id=u.id WHERE o.business_id=$1 ORDER BY o.created_at DESC LIMIT 50`,[b.id]);
    const wallet      = await q1('SELECT * FROM wallets WHERE owner_id=$1',[b.id]) || { balance:0, id:null };
    const transactions= wallet.id ? await qa('SELECT * FROM transactions WHERE wallet_id=$1 ORDER BY created_at DESC LIMIT 30',[wallet.id]) : [];
    const withdrawals = await qa('SELECT * FROM withdrawals WHERE owner_id=$1 ORDER BY created_at DESC',[req.user.id]);
    const today       = await q1(`SELECT COUNT(*) as orders,COALESCE(SUM(total),0) as revenue,COALESCE(SUM(business_amount),0) as net_revenue FROM orders WHERE business_id=$1 AND DATE(created_at)=CURRENT_DATE AND status NOT IN ('cancelled','pending')`,[b.id]);
    const week        = await q1(`SELECT COUNT(*) as orders,COALESCE(SUM(total),0) as revenue,COALESCE(SUM(business_amount),0) as net_revenue FROM orders WHERE business_id=$1 AND created_at>=NOW()-INTERVAL '7 days' AND status NOT IN ('cancelled','pending')`,[b.id]);
    res.json({ business:b, products, categories, orders, balance:parseFloat(wallet.balance)||0, transactions, withdrawals, today, week });
  } catch(e) { console.error('businesses/mine/dashboard error:', e.message); res.status(500).json({ error:'Error interno. Intentá de nuevo.' }); }
});





app.patch('/api/businesses/mine', auth, role('owner'), async (req, res) => {
  try {
    const b = await q1('SELECT * FROM businesses WHERE owner_id=$1',[req.user.id]);
    if (!b) return res.status(404).json({ error:'No tenés ningún negocio' });
    const { name, category, address, phone, logo_emoji, delivery_cost, is_open, plan, delivery_time, city, department, description, tags, offers_pickup, offers_delivery, custom_delivery_cost, schedule, offers_priority, priority_percent } = req.body;
    const scheduleVal = schedule !== undefined ? JSON.stringify(schedule) : null;
    await q(`UPDATE businesses SET name=COALESCE($1,name),category=COALESCE($2,category),address=COALESCE($3,address),phone=COALESCE($4,phone),logo_emoji=COALESCE($5,logo_emoji),delivery_cost=COALESCE($6,delivery_cost),is_open=COALESCE($7,is_open),plan=COALESCE($8,plan),delivery_time=COALESCE($9,delivery_time),city=COALESCE($10,city),department=COALESCE($11,department),offers_priority=COALESCE($12,offers_priority),priority_percent=COALESCE($13,priority_percent),schedule=COALESCE($14,schedule),offers_delivery=COALESCE($16,offers_delivery),offers_pickup=COALESCE($17,offers_pickup) WHERE owner_id=$15`,
      [name,category,address,phone,logo_emoji,delivery_cost,is_open!=null?Boolean(is_open):null,plan,delivery_time,city,department,offers_priority!=null?Boolean(offers_priority):null,priority_percent!=null?parseInt(priority_percent):null,scheduleVal,req.user.id,offers_delivery!=null?Boolean(offers_delivery):null,offers_pickup!=null?Boolean(offers_pickup):null]);
    res.json(await q1('SELECT * FROM businesses WHERE owner_id=$1',[req.user.id]));
  } catch(e) { console.error('businesses/mine PATCH error:', e.message); res.status(500).json({ error:'Error interno. Intentá de nuevo.' }); }
});

// ════════════════════════════════════════════════
//  CATEGORÍAS
// ════════════════════════════════════════════════
app.get('/api/businesses/mine/categories', auth, role('owner'), async (req, res) => {
  try {
    const b = await q1('SELECT id FROM businesses WHERE owner_id=$1',[req.user.id]);
    if (!b) return res.status(404).json({ error:'Sin negocio' });
    res.json(await qa('SELECT * FROM product_categories WHERE business_id=$1 ORDER BY sort_order',[b.id]));
  } catch(e) { console.error('businesses/mine/categories GET error:', e.message); res.status(500).json({ error:'Error interno. Intentá de nuevo.' }); }
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
  } catch(e) { console.error('businesses/mine/categories POST error:', e.message); res.status(500).json({ error:'Error interno. Intentá de nuevo.' }); }
});
app.patch('/api/businesses/mine/categories/:cid', auth, role('owner'), async (req, res) => {
  try {
    const b = await q1('SELECT id FROM businesses WHERE owner_id=$1',[req.user.id]);
    if (!b) return res.status(404).json({ error:'Sin negocio' });
    const { name, parent_id, sort_order } = req.body;
    await q('UPDATE product_categories SET name=COALESCE($1,name),parent_id=COALESCE($2,parent_id),sort_order=COALESCE($3,sort_order) WHERE id=$4 AND business_id=$5',
      [name,parent_id,sort_order,req.params.cid,b.id]);
    res.json(await q1('SELECT * FROM product_categories WHERE id=$1',[req.params.cid]));
  } catch(e) { console.error('businesses/mine/categories PATCH error:', e.message); res.status(500).json({ error:'Error interno. Intentá de nuevo.' }); }
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
  } catch(e) { console.error('businesses/mine/categories DELETE error:', e.message); res.status(500).json({ error:'Error interno. Intentá de nuevo.' }); }
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
  const { name, description='', price, emoji='🍽️', category_id=null, photos=[], variants=[], discount_percent=0, preparation_time=null, calories=null, allergens='', ingredients='', stock=null, is_featured=false } = req.body;
  if (!name || price === undefined) return res.status(400).json({ error:'name y price son obligatorios' });
  if (parseFloat(price) <= 0) return res.status(400).json({ error:'El precio debe ser mayor a cero' });
  if (name.length > 200) return res.status(400).json({ error:'El nombre no puede superar 200 caracteres' });
  const parsedDiscount = Math.min(100, Math.max(0, parseInt(discount_percent) || 0));
  if (description && description.length > 1000) return res.status(400).json({ error:'La descripción no puede superar 1000 caracteres' });
  const parsedStock = stock != null ? parseInt(stock) : null;
  if (parsedStock !== null && parsedStock < 0) return res.status(400).json({ error:'El stock no puede ser negativo' });
  const id = uuid();
  await q('INSERT INTO products (id,business_id,category_id,emoji,name,description,price,discount_percent,is_featured,preparation_time,calories,allergens,ingredients,stock) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)',
    [id,b.id,category_id||null,emoji,name.trim(),(description||'').slice(0,1000),parseFloat(price),parsedDiscount,Boolean(is_featured),preparation_time?parseInt(preparation_time):null,calories?parseInt(calories):null,(allergens||'').slice(0,500),(ingredients||'').slice(0,1000),parsedStock]);
  for (let i=0;i<Math.min(photos.length,4);i++) {
    try { const up=await uploadPhoto(photos[i].data,photos[i].mime_type||'image/jpeg'); await q('INSERT INTO product_photos (id,product_id,url,cloudinary_id,sort_order) VALUES ($1,$2,$3,$4,$5)',[uuid(),id,up.url,up.cloudinary_id,i]); }
    catch(e) { console.error('Photo error:',e.message); }
  }
  for (let i=0;i<Math.min(variants.length,50);i++) {
    const v=variants[i];
    await q('INSERT INTO product_variants (id,product_id,group_name,option_name,price_delta,sort_order,is_required,is_multi,max_selections) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [uuid(),id,(v.group_name||'').slice(0,100),(v.option_name||'').slice(0,100),Math.min(99999,Math.max(-99999,parseFloat(v.price_delta)||0)),i,Boolean(v.is_required),Boolean(v.is_multi),Math.min(20,Math.max(1,parseInt(v.max_selections)||1))]);
  }
  res.status(201).json(await getProductFull(id));
});

app.patch('/api/businesses/mine/products/:pid', auth, role('owner'), async (req, res) => {
  const b = await q1('SELECT id FROM businesses WHERE owner_id=$1',[req.user.id]);
  if (!b) return res.status(404).json({ error:'No tenés ningún negocio' });
  const { name, description, price, emoji, is_available, is_featured, discount_percent, category_id, photos, variants, preparation_time, calories, allergens, stock, available_from, available_until } = req.body;
  if (stock != null && parseInt(stock) < 0) return res.status(400).json({ error:'El stock no puede ser negativo' });
  await q(`UPDATE products SET name=COALESCE($1,name),description=COALESCE($2,description),price=COALESCE($3,price),emoji=COALESCE($4,emoji),is_available=COALESCE($5,is_available),category_id=COALESCE($6,category_id),is_featured=COALESCE($7,is_featured),discount_percent=COALESCE($8,discount_percent),preparation_time=COALESCE($9,preparation_time),calories=COALESCE($10,calories),allergens=COALESCE($11,allergens),stock=COALESCE($12,stock),available_from=COALESCE($15,available_from),available_until=COALESCE($16,available_until) WHERE id=$13 AND business_id=$14`,
    [name,description!=null?description.slice(0,1000):null,price!=null?parseFloat(price):null,emoji,is_available!=null?Boolean(is_available):null,category_id||null,is_featured!=null?Boolean(is_featured):null,discount_percent!=null?Math.min(100,Math.max(0,parseInt(discount_percent))):null,preparation_time!=null?parseInt(preparation_time):null,calories!=null?parseInt(calories):null,allergens!=null?allergens:null,stock!=null?Math.max(0,parseInt(stock)):null,req.params.pid,b.id,available_from||null,available_until||null]);
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
    for (let i=0;i<Math.min(variants.length,50);i++) {
      const v=variants[i];
      await q('INSERT INTO product_variants (id,product_id,group_name,option_name,price_delta,sort_order,is_required,is_multi,max_selections) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [uuid(),req.params.pid,(v.group_name||'').slice(0,100),(v.option_name||'').slice(0,100),Math.min(99999,Math.max(-99999,parseFloat(v.price_delta)||0)),i,Boolean(v.is_required),Boolean(v.is_multi),Math.min(20,Math.max(1,parseInt(v.max_selections)||1))]);
    }
  }
  // Update ingredients if provided
  if (req.body.ingredients !== undefined) {
    await q('UPDATE products SET ingredients=$1 WHERE id=$2',[(req.body.ingredients||'').slice(0,1000),req.params.pid]);
  }
  res.json(await getProductFull(req.params.pid));
});

// Soft-delete: marks product as unavailable (preserves order history references)
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
      return res.status(400).json({ error:'No se pudo completar el registro. Revisá los datos e intentá de nuevo.' });

    const regId = uuid();
    const hashedPw = await bcrypt.hash(password, 10);
    await q('INSERT INTO pending_registrations (id,data) VALUES ($1,$2)',
      [regId, JSON.stringify({ bizName,category,address,city,department,name,email:emailLow,password:hashedPw,phone })]);

    // ── Preapproval: recurring subscription ──
    const backUrl = `${APP_URL}/business`;
    await loadPlanPrice(); // asegurar precio actualizado
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
  } catch(e) { console.error('Register initiate error:', e); res.status(500).json({ error: 'Error al iniciar registro. Intentá de nuevo.' }); }
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
      [userId, d.name, d.email, d.phone||'', d.password, 'owner', d.city, d.department||'']);
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
  } catch(e) { console.error('Register complete error:', e); res.status(500).json({ error: 'Error al completar registro. Intentá de nuevo.' }); }
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
  try {
    await q("UPDATE subscriptions SET status='suspended',updated_at=NOW() WHERE id=$1",[req.params.id]);
    res.json({ success:true });
  } catch(e) { console.error('subscriptions/suspend error:', e.message); res.status(500).json({ error:'Error interno. Intentá de nuevo.' }); }
});

// ════════════════════════════════════════════════
//  PEDIDOS
// ════════════════════════════════════════════════
app.post('/api/orders', auth, role('customer'), async (req, res) => {
  try {
    const { business_id, items, address, payment_method='mercadopago', tip=0, priority=false, notes='', coupon_code='', scheduled_for=null } = req.body;
    if (!business_id || !items || !items.length) return res.status(400).json({ error:'business_id e items son obligatorios' });
    if (!Array.isArray(items) || items.length > 30) return res.status(400).json({ error:'Máximo 30 productos por pedido' });
    if (!['mercadopago','cash'].includes(payment_method)) return res.status(400).json({ error:'Método de pago inválido' });

    // Protección contra doble submit: si el usuario tiene un pedido pending/paid reciente (<2min) para el mismo negocio, devolver ese pedido
    if (!scheduled_for) {
      const recentOrder = await q1(
        `SELECT id, status FROM orders WHERE customer_id=$1 AND business_id=$2 AND status IN ('pending','paid') AND created_at > NOW() - INTERVAL '2 minutes'`,
        [req.user.id, business_id]
      );
      if (recentOrder) return res.status(409).json({ error:'Ya tenés un pedido reciente en este negocio. Revisá tus pedidos antes de crear uno nuevo.', order_id: recentOrder.id });
    }

    // Validate scheduled_for if provided
    let scheduledDate = null;
    if (scheduled_for) {
      scheduledDate = new Date(scheduled_for);
      if (isNaN(scheduledDate.getTime())) return res.status(400).json({ error:'Fecha programada inválida' });
      const now = new Date();
      const minTime = new Date(now.getTime() + 30 * 60000); // minimum 30 min from now
      const maxTime = new Date(now.getTime() + 7 * 24 * 3600000); // maximum 7 days ahead
      if (scheduledDate < minTime) return res.status(400).json({ error:'La hora programada debe ser al menos 30 minutos desde ahora' });
      if (scheduledDate > maxTime) return res.status(400).json({ error:'No se puede programar a más de 7 días' });
    }

    const biz = await q1('SELECT * FROM businesses WHERE id=$1',[business_id]);
    if (!biz) return res.status(404).json({ error:'Negocio no encontrado' });
    if (!biz.is_open && !scheduledDate) return res.status(400).json({ error:'Este negocio está cerrado. Podés programar tu pedido para más tarde.' });
    // Verificar que el negocio tenga suscripción activa
    const sub = await q1("SELECT status FROM subscriptions WHERE business_id=$1",[business_id]);
    if (sub && sub.status === 'past_due') return res.status(400).json({ error:'Este negocio no está disponible en este momento.' });
    let subtotal = 0; const lineItems = []; const priceChanges = [];
    for (const item of items) {
      const p = await q1('SELECT * FROM products WHERE id=$1 AND business_id=$2 AND is_available=TRUE',[item.product_id,business_id]);
      if (!p) return res.status(400).json({ error:'Producto no disponible' });
      const qty = Math.max(1, Math.floor(parseInt(item.quantity)||1)); // NEVER negative or zero
      if (qty > 99) return res.status(400).json({ error:'Cantidad máxima por producto: 99' });
      // Atomic stock check
      if (p.stock !== null && p.stock !== undefined && qty > p.stock) {
        return res.status(400).json({ error:`Stock insuficiente para "${p.name}". Disponible: ${p.stock}` });
      }
      let unitPrice = p.price; let variantLabel = '';
      if (item.variant_id) {
        const v = await q1('SELECT * FROM product_variants WHERE id=$1 AND product_id=$2',[item.variant_id,p.id]);
        if (v) { unitPrice += v.price_delta; variantLabel = `${v.group_name}: ${v.option_name}`; }
      }
      // Detectar cambio de precio respecto al carrito del cliente
      if (item.client_price != null && Math.abs(parseFloat(item.client_price) - unitPrice) > 0.01) {
        priceChanges.push({ name: p.name, old: parseFloat(item.client_price), new: unitPrice });
      }
      subtotal += unitPrice * qty;
      lineItems.push({ ...p, quantity:qty, unit_price:unitPrice, variant_label:variantLabel });
    }
    // Si hubo cambios de precio, rechazar y devolver los cambios para que el cliente confirme
    if (priceChanges.length > 0 && !req.body.price_changes_confirmed) {
      return res.status(409).json({
        error: 'Los precios de algunos productos cambiaron. Revisá tu carrito.',
        price_changes: priceChanges,
        code: 'PRICE_CHANGED'
      });
    }
    const _ubp = await q1('SELECT blow_plus, blow_plus_expires FROM users WHERE id=$1',[req.user.id]);
    const userBP = _ubp && _ubp.blow_plus && (!_ubp.blow_plus_expires || new Date(_ubp.blow_plus_expires) > new Date());
    const fulfillment_type = ['delivery','pickup'].includes(req.body.fulfillment_type) ? req.body.fulfillment_type : 'delivery';
    const baseFee = fulfillment_type === 'pickup' ? 0 : (biz.custom_delivery_cost ?? biz.delivery_cost ?? 0);
    const fee = (userBP && biz.blow_plus_free_delivery && fulfillment_type === 'delivery') ? 0 : baseFee;
    const priorityPct = (biz.priority_percent != null ? parseInt(biz.priority_percent) : 50) / 100;
    const priorityFee = priority ? Math.round(fee * priorityPct) : 0;
    const tipAmt = Math.min(Math.max(0, parseFloat(tip) || 0), 5000); // NEVER negative, max $5000

    // ── Apply coupon/promo discount server-side ──
    let discountAmt = 0;
    let appliedCouponId = null;
    if (coupon_code && typeof coupon_code === 'string' && coupon_code.trim()) {
      const c = await q1('SELECT * FROM coupons WHERE LOWER(code)=LOWER($1) AND active=TRUE AND (expires_at IS NULL OR expires_at > NOW())', [coupon_code.trim()]);
      if (c) {
        const meetsMin = !c.min_order || subtotal >= parseFloat(c.min_order);
        const hasUses = !c.max_uses || (c.uses_count || 0) < c.max_uses;
        const userUsed = await q1('SELECT COUNT(*) as cnt FROM coupon_uses WHERE coupon_id=$1 AND user_id=$2', [c.id, req.user.id]);
        const perUserOk = !c.per_user || parseInt(userUsed?.cnt || 0) < c.per_user;
        if (meetsMin && hasUses && perUserOk) {
          discountAmt = c.discount_type === 'percent'
            ? Math.round(subtotal * parseFloat(c.discount_value) / 100)
            : Math.min(parseFloat(c.discount_value), subtotal);
          appliedCouponId = c.id;
        }
      }
    }

    const total = Math.max(0, subtotal + fee + priorityFee + tipAmt - discountAmt);
    const _fee = await getPlatformFee();
    const plat = parseFloat((subtotal*_fee).toFixed(2)), bizAmt = Math.max(0, parseFloat((subtotal-plat).toFixed(2)));
    const orderId = uuid();
    const cust = await q1('SELECT * FROM users WHERE id=$1',[req.user.id]);
    // All orders start as 'pending' until payment is confirmed
    // Cash orders go to 'paid' immediately (owner still needs to accept)
    const initialStatus = payment_method === 'cash' ? 'paid' : 'pending';
    await q(`INSERT INTO orders (id,customer_id,business_id,status,subtotal,delivery_fee,total,address,business_amount,delivery_amount,platform_amount,fulfillment_type,tip,priority,priority_fee,payment_method,notes,scheduled_for) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
      [orderId,req.user.id,business_id,initialStatus,subtotal,fee,total,(address||cust.address||'').slice(0,500),bizAmt,fee,plat,fulfillment_type,tipAmt,Boolean(priority),priorityFee,payment_method,(notes||'').slice(0,500),scheduledDate?scheduledDate.toISOString():null]);
    for (const i of lineItems) {
      const n = i.variant_label ? `${i.name} (${i.variant_label})` : i.name;
      await q('INSERT INTO order_items (id,order_id,product_id,name,emoji,price,quantity) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [uuid(),orderId,i.id,n,i.emoji||'🍽️',i.unit_price,i.quantity]);
      // Atomic stock decrement (race-safe: uses WHERE stock >= qty)
      if (i.stock !== null && i.stock !== undefined) {
        const result = await q('UPDATE products SET stock = stock - $1, is_available = (stock - $1 > 0) WHERE id=$2 AND stock >= $1 RETURNING stock',
          [i.quantity, i.id]);
        if (!result || !result.length) {
          // Stock was insufficient (concurrent order took it) — cancel this order
          await q("UPDATE orders SET status='cancelled', cancel_reason='Stock agotado durante el procesamiento', cancelled_at=NOW() WHERE id=$1", [orderId]);
          // Restore stock for items already decremented
          for (const prev of lineItems.slice(0, lineItems.indexOf(i))) {
            if (prev.stock !== null && prev.stock !== undefined) {
              await q('UPDATE products SET stock = stock + $1, is_available = TRUE WHERE id=$2 AND stock IS NOT NULL', [prev.quantity, prev.id]);
            }
          }
          return res.status(400).json({ error:`Lo sentimos, "${i.name}" se agotó mientras procesábamos tu pedido.` });
        }
      }
    }
    // Record coupon use if applied
    if (appliedCouponId) {
      // Atómico: INSERT + UPDATE en una sola operación para evitar race conditions
      await q('INSERT INTO coupon_uses (id,coupon_id,user_id,order_id) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING', [uuid(), appliedCouponId, req.user.id, orderId]);
      await q('UPDATE coupons SET uses_count = uses_count + 1 WHERE id=$1 AND (max_uses IS NULL OR uses_count < max_uses)', [appliedCouponId]);
    }

    // ── Helper: notify owner about new paid order ──
    async function notifyOwnerNewOrder() {
      const schedLabel = scheduledDate ? ` · 📅 Programado para ${scheduledDate.toLocaleString('es-UY',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'})}` : '';
      const schedTag = scheduledDate ? '📅 ' : '';
      notify(biz.owner_id,{ type:'new_order',message:`🔔 ${schedTag}Nuevo pedido #${orderId.slice(-6).toUpperCase()} — $${total}${schedLabel}`,order_id:orderId,total });
      sendPushToOwner(biz.owner_id,{ title:`${schedTag}${payment_method==='cash'?'💵':'💳'} Nuevo pedido — Aceptar o rechazar`, body:`#${orderId.slice(-6).toUpperCase()} — $${total}${payment_method==='cash'?' · Efectivo':''}${schedLabel}`, tag:'new_order', url:'/' });
      const ownerUser = await q1('SELECT email,name FROM users WHERE id=$1', [biz.owner_id]);
      if (ownerUser?.email) {
        const itemsList = lineItems.map(i => `${i.quantity}× ${i.name} — $${i.unit_price * i.quantity}`).join('<br>');
        const schedHtml = scheduledDate ? `<div style="background:#eff6ff;border:1.5px solid #93c5fd;border-radius:10px;padding:12px;margin:12px 0;text-align:center;"><span style="font-size:14px;font-weight:800;color:#1d4ed8;">📅 PEDIDO PROGRAMADO</span><br><span style="font-size:18px;font-weight:900;color:#1e40af;">${scheduledDate.toLocaleString('es-UY',{weekday:'long',day:'numeric',month:'long',hour:'2-digit',minute:'2-digit'})}</span></div>` : '';
        sendEmail(ownerUser.email, `🔔 ${schedTag}Nuevo pedido #${orderId.slice(-6).toUpperCase()} — $${total}`,
          `<div style="font-family:sans-serif;max-width:500px;margin:0 auto;">
            <h2 style="color:#ea356b;">🔔 Nuevo pedido en ${escHtml(biz.name)}</h2>
            ${schedHtml}
            <p><strong>#${orderId.slice(-6).toUpperCase()}</strong> · ${payment_method==='cash'?'💵 Efectivo':'💳 MercadoPago'} · $${total}</p>
            <p>👤 ${escHtml(cust.name||'Cliente')}${cust.phone?' · 📞 '+escHtml(cust.phone):''}</p>
            ${address?'<p>📍 '+escHtml(address)+'</p>':''}
            ${notes?'<p>📝 '+escHtml(notes)+'</p>':''}
            <hr style="border:none;border-top:1px solid #eee;margin:16px 0;">
            <p>${itemsList}</p>
            <p style="color:#ea356b;font-weight:700;font-size:14px;margin-top:16px;">⚡ Abrí tu panel de Blow para aceptar o rechazar este pedido.</p>
          </div>`
        ).catch(() => {});
      }
    }

    // Pedido en efectivo → pago inmediato, notificar al owner para que acepte/rechace
    if (payment_method === 'cash') {
      await notifyOwnerNewOrder();
      notify(req.user.id,{ type:'status_change',message:'⏳ Pedido enviado — esperando confirmación del local',status:'paid',order_id:orderId });
      return res.json({ order_id:orderId, cash:true });
    }

    if (mp && process.env.MP_ACCESS_TOKEN && process.env.MP_ACCESS_TOKEN.startsWith('APP_USR-')) {
      const mpItems = lineItems.map(i=>({ title:i.name,quantity:i.quantity,unit_price:i.unit_price,currency_id:'UYU' }));
      if (fee > 0) mpItems.push({ title:'Costo de envío',quantity:1,unit_price:fee,currency_id:'UYU' });
      if (tipAmt > 0) mpItems.push({ title:'Propina para el repartidor',quantity:1,unit_price:tipAmt,currency_id:'UYU' });
      if (priorityFee > 0) mpItems.push({ title:'Envío prioritario',quantity:1,unit_price:priorityFee,currency_id:'UYU' });
      if (discountAmt > 0) mpItems.push({ title:'Descuento cupón',quantity:1,unit_price:-discountAmt,currency_id:'UYU' });
      const pref = await mp.preferences.create({
        items: mpItems,
        payer: { name:cust.name,email:cust.email },
        external_reference: orderId,
        back_urls:{ success:`${APP_URL}/?payment=success&order_id=${orderId}`,failure:`${APP_URL}/?payment=failure&order_id=${orderId}`,pending:`${APP_URL}/?payment=pending&order_id=${orderId}` },
        auto_return:'approved',
        notification_url:`${APP_URL}/api/webhooks/mp`,
      });
      res.json({ order_id:orderId,payment:{ id:pref.body.id,init_point:pref.body.init_point } });
    } else {
      // Demo mode (MP not configured): mark as paid, owner still needs to accept
      await q(`UPDATE orders SET status='paid',updated_at=NOW() WHERE id=$1`,[orderId]);
      await notifyOwnerNewOrder();
      notify(req.user.id,{ type:'status_change',message:'⏳ Pedido enviado — esperando confirmación del local',status:'paid',order_id:orderId });
      res.json({ order_id:orderId,demo:true });
    }
  } catch(e) { console.error(e); res.status(500).json({ error:'Error interno. Intentá de nuevo.' }); }
});

app.get('/api/orders', auth, async (req, res) => {
  try {
    let orders;
    if (req.user.role==='customer') orders=await qa(
      `SELECT o.*,b.name as business_name,b.logo_emoji,b.logo_url,b.delivery_time as business_delivery_time
       FROM orders o JOIN businesses b ON o.business_id=b.id
       WHERE o.customer_id=$1
       ORDER BY
         CASE WHEN o.status NOT IN ('delivered','cancelled','rejected') THEN 0 ELSE 1 END,
         o.created_at DESC
       LIMIT 50`,
      [req.user.id]);
    else if (req.user.role==='delivery') orders=await qa(`SELECT o.*,b.name as business_name,b.address as business_address,u.name as customer_name,u.phone as customer_phone FROM orders o JOIN businesses b ON o.business_id=b.id JOIN users u ON o.customer_id=u.id WHERE o.status IN ('ready','on_way') OR o.delivery_id=$1 ORDER BY o.created_at DESC`,[req.user.id]);
    else if (req.user.role==='owner') {
      const biz = await q1('SELECT id FROM businesses WHERE owner_id=$1',[req.user.id]);
      if (!biz) { orders = []; }
      else orders=await qa(`SELECT o.*,b.name as business_name,u.name as customer_name,u.phone as customer_phone FROM orders o JOIN businesses b ON o.business_id=b.id JOIN users u ON o.customer_id=u.id WHERE o.business_id=$1 ORDER BY CASE WHEN o.status NOT IN ('delivered','cancelled','rejected') THEN 0 ELSE 1 END, o.created_at DESC LIMIT 100`,[biz.id]);
    }
    else orders=await qa('SELECT o.*,b.name as business_name FROM orders o JOIN businesses b ON o.business_id=b.id ORDER BY o.created_at DESC LIMIT 100',[]);
    if (!orders.length) return res.json([]);
    const ids = orders.map(o=>o.id);
    const allItems = await qa('SELECT * FROM order_items WHERE order_id = ANY($1)', [ids]);
    const byOrder = {};
    for (const it of allItems) { if (!byOrder[it.order_id]) byOrder[it.order_id]=[]; byOrder[it.order_id].push(it); }
    res.json(orders.map(o=>({...o, items: byOrder[o.id]||[]})));
  } catch(e) { console.error('orders GET error:', e.message); res.status(500).json({ error:'Error interno. Intentá de nuevo.' }); }
});

app.get('/api/orders/:id', auth, async (req, res) => {
  try {
    const o=await q1('SELECT o.*,b.name as business_name,b.address as business_address,b.logo_emoji,b.logo_url,u.name as customer_name,u.phone as customer_phone FROM orders o JOIN businesses b ON o.business_id=b.id JOIN users u ON o.customer_id=u.id WHERE o.id=$1',[req.params.id]);
    if (!o) return res.status(404).json({ error:'Pedido no encontrado' });
    // Solo el cliente dueño del pedido, el owner del negocio, delivery asignado o admin pueden verlo
    const isOwner   = req.user.role === 'owner';
    const isAdmin   = req.user.role === 'admin';
    const isDelivery = req.user.role === 'delivery' && o.delivery_id === req.user.id;
    const isCustomer = o.customer_id === req.user.id;
    if (!isAdmin && !isCustomer && !isDelivery) {
      if (isOwner) {
        const biz = await q1('SELECT id FROM businesses WHERE owner_id=$1 AND id=$2',[req.user.id, o.business_id]);
        if (!biz) return res.status(403).json({ error:'No autorizado' });
      } else {
        return res.status(403).json({ error:'No autorizado' });
      }
    }
    o.items=await qa('SELECT * FROM order_items WHERE order_id=$1',[o.id]);
    res.json(o);
  } catch(e) { console.error('orders/:id GET error:', e.message); res.status(500).json({ error:'Error interno. Intentá de nuevo.' }); }
});

app.patch('/api/orders/:id/status', auth, async (req, res) => {
  try {
    const { status } = req.body;
    const order=await q1('SELECT * FROM orders WHERE id=$1',[req.params.id]);
    if (!order) return res.status(404).json({ error:'Pedido no encontrado' });

    // ── Validación de ownership PRIMERO (no filtrar por rol después) ──
    if (req.user.role === 'owner') {
      const b = await q1('SELECT id FROM businesses WHERE owner_id=$1', [req.user.id]);
      if (!b || b.id !== order.business_id) return res.status(403).json({ error:'No autorizado' });
    } else if (req.user.role === 'delivery') {
      // Solo puede actuar sobre pedidos que le fueron asignados, o pedidos ready sin asignar de su zona
      if (order.delivery_id && order.delivery_id !== req.user.id) return res.status(403).json({ error:'No autorizado' });
    } else if (req.user.role !== 'admin') {
      return res.status(403).json({ error:'No autorizado' });
    }

    const allowed={
      owner:{    paid:'confirmed', confirmed:'preparing', preparing:'ready', ready:'on_way', on_way:'delivered' },
      delivery:{ ready:'on_way', on_way:'delivered' },
      admin:{    paid:'confirmed', pending:'confirmed', confirmed:'preparing', preparing:'ready', ready:'on_way', on_way:'delivered' }
    };
    const ra = allowed[req.user.role];
    // owner puede marcar delivered desde ready (cuando maneja su propio delivery)
    const ownerDirectDelivery = req.user.role === 'owner' && order.status === 'ready' && status === 'delivered';
    if (!ra || (ra[order.status] !== status && !ownerDirectDelivery)) {
      return res.status(400).json({ error:`No podés cambiar de ${order.status} a ${status}` });
    }
    const oldStatus = order.status;
    const updated = await q('UPDATE orders SET status=$1,updated_at=NOW() WHERE id=$2 AND status=$3 RETURNING id',[status,order.id,oldStatus]);
    if (!updated || !updated.length) return res.status(409).json({ error:'El pedido cambió de estado mientras procesabas. Actualizá y reintentá.' });
    // Si el owner confirma, guardar tiempo estimado de entrega
    if (status === 'confirmed' && req.body.estimated_minutes) {
      const mins = parseInt(req.body.estimated_minutes);
      if (mins > 0 && mins <= 240) {
        await q('UPDATE orders SET estimated_ready_at=NOW()+($1::int * INTERVAL \'1 minute\') WHERE id=$2', [mins, order.id]);
      }
    }
    if (status==='on_way') await q('UPDATE orders SET delivery_id=$1 WHERE id=$2',[req.user.id,order.id]);
    if (status==='delivered') {
      // Guard against double-credit: only proceed if not already marked delivered
      const already = await q1('SELECT delivered_at FROM orders WHERE id=$1 AND delivered_at IS NOT NULL', [order.id]);
      if (already) return res.status(400).json({ error:'Este pedido ya fue marcado como entregado' });
      await q('UPDATE orders SET delivered_at=NOW() WHERE id=$1',[order.id]);
      // Si el delivery_id es el owner del negocio (maneja su propio delivery), acreditar también el delivery_amount al negocio
      const deliveryBiz = await q1('SELECT id, owner_id FROM businesses WHERE id=$1',[order.business_id]);
      const ownerHandledDelivery = !order.delivery_id || (deliveryBiz && order.delivery_id === deliveryBiz.owner_id);
      if (ownerHandledDelivery) {
        // Todo va al negocio: subtotal + delivery - comisión plataforma
        await credit(order.business_id,'business', parseFloat((order.business_amount + (order.delivery_amount||0)).toFixed(2)), `Pedido #${order.id.slice(-6).toUpperCase()}`, order.id);
      } else {
        await credit(order.business_id,'business',order.business_amount,`Pedido #${order.id.slice(-6).toUpperCase()}`,order.id);
        await credit(order.delivery_id,'delivery',order.delivery_amount,`Delivery #${order.id.slice(-6).toUpperCase()}`,order.id);
      }
      await credit('platform','platform',order.platform_amount,`Comisión #${order.id.slice(-6).toUpperCase()}`,order.id);
    }
    // Push al cliente con mensaje según estado
    const PUSH_MSG = {
      confirmed:  { title:'✅ Pedido confirmado',       body:`Tu pedido #${order.id.slice(-6).toUpperCase()} fue aceptado por el local.` },
      preparing:  { title:'👨‍🍳 Estamos preparando tu pedido', body:`#${order.id.slice(-6).toUpperCase()} está en preparación.` },
      ready:      { title:'🟢 ¡Tu pedido está listo!',  body:`#${order.id.slice(-6).toUpperCase()} listo para ser retirado/entregado.` },
      on_way:     { title:'🛵 Tu pedido está en camino', body:`#${order.id.slice(-6).toUpperCase()} ya salió hacia tu dirección.` },
      delivered:  { title:'🎉 ¡Pedido entregado!',      body:`#${order.id.slice(-6).toUpperCase()} fue entregado. ¡Buen provecho!` },
    };
    const pushMsg = PUSH_MSG[status];
    if (pushMsg) sendPushToUser(order.customer_id, { ...pushMsg, tag: `order-${order.id}`, url: '/?tab=tracking' });
    notify(order.customer_id,{ type:'status_change',message:`Tu pedido: ${status}`,status,order_id:order.id });
    const biz=await q1('SELECT owner_id,name FROM businesses WHERE id=$1',[order.business_id]);
    if (biz) notify(biz.owner_id,{ type:'order_update',status,order_id:order.id });
    // Send email notification to customer (fire-and-forget)
    sendOrderStatusEmail(order, status, biz?.name).catch(() => {});
    res.json(await q1('SELECT * FROM orders WHERE id=$1',[order.id]));
  } catch(e) { console.error('orders/status PATCH error:', e.message); res.status(500).json({ error:'Error interno. Intentá de nuevo.' }); }
});

app.patch('/api/orders/:id/internal-notes', auth, async (req, res) => {
  try {
    const { internal_notes } = req.body;
    if (typeof internal_notes !== 'string' || !internal_notes.trim()) return res.status(400).json({ error:'La nota no puede estar vacía' });
    const order = await q1('SELECT * FROM orders WHERE id=$1', [req.params.id]);
    if (!order) return res.status(404).json({ error:'Pedido no encontrado' });
    // Solo el owner del negocio o admin
    if (req.user.role === 'owner') {
      const biz = await q1('SELECT id FROM businesses WHERE owner_id=$1 AND id=$2', [req.user.id, order.business_id]);
      if (!biz) return res.status(403).json({ error:'No autorizado' });
    } else if (req.user.role !== 'admin') {
      return res.status(403).json({ error:'No autorizado' });
    }
    // Acumular notas con timestamp en lugar de pisar
    const newNote = internal_notes.trim();
    const existing = order.internal_notes || '';
    const now = new Date().toLocaleString('es-UY', { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' });
    const appended = existing ? `${existing}\n[${now}] ${newNote}` : `[${now}] ${newNote}`;
    await q('UPDATE orders SET internal_notes=$1, updated_at=NOW() WHERE id=$2', [appended, order.id]);
    res.json({ ok: true, internal_notes: appended });
  } catch(e) { res.status(500).json({ error: 'Error al guardar nota.' }); }
});

app.post('/api/orders/:id/cancel', auth, async (req, res) => {
  const order=await q1('SELECT * FROM orders WHERE id=$1',[req.params.id]);
  if (!order) return res.status(404).json({ error:'No encontrado' });

  // Validación de ownership y estados permitidos por rol
  if (req.user.role === 'customer') {
    if (order.customer_id !== req.user.id) return res.status(403).json({ error:'No autorizado' });
    // Cliente solo puede cancelar si todavía no fue aceptado por el negocio
    if (!['pending','paid'].includes(order.status)) {
      return res.status(400).json({ error:'No podés cancelar un pedido que ya fue aceptado por el negocio. Contactá al local.' });
    }
  } else if (req.user.role === 'owner') {
    const b = await q1('SELECT id FROM businesses WHERE owner_id=$1', [req.user.id]);
    if (!b || b.id !== order.business_id) return res.status(403).json({ error:'No autorizado' });
    // Owner puede cancelar hasta que esté en camino
    if (!['paid','confirmed'].includes(order.status)) {
      return res.status(400).json({ error:'No se puede cancelar en este estado' });
    }
  } else if (req.user.role !== 'admin') {
    return res.status(403).json({ error:'No autorizado' });
  }

  await q("UPDATE orders SET status='cancelled', cancel_reason=COALESCE($1,''), cancelled_at=NOW(), updated_at=NOW() WHERE id=$2", [req.body.reason||'', order.id]);

  // Restore stock for cancelled items
  const items = await qa('SELECT product_id, quantity FROM order_items WHERE order_id=$1', [order.id]);
  for (const item of items) {
    await q('UPDATE products SET stock = stock + $1, is_available = TRUE WHERE id=$2 AND stock IS NOT NULL', [item.quantity, item.product_id]);
  }

  // ── Reembolso automático MP si el pedido fue pagado con MP ──
  let refundResult = null;
  if (mp && order.mp_payment_id && order.payment_method === 'mercadopago' && ['paid','confirmed'].includes(order.status)) {
    try {
      const refund = await mp.payment.refund(order.mp_payment_id);
      refundResult = { status: refund.body?.status || 'processed', id: refund.body?.id };
      await q("UPDATE orders SET internal_notes=COALESCE(internal_notes,'')||$1 WHERE id=$2",
        [`\n[AUTO] Reembolso MP por cancelación: ${JSON.stringify(refundResult)}`, order.id]);
      console.log(`💸 Refund on cancel for order ${order.id}: ${JSON.stringify(refundResult)}`);
    } catch(refundErr) {
      console.error(`❌ Refund failed on cancel for order ${order.id}:`, refundErr.message);
      await q("UPDATE orders SET internal_notes=COALESCE(internal_notes,'')||$1 WHERE id=$2",
        [`\n[ERROR] Reembolso MP falló al cancelar: ${refundErr.message}`, order.id]);
      refundResult = { error: refundErr.message };
    }
  }

  const biz=await q1('SELECT owner_id,name FROM businesses WHERE id=$1',[order.business_id]);
  const reasonText = req.body.reason ? ` Motivo: "${req.body.reason}"` : '';
  const refundMsg = order.payment_method === 'mercadopago' && ['paid','confirmed'].includes(order.status)
    ? ' El reembolso se procesará automáticamente.' : '';

  if (biz) {
    notify(biz.owner_id,{ type:'order_cancelled', message:`❌ Pedido #${order.id.slice(-6).toUpperCase()} cancelado${reasonText}`, order_id:order.id });
    sendPushToOwner(biz.owner_id,{ title:'❌ Pedido cancelado', body:`#${order.id.slice(-6).toUpperCase()} fue cancelado.${reasonText}`, tag:`order-${order.id}`, url:'/' });
  }

  // Notificar al cliente si cancela el owner o admin
  if (req.user.role === 'owner' || req.user.role === 'admin') {
    notify(order.customer_id,{ type:'order_cancelled', message:`❌ Tu pedido #${order.id.slice(-6).toUpperCase()} fue cancelado por el local.${reasonText}${refundMsg}`, order_id:order.id });
    sendPushToUser(order.customer_id,{ title:'❌ Tu pedido fue cancelado', body:`#${order.id.slice(-6).toUpperCase()} fue cancelado por el local.${refundMsg}`, tag:`order-${order.id}`, url:'/?tab=tracking' });
  } else {
    // Cliente canceló — notificar al owner con info de reembolso
    if (biz) notify(biz.owner_id,{ type:'order_cancelled', message:`❌ El cliente canceló el pedido #${order.id.slice(-6).toUpperCase()}.${refundMsg}`, order_id:order.id });
  }

  // Email notification
  sendOrderStatusEmail(order, 'cancelled', biz?.name).catch(() => {});
  res.json({ success:true, refund: refundResult });
});

// ═══════════════════════════════════════════════
//  RECHAZAR PEDIDO (owner) — Reembolso automático
// ═══════════════════════════════════════════════
app.post('/api/orders/:id/reject', auth, role('owner'), async (req, res) => {
  try {
    const { reason } = req.body;
    const order = await q1('SELECT * FROM orders WHERE id=$1', [req.params.id]);
    if (!order) return res.status(404).json({ error:'Pedido no encontrado' });
    
    // Solo se puede rechazar un pedido pagado (no confirmado ni en preparación)
    if (order.status !== 'paid') {
      return res.status(400).json({ error:`No se puede rechazar un pedido en estado "${order.status}". Solo se pueden rechazar pedidos pagados pendientes de aceptación.` });
    }
    
    // Verify ownership
    const b = await q1('SELECT id,name FROM businesses WHERE owner_id=$1', [req.user.id]);
    if (!b || b.id !== order.business_id) return res.status(403).json({ error:'No autorizado' });
    
    // Update order status to rejected
    await q("UPDATE orders SET status='rejected', cancel_reason=$1, cancelled_at=NOW(), updated_at=NOW() WHERE id=$2",
      [reason || 'Rechazado por el negocio', req.params.id]);
    
    // Restore stock
    const items = await qa('SELECT product_id, quantity FROM order_items WHERE order_id=$1', [order.id]);
    for (const item of items) {
      await q('UPDATE products SET stock = stock + $1, is_available = TRUE WHERE id=$2 AND stock IS NOT NULL', [item.quantity, item.product_id]);
    }
    
    // ── Automatic MP refund ──
    let refundResult = null;
    if (mp && order.mp_payment_id && order.payment_method === 'mercadopago') {
      try {
        const refund = await mp.payment.refund(order.mp_payment_id);
        refundResult = { status: refund.body?.status || 'processed', id: refund.body?.id };
        await q('UPDATE orders SET internal_notes=COALESCE(internal_notes,$$||$$)||$1 WHERE id=$2',
          [`\n[AUTO] Reembolso MP: ${JSON.stringify(refundResult)}`, order.id]);
        console.log(`💸 Refund processed for order ${order.id}: ${JSON.stringify(refundResult)}`);
      } catch(refundErr) {
        console.error(`❌ Refund failed for order ${order.id}:`, refundErr.message);
        await q('UPDATE orders SET internal_notes=COALESCE(internal_notes,$$||$$)||$1 WHERE id=$2',
          [`\n[ERROR] Reembolso MP falló: ${refundErr.message}`, order.id]);
        refundResult = { error: refundErr.message };
      }
    }
    
    // Notify customer
    const reasonText = reason ? ` Motivo: "${reason}"` : '';
    const refundMsg = order.payment_method === 'mercadopago'
      ? ' El reembolso se procesará automáticamente en tu medio de pago.'
      : '';
    notify(order.customer_id, {
      type: 'order_cancelled',
      message: `❌ Tu pedido #${order.id.slice(-6).toUpperCase()} fue rechazado por el local.${reasonText}${refundMsg}`,
      order_id: order.id
    });
    sendPushToUser(order.customer_id, {
      title: '❌ Pedido rechazado',
      body: `#${order.id.slice(-6).toUpperCase()} fue rechazado por ${b.name}.${refundMsg}`,
      tag: `order-${order.id}`,
      url: '/?tab=tracking'
    });
    
    // Email to customer
    sendOrderStatusEmail(order, 'cancelled', b.name).catch(() => {});
    
    res.json({ success: true, refund: refundResult });
  } catch(e) {
    console.error('Reject order error:', e.message);
    res.status(500).json({ error: 'Error al rechazar pedido.' });
  }
});

// ════════════════════════════════════════════════
//  RESEÑAS
// ════════════════════════════════════════════════
// Cliente deja reseña (solo en pedidos entregados)
app.post('/api/orders/:id/review', auth, async (req, res) => {
  const { rating, comment } = req.body;
  if (!rating || rating < 1 || rating > 5) return res.status(400).json({ error:'Rating inválido' });
  const order = await q1('SELECT * FROM orders WHERE id=$1 AND customer_id=$2', [req.params.id, req.user.id]);
  if (!order) return res.status(404).json({ error:'Pedido no encontrado' });
  if (order.status !== 'delivered') return res.status(400).json({ error:'Solo podés reseñar pedidos entregados' });
  const existing = await q1('SELECT id FROM reviews WHERE order_id=$1', [req.params.id]);
  if (existing) return res.status(400).json({ error:'Ya dejaste una reseña para este pedido' });
  const review = await q1(
    `INSERT INTO reviews (id,order_id,business_id,customer_id,rating,comment) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [uuid(), req.params.id, order.business_id, req.user.id, parseInt(rating), (comment||'').trim().slice(0,500)]
  );
  // Update business average rating and count
  const avg = await q1('SELECT AVG(rating) as avg, COUNT(*) as cnt FROM reviews WHERE business_id=$1', [order.business_id]);
  await q('UPDATE businesses SET rating=$1, rating_count=$2 WHERE id=$3', [
    Math.round(parseFloat(avg.avg)*10)/10,
    parseInt(avg.cnt),
    order.business_id
  ]);
  res.json(review);
});

// Owner responde reseña
app.patch('/api/reviews/:id/reply', auth, role('owner'), async (req, res) => {
  const { reply } = req.body;
  if (!reply?.trim()) return res.status(400).json({ error:'Respuesta vacía' });
  const biz = await q1('SELECT id FROM businesses WHERE owner_id=$1', [req.user.id]);
  if (!biz) return res.status(404).json({ error:'Sin negocio' });
  const review = await q1('SELECT * FROM reviews WHERE id=$1 AND business_id=$2', [req.params.id, biz.id]);
  if (!review) return res.status(404).json({ error:'Reseña no encontrada' });
  const updated = await q1(
    `UPDATE reviews SET owner_reply=$1, owner_replied_at=NOW() WHERE id=$2 RETURNING *`,
    [reply.trim().slice(0,500), req.params.id]
  );
  res.json(updated);
});

// Ver reseñas de un negocio (público)
app.get('/api/businesses/:id/reviews', async (req, res) => {
  try {
    const reviews = await qa(
      `SELECT r.id, r.rating, r.comment, r.owner_reply, r.owner_replied_at, r.created_at, u.name as customer_name
       FROM reviews r JOIN users u ON u.id=r.customer_id WHERE r.business_id=$1 ORDER BY r.created_at DESC LIMIT 30`,
      [req.params.id]
    );
    res.json(reviews);
  } catch(e) { res.status(500).json({ error:'Error al cargar reseñas.' }); }
});

// Owner ve sus reseñas
app.get('/api/businesses/mine/reviews', auth, role('owner'), async (req, res) => {
  try {
    const biz = await q1('SELECT id FROM businesses WHERE owner_id=$1', [req.user.id]);
    if (!biz) return res.status(404).json({ error:'Sin negocio' });
    const reviews = await qa(
      `SELECT r.*, u.name as customer_name FROM reviews r JOIN users u ON u.id=r.customer_id WHERE r.business_id=$1 ORDER BY r.created_at DESC`,
      [biz.id]
    );
    res.json(reviews);
  } catch(e) { console.error('businesses/mine/reviews GET error:', e.message); res.status(500).json({ error:'Error interno. Intentá de nuevo.' }); }
});

// ════════════════════════════════════════════════
//  CHAT DE PEDIDO
// ════════════════════════════════════════════════
app.get('/api/orders/:id/messages', auth, async (req, res) => {
  try {
    const order = await q1('SELECT * FROM orders WHERE id=$1', [req.params.id]);
    if (!order) return res.status(404).json({ error:'Pedido no encontrado' });
    // Solo el customer o el owner del negocio pueden ver el chat
    if (req.user.role === 'customer' && order.customer_id !== req.user.id)
      return res.status(403).json({ error:'No autorizado' });
    if (req.user.role === 'owner') {
      const biz = await q1('SELECT id FROM businesses WHERE owner_id=$1', [req.user.id]);
      if (!biz || biz.id !== order.business_id) return res.status(403).json({ error:'No autorizado' });
    }
    const msgs = await qa(
      `SELECT m.*, u.name as sender_name FROM order_messages m JOIN users u ON u.id=m.sender_id WHERE m.order_id=$1 ORDER BY m.created_at ASC`,
      [req.params.id]
    );
    // Marcar como vistos los mensajes del otro lado
    await q(`UPDATE order_messages SET seen=TRUE WHERE order_id=$1 AND sender_id!=$2 AND seen=FALSE`,
      [req.params.id, req.user.id]);
    res.json(msgs);
  } catch(e) { console.error('orders/messages GET error:', e.message); res.status(500).json({ error:'Error interno. Intentá de nuevo.' }); }
});

// Rate limit: max 10 chat messages per minute per user
const _chatRateMap = new Map();
app.post('/api/orders/:id/messages', auth, async (req, res) => {
  try {
    // Rate limit check
    const now = Date.now();
    const key = `chat_${req.user.id}`;
    const history = _chatRateMap.get(key) || [];
    const recent = history.filter(t => now - t < 60000); // last 60s
    if (recent.length >= 10) return res.status(429).json({ error:'Demasiados mensajes. Esperá un momento.' });
    recent.push(now);
    _chatRateMap.set(key, recent);
    // Cleanup old entries every 100 requests
    if (Math.random() < 0.01) _chatRateMap.forEach((v,k) => { if (!v.some(t => now - t < 120000)) _chatRateMap.delete(k); });

    const { body } = req.body;
    if (!body?.trim()) return res.status(400).json({ error:'Mensaje vacío' });
    const order = await q1('SELECT * FROM orders WHERE id=$1', [req.params.id]);
    if (!order) return res.status(404).json({ error:'Pedido no encontrado' });
    if (req.user.role === 'customer' && order.customer_id !== req.user.id)
      return res.status(403).json({ error:'No autorizado' });
    if (req.user.role === 'owner') {
      const biz = await q1('SELECT id FROM businesses WHERE owner_id=$1', [req.user.id]);
      if (!biz || biz.id !== order.business_id) return res.status(403).json({ error:'No autorizado' });
    }
    // Bloquear chat 48hs después de la entrega
    if (order.status === 'delivered' && order.delivered_at) {
      const hoursSinceDelivery = (Date.now() - new Date(order.delivered_at).getTime()) / 36e5;
      if (hoursSinceDelivery > 48) {
        return res.status(403).json({ error:'El chat se cierra 48hs después de la entrega' });
      }
    }
    if (order.status === 'cancelled') {
      return res.status(403).json({ error:'No se puede chatear en un pedido cancelado' });
    }
    const msg = await q1(
      `INSERT INTO order_messages (id,order_id,sender_id,sender_role,body) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [uuid(), req.params.id, req.user.id, req.user.role, body.trim().slice(0, 1000)]
    );
    // Notificar al otro lado via WS (incluye order_id para badge)
    if (req.user.role === 'customer') {
      // Notify owner (use owner_id, not business_id, since WS registers by user_id)
      const biz = await q1('SELECT owner_id, name FROM businesses WHERE id=$1', [order.business_id]);
      if (biz) {
        notify(biz.owner_id, { type:'chat_message', order_id: req.params.id, body: body.trim(), sender_role: req.user.role });
        sendPushToOwner(biz.owner_id, {
          title: `💬 Nuevo mensaje — pedido #${req.params.id.slice(-6).toUpperCase()}`,
          body: body.trim().slice(0, 80),
          tag: 'chat_' + req.params.id,
          url: '/'
        });
      }
    } else {
      // Notify customer
      notify(order.customer_id, { type:'chat_message', order_id: req.params.id, body: body.trim(), sender_role: req.user.role });
      const biz = await q1('SELECT name FROM businesses WHERE id=$1', [order.business_id]);
      sendPushToUser(order.customer_id, {
        title: `💬 ${biz?.name || 'El negocio'} te escribió`,
        body: body.trim().slice(0, 80),
        tag: 'chat_' + req.params.id,
        url: '/?tab=tracking'
      });
    }
    res.json(msg);
  } catch(e) { console.error('orders/messages POST error:', e.message); res.status(500).json({ error:'Error interno. Intentá de nuevo.' }); }
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
  } catch(e) { console.error('wallet GET error:', e.message); res.status(500).json({ error:'Error interno. Intentá de nuevo.' }); }
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
    res.status(500).json({ error: 'Error al suscribir a Blow+. Intentá de nuevo.' });
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
    res.status(500).json({ error: 'Error al suscribir a Blow+. Intentá de nuevo.' });
  }
});

// Cancel Blow+
app.post('/api/businesses/mine/blow-plus/cancel', auth, role('owner'), async (req, res) => {
  try {
    const biz = await q1('SELECT id FROM businesses WHERE owner_id=$1', [req.user.id]);
    if (!biz) return res.status(404).json({ error: 'Negocio no encontrado' });
    await q('UPDATE businesses SET blow_plus=FALSE WHERE id=$1', [biz.id]);
    res.json({ success: true, message: 'Blow+ cancelado. Seguirá activo hasta el vencimiento.' });
  } catch(e) { console.error('blow-plus/cancel owner error:', e.message); res.status(500).json({ error:'Error interno. Intentá de nuevo.' }); }
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
  } catch(e) { console.error('admin/businesses/blow-plus PATCH error:', e.message); res.status(500).json({ error:'Error interno. Intentá de nuevo.' }); }
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

// ── Broadcast novedad a todos los clientes del negocio ──
app.post('/api/businesses/mine/broadcast', auth, role('owner'), async (req, res) => {
  const { message } = req.body;
  if (!message?.trim()) return res.status(400).json({ error: 'Mensaje vacío' });
  const cleanMsg = message.trim().slice(0, 280);
  const biz = await q1('SELECT id, name, logo_emoji FROM businesses WHERE owner_id=$1', [req.user.id]);
  if (!biz) return res.status(404).json({ error: 'Negocio no encontrado' });

  // Rate limit: máx 3 broadcasts por día por negocio
  const recentBroadcasts = await q1(
    `SELECT COUNT(*) as cnt FROM transactions WHERE wallet_id IN (SELECT id FROM wallets WHERE owner_id=$1) AND description LIKE 'Broadcast%' AND created_at > NOW() - INTERVAL '24 hours'`,
    [biz.id]
  );
  // Usamos una clave en app_settings para trackear el broadcast rate
  const bcKey = `broadcast_last_${biz.id}`;
  const bcRecord = await q1('SELECT value FROM app_settings WHERE key=$1', [bcKey]);
  let bcTimes = [];
  try { bcTimes = bcRecord ? JSON.parse(bcRecord.value) : []; } catch { bcTimes = []; }
  const now = Date.now();
  bcTimes = bcTimes.filter(t => now - t < 24 * 3600000);
  if (bcTimes.length >= 3) return res.status(429).json({ error: 'Límite de novedades: máximo 3 por día.' });
  bcTimes.push(now);
  await q('INSERT INTO app_settings (key,value,updated_at) VALUES ($1,$2,NOW()) ON CONFLICT(key) DO UPDATE SET value=$2,updated_at=NOW()', [bcKey, JSON.stringify(bcTimes)]);

  // Obtener clientes únicos que hayan pedido en este negocio (máx 500)
  const customers = await qa(
    `SELECT DISTINCT o.customer_id FROM orders o
     WHERE o.business_id=$1 AND o.status NOT IN ('cancelled')
     AND o.customer_id IS NOT NULL
     LIMIT 500`,
    [biz.id]
  );

  let sent = 0;
  for (const c of customers) {
    try {
      await sendPushToUser(c.customer_id, {
        title: `${biz.logo_emoji || '🏪'} ${biz.name}`,
        body: cleanMsg,
        tag: `novedad-${biz.id}`,
        url: `/?biz=${biz.id}`
      });
      sent++;
    } catch(e) { /* continuar aunque falle uno */ }
  }

  console.log(`📣 Broadcast "${biz.name}": ${sent}/${customers.length} enviados`);
  res.json({ success: true, sent, total: customers.length, remaining: 2 - bcTimes.length + 1 });
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
  try {
    const biz = await q1('SELECT id FROM businesses WHERE owner_id=$1',[req.user.id]);
    if (!biz) return res.status(404).json({ error:'Negocio no encontrado' });
    const promos = await qa('SELECT * FROM promotions WHERE business_id=$1 ORDER BY created_at DESC',[biz.id]);
    res.json(promos.map(p => ({ ...p, combo_products: safeJson(p.combo_products, []) })));
  } catch(e) { console.error('promotions GET error:', e.message); res.status(500).json({ error:'Error interno. Intentá de nuevo.' }); }
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
    const validPromoTypes = ['percent_off','fixed_off','free_delivery','bogo','combo','category_percent'];
    if (!validPromoTypes.includes(type)) return res.status(400).json({ error:'Tipo de promoción inválido' });
    if (['percent_off','category_percent'].includes(type) && (parseFloat(value) <= 0 || parseFloat(value) > 100))
      return res.status(400).json({ error:'El porcentaje debe ser entre 1 y 100' });
    if (['fixed_off','combo'].includes(type) && parseFloat(value) <= 0)
      return res.status(400).json({ error:'El valor debe ser mayor a cero' });
    const id = 'promo-' + uuid().slice(0,8);
    await q(
      `INSERT INTO promotions (id,business_id,name,type,value,min_order_amount,category_id,combo_products,combo_price,code,requires_code,starts_at,ends_at,blow_plus_only)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [id,biz.id,name,type,value,min_order_amount,category_id,
       JSON.stringify(combo_products),combo_price,
       code||null,requires_code,starts_at||null,ends_at||null,blow_plus_only]
    );
    res.json({ success:true, id });
  } catch(e) { console.error('promotions POST error:', e.message); res.status(500).json({ error:'Error interno. Intentá de nuevo.' }); }
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
  } catch(e) { console.error('promotions PATCH error:', e.message); res.status(500).json({ error:'Error interno. Intentá de nuevo.' }); }
});

// Owner: delete promotion
app.delete('/api/businesses/mine/promotions/:id', auth, role('owner'), async (req, res) => {
  try {
    const biz = await q1('SELECT id FROM businesses WHERE owner_id=$1',[req.user.id]);
    if (!biz) return res.status(404).json({ error:'Negocio no encontrado' });
    await q('DELETE FROM promotions WHERE id=$1 AND business_id=$2',[req.params.id,biz.id]);
    res.json({ success:true });
  } catch(e) { console.error('promotions DELETE error:', e.message); res.status(500).json({ error:'Error interno. Intentá de nuevo.' }); }
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
app.get('/api/products/:id', async (req, res) => {
  const p = await getProductFull(req.params.id);
  if (!p || !p.is_available) return res.status(404).json({ error:'Producto no encontrado' });
  res.json(p);
});

app.get('/api/businesses/:id', async (req, res) => {
  try {
  const b = await q1('SELECT * FROM businesses WHERE id=$1',[req.params.id]);
  if (!b) return res.status(404).json({ error:'Negocio no encontrado' });
  // Filter products: available + respects time window if set (Uruguay UTC-3)
  const rawP = await qa(`
    SELECT * FROM products
    WHERE business_id=$1 AND is_available=TRUE
    AND (
      available_from IS NULL OR available_until IS NULL
      OR (NOW() AT TIME ZONE 'America/Montevideo')::time BETWEEN available_from AND available_until
    )
  `,[b.id]);
  // Bulk load photos and variants (avoids N+1 queries)
  const pIds = rawP.map(p => p.id);
  const allPhotos = pIds.length ? await qa('SELECT * FROM product_photos WHERE product_id = ANY($1) ORDER BY sort_order', [pIds]) : [];
  const allVariants = pIds.length ? await qa('SELECT * FROM product_variants WHERE product_id = ANY($1) ORDER BY group_name,sort_order', [pIds]) : [];
  const prods = rawP.map(p => ({
    ...p,
    photos: allPhotos.filter(ph => ph.product_id === p.id),
    variants: allVariants.filter(v => v.product_id === p.id),
  }));
  const cats = await qa('SELECT * FROM product_categories WHERE business_id=$1 ORDER BY sort_order',[b.id]);
  const { owner_id, blow_plus_mp_id, ...publicBiz } = b;
  res.json({ ...publicBiz, products:prods, categories:cats });
  } catch(e) { res.status(500).json({ error:'Error al cargar el negocio.' }); }
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
  try {
    const ownerId=req.user.role==='owner'?(await q1('SELECT id FROM businesses WHERE owner_id=$1',[req.user.id]))?.id:req.user.id;
    if (!ownerId) return res.status(404).json({ error:'Sin negocio' });
    const { amount,method,destination } = req.body;
    if (!amount || typeof amount !== 'number' || amount <= 0) return res.status(400).json({ error:'Monto inválido' });
    if (amount > 1000000) return res.status(400).json({ error:'Monto excede el límite' });
    if (!method || typeof method !== 'string' || method.length > 100) return res.status(400).json({ error:'Método inválido' });
    if (!destination || typeof destination !== 'string' || destination.length > 200) return res.status(400).json({ error:'Destino inválido' });
    // Sanitize: strip HTML tags
    const cleanMethod = method.replace(/<[^>]*>/g, '').trim();
    const cleanDest = destination.replace(/<[^>]*>/g, '').trim();
    const wallet=await getWallet(ownerId,req.user.role);
    // Atomic balance check + debit to prevent race condition (double-withdraw)
    const debitResult = await q1('UPDATE wallets SET balance=balance-$1,updated_at=NOW() WHERE id=$2 AND balance >= $1 RETURNING balance',[amount,wallet.id]);
    if (!debitResult) return res.status(400).json({ error:'Saldo insuficiente' });
    await q('INSERT INTO transactions (id,wallet_id,type,amount,description) VALUES ($1,$2,$3,$4,$5)',[uuid(),wallet.id,'debit',amount,`Retiro via ${cleanMethod}`]);
    const owner=await q1('SELECT name,email FROM users WHERE id=$1',[req.user.id]);
    await q('INSERT INTO withdrawals (id,wallet_id,owner_id,owner_name,email,amount,method,destination) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [uuid(),wallet.id,req.user.id,owner.name,owner.email||'',amount,cleanMethod,cleanDest]);
    res.json({ success:true });
  } catch(e) { console.error('wallet/withdraw error:', e.message); res.status(500).json({ error:'Error interno. Intentá de nuevo.' }); }
});

// ── Cuentas bancarias guardadas ──────────────────
app.get('/api/bank-accounts', auth, async (req, res) => {
  try {
    const accounts = await qa('SELECT * FROM bank_accounts WHERE user_id=$1 ORDER BY is_default DESC, created_at ASC', [req.user.id]);
    res.json(accounts);
  } catch(e) { console.error('bank-accounts GET error:', e.message); res.status(500).json({ error:'Error interno. Intentá de nuevo.' }); }
});
app.post('/api/bank-accounts', auth, async (req, res) => {
  try {
    const { label, method, destination, is_default } = req.body;
    if (!label||!method||!destination) return res.status(400).json({ error:'Faltan datos' });
    const count = (await q1('SELECT COUNT(*) as c FROM bank_accounts WHERE user_id=$1', [req.user.id])).c;
    if (parseInt(count) >= 3) return res.status(400).json({ error:'Máximo 3 cuentas permitidas' });
    if (is_default) await q('UPDATE bank_accounts SET is_default=FALSE WHERE user_id=$1', [req.user.id]);
    const id = uuid();
    await q('INSERT INTO bank_accounts (id,user_id,label,method,destination,is_default) VALUES ($1,$2,$3,$4,$5,$6)',
      [id, req.user.id, label, method, destination, is_default||false]);
    res.json({ success:true, id });
  } catch(e) { console.error('bank-accounts POST error:', e.message); res.status(500).json({ error:'Error interno. Intentá de nuevo.' }); }
});
app.delete('/api/bank-accounts/:id', auth, async (req, res) => {
  try {
    await q('DELETE FROM bank_accounts WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id]);
    res.json({ success:true });
  } catch(e) { console.error('bank-accounts DELETE error:', e.message); res.status(500).json({ error:'Error interno. Intentá de nuevo.' }); }
});

// ════════════════════════════════════════════════
//  FAVORITOS
// ════════════════════════════════════════════════
app.get('/api/favorites', auth, async (req, res) => {
  try {
    const favs = await qa('SELECT f.*, p.name, p.price, p.emoji, p.photo_url, p.business_id, b.name as business_name FROM favorites f LEFT JOIN products p ON p.id=f.product_id LEFT JOIN businesses b ON b.id=f.business_id WHERE f.user_id=$1 ORDER BY f.created_at DESC', [req.user.id]);
    res.json(favs);
  } catch(e) { console.error('favorites GET error:', e.message); res.status(500).json({ error:'Error interno. Intentá de nuevo.' }); }
});
app.post('/api/favorites', auth, async (req, res) => {
  try {
    const { product_id, business_id } = req.body;
    if (!product_id) return res.status(400).json({ error:'product_id requerido' });
    const existing = await q1('SELECT id FROM favorites WHERE user_id=$1 AND product_id=$2', [req.user.id, product_id]);
    if (existing) return res.json({ ok:true, id:existing.id });
    const id = uuid();
    await q('INSERT INTO favorites (id,user_id,product_id,business_id) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING', [id, req.user.id, product_id, business_id||'']);
    res.json({ ok:true, id });
  } catch(e) { console.error('favorites POST error:', e.message); res.status(500).json({ error:'Error interno. Intentá de nuevo.' }); }
});
app.delete('/api/favorites/:productId', auth, async (req, res) => {
  try {
    await q('DELETE FROM favorites WHERE user_id=$1 AND product_id=$2', [req.user.id, req.params.productId]);
    res.json({ ok:true });
  } catch(e) { console.error('favorites DELETE error:', e.message); res.status(500).json({ error:'Error interno. Intentá de nuevo.' }); }
});

// ════════════════════════════════════════════════
//  ADMIN
// ════════════════════════════════════════════════
app.post('/api/admin/setup', async (req, res) => {
  // In production, ALWAYS require setup key
  const setupKey = process.env.ADMIN_SETUP_KEY;
  if (IS_PROD) {
    if (!setupKey) return res.status(403).json({ error:'ADMIN_SETUP_KEY no configurado en el servidor' });
    if (req.body.setup_key !== setupKey) return res.status(403).json({ error:'Setup key inválida' });
  }
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
  try {
    const userStats  =await qa('SELECT role,COUNT(*) as c FROM users GROUP BY role',[]);
    const orderStats =await qa('SELECT status,COUNT(*) as c FROM orders GROUP BY status',[]);
    const revenue    =await q1("SELECT COALESCE(SUM(total),0) as total FROM orders WHERE status='delivered'",[]);
    const today      =await q1(`SELECT COUNT(*) as orders,COALESCE(SUM(total),0) as revenue FROM orders WHERE DATE(created_at)=CURRENT_DATE AND status NOT IN ('cancelled','pending')`,[]);
    const week       =await q1(`SELECT COUNT(*) as orders,COALESCE(SUM(total),0) as revenue FROM orders WHERE created_at>=NOW()-INTERVAL '7 days' AND status NOT IN ('cancelled','pending')`,[]);
    const businesses =await q1('SELECT COUNT(*) as c FROM businesses',[]);
    const pendingW   =await q1("SELECT COUNT(*) as c FROM withdrawals WHERE status='pending'",[]);
    res.json({ userStats,orderStats,revenue:parseFloat(revenue.total),today,week,businesses:parseInt(businesses.c),pendingWithdrawals:parseInt(pendingW.c) });
  } catch(e) { res.status(500).json({ error:'Error al cargar estadísticas.' }); }
});

app.get('/api/admin/users', auth, role('admin'), async (req, res) => {
  try {
    const { role:r, search } = req.query;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = 100;
    const offset = (page - 1) * limit;
    let sql='SELECT u.id,u.name,u.email,u.phone,u.role,u.city,u.department,u.created_at,u.banned,u.ban_reason,u.avatar_url,u.blow_plus,(SELECT COUNT(*) FROM orders WHERE customer_id=u.id) as order_count FROM users u WHERE TRUE';
    const params=[]; let i=1;
    if (r) { sql+=` AND u.role=$${i++}`;params.push(r); }
    if (search) { sql+=` AND (u.name ILIKE $${i} OR u.email ILIKE $${i++})`;params.push(`%${search}%`); }
    const countSql = 'SELECT COUNT(*) as total FROM users u WHERE TRUE' + (r ? ` AND u.role=$1` : '') + (search ? ` AND (u.name ILIKE $${r?2:1} OR u.email ILIKE $${r?2:1})` : '');
    const [users, countRow] = await Promise.all([
      qa(sql+` ORDER BY u.created_at DESC LIMIT ${limit} OFFSET ${offset}`, params),
      q1(countSql, params)
    ]);
    res.json({ users, total: parseInt(countRow?.total||0), page, limit });
  } catch(e) { res.status(500).json({ error:'Error al cargar usuarios.' }); }
});

app.patch('/api/admin/users/:id', auth, role('admin'), async (req, res) => {
  try {
    const { name, role:r, phone } = req.body; // email excluido — no se puede cambiar desde admin
    if (r && !['customer','owner','delivery'].includes(r)) return res.status(400).json({ error:'Rol inválido. Usá: customer, owner o delivery.' });
    await q('UPDATE users SET name=COALESCE($1,name),role=COALESCE($2,role),phone=COALESCE($3,phone) WHERE id=$4',[name,r,phone,req.params.id]);
    if (r) await q('INSERT INTO audit_log (id,admin_id,action,target_id,details) VALUES ($1,$2,$3,$4,$5)',
      [uuid(), req.user.id, 'change_role', req.params.id, JSON.stringify({ new_role: r, admin_email: req.user.email })]);
    res.json(await q1('SELECT id,name,email,role,phone,created_at FROM users WHERE id=$1',[req.params.id]));
  } catch(e) { res.status(500).json({ error:'Error interno. Intentá de nuevo.' }); }
});
app.delete('/api/admin/users/:id', auth, role('admin'), async (req, res) => {
  try {
    const target = await q1('SELECT email, role FROM users WHERE id=$1', [req.params.id]);
    if (!target) return res.status(404).json({ error:'Usuario no encontrado' });
    if (target.role === 'admin') return res.status(403).json({ error:'No podés eliminar un admin' });
    await q("DELETE FROM users WHERE id=$1 AND role!='admin'",[req.params.id]);
    await q('INSERT INTO audit_log (id,admin_id,action,target_id,details) VALUES ($1,$2,$3,$4,$5)',
      [uuid(), req.user.id, 'delete_user', req.params.id, JSON.stringify({ target_email: target.email, admin_email: req.user.email })]);
    res.json({ success:true });
  } catch(e) { res.status(500).json({ error:'Error interno. Intentá de nuevo.' }); }
});
app.post('/api/admin/users/:id/reset-password', auth, role('admin'), async (req, res) => {
  try {
  const { password }=req.body;
  if (!password||password.length<6) return res.status(400).json({ error:'Mínimo 6 caracteres' });
  await q('UPDATE users SET password=$1, password_changed_at=NOW() WHERE id=$2',[await bcrypt.hash(password,10),req.params.id]);
  await q('INSERT INTO audit_log (id,admin_id,action,target_id,details) VALUES ($1,$2,$3,$4,$5)',
    [uuid(), req.user.id, 'admin_reset_password', req.params.id, JSON.stringify({ admin: req.user.email })]);
  res.json({ success:true });
  } catch(e) { res.status(500).json({ error:'Error interno. Intentá de nuevo.' }); }
});
app.get('/api/admin/businesses', auth, role('admin'), async (req, res) => {
  try {
    res.json(await qa(`SELECT b.*,u.name as owner_name,u.email as owner_email,(SELECT COUNT(*) FROM orders WHERE business_id=b.id AND status='delivered') as completed_orders,(SELECT COALESCE(SUM(total),0) FROM orders WHERE business_id=b.id AND status='delivered') as total_revenue FROM businesses b JOIN users u ON b.owner_id=u.id ORDER BY b.created_at DESC`,[]));
  } catch(e) { console.error('admin/businesses GET error:', e.message); res.status(500).json({ error:'Error interno. Intentá de nuevo.' }); }
});
app.patch('/api/admin/businesses/:id', auth, role('admin'), async (req, res) => {
  try {
    const { name,category,address,phone,logo_emoji,delivery_cost,is_open,plan,delivery_time,city,department }=req.body;
    await q(`UPDATE businesses SET name=COALESCE($1,name),category=COALESCE($2,category),address=COALESCE($3,address),phone=COALESCE($4,phone),logo_emoji=COALESCE($5,logo_emoji),delivery_cost=COALESCE($6,delivery_cost),is_open=COALESCE($7,is_open),plan=COALESCE($8,plan),delivery_time=COALESCE($9,delivery_time),city=COALESCE($10,city),department=COALESCE($11,department) WHERE id=$12`,
      [name,category,address,phone,logo_emoji,delivery_cost,is_open!=null?Boolean(is_open):null,plan,delivery_time,city,department,req.params.id]);
    res.json(await q1('SELECT * FROM businesses WHERE id=$1',[req.params.id]));
  } catch(e) { res.status(500).json({ error:'Error interno. Intentá de nuevo.' }); }
});
app.delete('/api/admin/businesses/:id', auth, role('admin'), async (req, res) => {
  try {
    await q('DELETE FROM businesses WHERE id=$1',[req.params.id]);
    res.json({ success:true });
  } catch(e) { res.status(500).json({ error:'Error interno. Intentá de nuevo.' }); }
});
app.get('/api/admin/orders', auth, role('admin'), async (req, res) => {
  try {
    const { status,search }=req.query;
    let sql='SELECT o.*,u.name as customer_name,b.name as business_name FROM orders o JOIN users u ON o.customer_id=u.id JOIN businesses b ON o.business_id=b.id WHERE TRUE';
    const params=[]; let i=1;
    if (status) { sql+=` AND o.status=$${i++}`;params.push(status); }
    if (search) { sql+=` AND (u.name ILIKE $${i} OR b.name ILIKE $${i++})`;params.push(`%${search}%`); }
    const rows=await qa(sql+' ORDER BY o.created_at DESC LIMIT 200',params);
    if (!rows.length) return res.json([]);
    const adminOrderIds = rows.map(o=>o.id);
    const adminAllItems = await qa('SELECT * FROM order_items WHERE order_id = ANY($1)',[adminOrderIds]);
    const adminByOrder = {};
    for (const it of adminAllItems) { if (!adminByOrder[it.order_id]) adminByOrder[it.order_id]=[]; adminByOrder[it.order_id].push(it); }
    res.json(rows.map(o=>({...o, items: adminByOrder[o.id]||[]})));
  } catch(e) { res.status(500).json({ error:'Error al cargar pedidos.' }); }
});
app.get('/api/admin/withdrawals', auth, role('admin'), async (req, res) => {
  try { res.json(await qa('SELECT * FROM withdrawals ORDER BY created_at DESC',[])); }
  catch(e) { res.status(500).json({ error:'Error al cargar retiros.' }); }
});
app.post('/api/admin/withdrawals/:id/approve', auth, role('admin'), async (req, res) => {
  try {
    const w = await q1('SELECT * FROM withdrawals WHERE id=$1', [req.params.id]);
    if (!w) return res.status(404).json({ error: 'No encontrado' });
    if (w.status !== 'pending') return res.status(400).json({ error: 'Este retiro ya fue procesado' });
    await q("UPDATE withdrawals SET status='completed', processed_at=NOW() WHERE id=$1", [req.params.id]);
    await q('INSERT INTO audit_log (id,admin_id,action,target_id,details) VALUES ($1,$2,$3,$4,$5)',
      [uuid(), req.user.id, 'admin_approve_withdrawal', req.params.id, JSON.stringify({ amount: w.amount, owner_id: w.owner_id })]);
    // Notificar al dueño
    notify(w.owner_id, {
      type: 'withdrawal_approved',
      message: `✅ Tu retiro de ${w.amount} fue confirmado. El dinero se acredita en hasta 24hs hábiles.`
    });
    // Push notification si tiene suscripción
    sendPushToOwner(w.owner_id, {
      title: '💸 Retiro confirmado',
      body: `${w.amount} — acreditado en hasta 24hs hábiles`,
      tag: 'withdrawal',
      url: '/'
    });
    res.json({ success: true });
  } catch(e) { console.error('withdrawals/approve error:', e.message); res.status(500).json({ error:'Error interno. Intentá de nuevo.' }); }
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
  // ── Verificar firma HMAC si MP_WEBHOOK_SECRET está configurado ──
  const webhookSecret = process.env.MP_WEBHOOK_SECRET;
  if (webhookSecret) {
    const xSignature = req.headers['x-signature'] || '';
    const xRequestId = req.headers['x-request-id'] || '';
    const dataId = req.query['data.id'] || req.body?.data?.id || '';
    // MP firma: ts=xxx,v1=xxx
    const parts = {};
    xSignature.split(',').forEach(p => { const [k,v] = p.split('='); if(k&&v) parts[k.trim()] = v.trim(); });
    const ts = parts.ts;
    const v1 = parts.v1;
    if (ts && v1) {
      const crypto = require('crypto');
      const manifest = `id:${dataId};request-id:${xRequestId};ts:${ts};`;
      const hmac = crypto.createHmac('sha256', webhookSecret).update(manifest).digest('hex');
      if (hmac !== v1) {
        console.warn('⚠️ Webhook MP: firma inválida');
        return res.sendStatus(401);
      }
    }
  }
  res.sendStatus(200);
  try {
    const { type, data, topic, id } = req.body;
    const resourceId = data?.id || id;
    console.log('🔔 WEBHOOK RECEIVED:', JSON.stringify({ type, topic, id, data, resourceId }));
    if (!resourceId || !mp) { console.log('❌ No resourceId or no mp'); return; }

    // ── Idempotencia: evitar procesar el mismo evento dos veces (replay attack) ──
    const webhookKey = `${type||topic||'payment'}:${resourceId}`;
    const alreadyProcessed = await q1('SELECT id FROM processed_webhooks WHERE id=$1', [webhookKey]);
    if (alreadyProcessed) { console.log('⚠️ Webhook ya procesado, ignorando:', webhookKey); return; }
    await q('INSERT INTO processed_webhooks (id) VALUES ($1) ON CONFLICT DO NOTHING', [webhookKey]);
    // Limpiar webhooks viejos (>7 días) en 1% de requests
    if (Math.random() < 0.01) await q("DELETE FROM processed_webhooks WHERE processed_at < NOW() - INTERVAL '7 days'", []);

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
          [userId, d.name, d.email, d.phone||'', d.password, 'owner', d.city, d.department||'']);

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
      await q("UPDATE orders SET status='paid',updated_at=NOW() WHERE id=$1",[orderId]);
      const biz = await q1('SELECT * FROM businesses WHERE id=$1',[order.business_id]);
      if (biz) {
        notify(biz.owner_id,{ type:'new_order',message:`💰 Pago confirmado! #${orderId.slice(-6).toUpperCase()} — Aceptar o rechazar`,order_id:orderId,total:order.total });
        sendPushToOwner(biz.owner_id,{ title:'💰 Nuevo pedido pagado', body:`#${orderId.slice(-6).toUpperCase()} — $${order.total} · Aceptar o rechazar`, tag:'new_order', url:'/' });
      }
      notify(order.customer_id,{ type:'status_change',message:'✅ Pago recibido — esperando confirmación del local',status:'paid',order_id:orderId });
    }
    if (order && ['rejected','cancelled'].includes(payment.status) && order.status === 'pending') {
      await q("UPDATE orders SET status='cancelled', cancel_reason='Pago rechazado por MercadoPago', cancelled_at=NOW(), updated_at=NOW() WHERE id=$1",[orderId]);
      // Restore stock for cancelled items
      const cancelledItems = await qa('SELECT product_id, quantity FROM order_items WHERE order_id=$1', [orderId]);
      for (const ci of cancelledItems) {
        await q('UPDATE products SET stock = stock + $1, is_available = TRUE WHERE id=$2 AND stock IS NOT NULL', [ci.quantity, ci.product_id]);
      }
      console.log(`🔄 Stock restored for cancelled order ${orderId}`);
    }

  } catch(e) { console.error('Webhook error:', e.message); }
});

// ── Verificar pago manualmente (fallback si webhook no llegó) ──
app.post('/api/orders/:id/verify-payment', auth, async (req, res) => {
  try {
    if (!checkVerifyPaymentRate(req.user.id)) return res.status(429).json({ error: 'Demasiadas verificaciones. Esperá un momento.' });
    const order = await q1('SELECT * FROM orders WHERE id=$1 AND customer_id=$2', [req.params.id, req.user.id]);
    if (!order) return res.status(404).json({ error: 'Pedido no encontrado' });
    if (order.status !== 'pending') return res.json({ status: order.status, already_confirmed: true });
    if (!mp || !order.mp_payment_id) return res.json({ status: order.status });
    // Consultar MP directamente
    const payment = (await mp.payment.get(order.mp_payment_id)).body;
    if (payment.status === 'approved') {
      await q("UPDATE orders SET status='paid', updated_at=NOW() WHERE id=$1 AND status='pending'", [order.id]);
      const biz = await q1('SELECT * FROM businesses WHERE id=$1', [order.business_id]);
      if (biz) {
        notify(biz.owner_id, { type:'new_order', message:`💰 Nuevo pedido pagado #${order.id.slice(-6).toUpperCase()} — Aceptar o rechazar`, order_id:order.id, total:order.total });
        sendPushToOwner(biz.owner_id, { title:'💰 Nuevo pedido pagado', body:`#${order.id.slice(-6).toUpperCase()} — $${order.total}`, tag:'new_order', url:'/' });
      }
      notify(order.customer_id, { type:'status_change', message:'✅ Pago confirmado — esperando confirmación del local', status:'paid', order_id:order.id });
      return res.json({ status: 'paid' });
    }
    if (['rejected','cancelled'].includes(payment.status)) {
      await q("UPDATE orders SET status='cancelled', updated_at=NOW() WHERE id=$1", [order.id]);
      return res.json({ status: 'cancelled' });
    }
    res.json({ status: order.status });
  } catch(e) { res.status(500).json({ error: 'Error al verificar pago.' }); }
});


// Rate limit: 1 req/seg por IP (respetando ToS de Nominatim)
const GEO_CACHE_MAX = 500;
const geoCache = new Map(); // cache en memoria para evitar duplicados
app.get('/api/geocode/reverse', async (req, res) => {
  const { lat, lng } = req.query;
  const flat = parseFloat(lat), flng = parseFloat(lng);
  if (isNaN(flat) || isNaN(flng)) return res.status(400).json({ error: 'lat y lng requeridos' });
  if (flat < -90 || flat > 90 || flng < -180 || flng > 180) return res.status(400).json({ error: 'Coordenadas fuera de rango' });

  // Redondear a 3 decimales para cachear (~100m de precisión)
  const cacheKey = `${flat.toFixed(3)},${flng.toFixed(3)}`;
  if (geoCache.has(cacheKey)) return res.json(geoCache.get(cacheKey));

  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${flat}&lon=${flng}&accept-language=es&zoom=14`;
    const response = await fetch(url, {
      headers: { 'User-Agent': 'blow-app/1.0 (hola@blow.uy)' }, // requerido por Nominatim ToS
      signal: AbortSignal.timeout(6000)
    });
    if (!response.ok) throw new Error(`Nominatim error ${response.status}`);
    const geo = await response.json();
    const addr = geo.address || {};
    const result = {
      city:    addr.city || addr.town || addr.village || addr.municipality || addr.suburb || addr.county || '',
      dept:    addr.state || addr.county || '',
      street:  addr.road ? `${addr.road}${addr.house_number ? ' ' + addr.house_number : ''}` : '',
      country: addr.country_code?.toUpperCase() || '',
      display: geo.display_name || ''
    };
    // Cachear 30 minutos — con límite de tamaño
    if (geoCache.size >= GEO_CACHE_MAX) {
      const firstKey = geoCache.keys().next().value;
      geoCache.delete(firstKey);
    }
    geoCache.set(cacheKey, result);
    setTimeout(() => geoCache.delete(cacheKey), 30 * 60 * 1000);
    res.json(result);
  } catch(e) {
    console.warn('Geocode error:', e.message);
    res.status(503).json({ error: 'Servicio de geocodificación no disponible' });
  }
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

// ════════════════════════════════════════════════
//  ADMIN PANEL — ENDPOINTS EXTENDIDOS
// ════════════════════════════════════════════════

// Stats avanzadas con filtro por fecha
app.get('/api/admin/stats/advanced', auth, role('admin'), async (req, res) => {
  try {
    const { from, to } = req.query;
    const dateFrom = from || new Date(Date.now() - 30*24*60*60*1000).toISOString().split('T')[0];
    const dateTo = to || new Date().toISOString().split('T')[0];
    const [totals, dailyRevenue, topBusinesses, topCustomers, ordersByStatus, newUsers, subscriptionStats] = await Promise.all([
      q1(`SELECT COUNT(DISTINCT o.id) FILTER (WHERE o.status NOT IN ('cancelled','pending')) as total_orders,
        COALESCE(SUM(o.total) FILTER (WHERE o.status='delivered'),0) as gmv,
        COALESCE(SUM(o.platform_fee) FILTER (WHERE o.status='delivered'),0) as platform_revenue,
        COUNT(DISTINCT o.customer_id) FILTER (WHERE o.status NOT IN ('cancelled','pending')) as active_customers,
        AVG(o.total) FILTER (WHERE o.status='delivered') as avg_order_value,
        COUNT(*) FILTER (WHERE o.status='cancelled') as cancelled_orders
        FROM orders o WHERE DATE(o.created_at) BETWEEN $1 AND $2`, [dateFrom, dateTo]),
      qa(`SELECT DATE(created_at) as day,
        COUNT(*) FILTER (WHERE status NOT IN ('cancelled','pending')) as orders,
        COALESCE(SUM(total) FILTER (WHERE status='delivered'),0) as revenue,
        COALESCE(SUM(platform_fee) FILTER (WHERE status='delivered'),0) as fee
        FROM orders WHERE DATE(created_at) BETWEEN $1 AND $2
        GROUP BY DATE(created_at) ORDER BY day`, [dateFrom, dateTo]),
      qa(`SELECT b.id,b.name,b.logo_emoji,b.city,
        COUNT(o.id) FILTER (WHERE o.status='delivered') as orders,
        COALESCE(SUM(o.total) FILTER (WHERE o.status='delivered'),0) as revenue
        FROM businesses b LEFT JOIN orders o ON o.business_id=b.id AND DATE(o.created_at) BETWEEN $1 AND $2
        GROUP BY b.id ORDER BY revenue DESC LIMIT 10`, [dateFrom, dateTo]),
      qa(`SELECT u.id,u.name,u.email,u.phone,
        COUNT(o.id) as orders, COALESCE(SUM(o.total),0) as spent
        FROM users u JOIN orders o ON o.customer_id=u.id
        WHERE u.role='customer' AND DATE(o.created_at) BETWEEN $1 AND $2 AND o.status='delivered'
        GROUP BY u.id ORDER BY spent DESC LIMIT 10`, [dateFrom, dateTo]),
      qa(`SELECT status, COUNT(*) as c FROM orders WHERE DATE(created_at) BETWEEN $1 AND $2 GROUP BY status`, [dateFrom, dateTo]),
      qa(`SELECT DATE(created_at) as day, COUNT(*) as c FROM users WHERE DATE(created_at) BETWEEN $1 AND $2 GROUP BY DATE(created_at) ORDER BY day`, [dateFrom, dateTo]),
      q1(`SELECT COUNT(*) FILTER (WHERE s.status='active') as active,
        COUNT(*) FILTER (WHERE s.status='cancelled') as cancelled,
        COUNT(*) FILTER (WHERE s.current_period_end < NOW()+INTERVAL '7 days' AND s.status='active') as expiring_soon
        FROM subscriptions s`, []),
    ]);
    res.json({ totals, dailyRevenue, topBusinesses, topCustomers, ordersByStatus, newUsers, subscriptionStats, dateFrom, dateTo });
  } catch(e) { res.status(500).json({ error: 'Error interno. Intentá de nuevo.' }); }
});

// Suscripciones con detalle de vencimiento
app.get('/api/admin/subscriptions/detail', auth, role('admin'), async (req, res) => {
  try {
    const rows = await qa(`SELECT s.*,b.name as business_name,b.logo_emoji,b.city,b.category,
      u.name as owner_name,u.email as owner_email,u.phone as owner_phone,
      (SELECT COUNT(*) FROM orders WHERE business_id=b.id AND status='delivered') as total_orders,
      (SELECT COALESCE(SUM(total),0) FROM orders WHERE business_id=b.id AND status='delivered') as total_revenue
      FROM subscriptions s JOIN businesses b ON b.id=s.business_id JOIN users u ON u.id=s.owner_id
      ORDER BY s.current_period_end ASC`, []);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: 'Error interno. Intentá de nuevo.' }); }
});

// Impersonar owner — genera token temporal
app.post('/api/admin/impersonate/:userId', auth, role('admin'), async (req, res) => {
  try {
    const target = await q1('SELECT * FROM users WHERE id=$1', [req.params.userId]);
    if (!target) return res.status(404).json({ error: 'Usuario no encontrado' });
    if (target.role === 'admin') return res.status(403).json({ error: 'No podés impersonar otro admin' });
    const impToken = jwt.sign({ id: target.id, name: target.name, email: target.email, role: target.role, impersonated_by: req.user.id }, JWT_SECRET, { expiresIn: '2h' });
    // Audit trail en tabla
    await q('INSERT INTO audit_log (id,admin_id,action,target_id,details) VALUES ($1,$2,$3,$4,$5)',
      [uuid(), req.user.id, 'impersonate', target.id, JSON.stringify({ target_email: target.email, target_role: target.role, admin_email: req.user.email })]);
    console.log(`🔐 IMPERSONATE: admin ${req.user.id} → ${target.email}`);
    res.json({ token: impToken, user: { id: target.id, name: target.name, email: target.email, role: target.role } });
  } catch(e) { res.status(500).json({ error: 'Error interno. Intentá de nuevo.' }); }
});

// Banear / desbanear usuario
app.post('/api/admin/users/:id/ban', auth, role('admin'), async (req, res) => {
  try {
    const { banned, reason } = req.body;
    await q('UPDATE users SET banned=$1,ban_reason=$2 WHERE id=$3', [!!banned, reason||null, req.params.id]);
    if (banned) notify(req.params.id, { type:'account_banned', message:`⛔ Tu cuenta fue suspendida${reason?': '+reason:''}` });
    await q('INSERT INTO audit_log (id,admin_id,action,target_id,details) VALUES ($1,$2,$3,$4,$5)',
      [uuid(), req.user.id, banned ? 'ban_user' : 'unban_user', req.params.id, JSON.stringify({ reason: reason||null, admin_email: req.user.email })]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: 'Error al actualizar estado del usuario.' }); }
});

// Cancelar pedido desde admin
app.post('/api/admin/orders/:id/cancel', auth, role('admin'), async (req, res) => {
  try {
    const { reason } = req.body;
    const order = await q1('SELECT * FROM orders WHERE id=$1', [req.params.id]);
    if (!order) return res.status(404).json({ error: 'Pedido no encontrado' });
    if (order.status === 'cancelled') return res.status(400).json({ error: 'Este pedido ya está cancelado' });
    await q("UPDATE orders SET status='cancelled', cancel_reason=COALESCE($1,'Cancelado por administración'), cancelled_at=NOW(), updated_at=NOW() WHERE id=$2", [reason||'Cancelado por administración', req.params.id]);
    // Restore stock for cancelled items
    const items = await qa('SELECT product_id, quantity FROM order_items WHERE order_id=$1', [order.id]);
    for (const item of items) {
      await q('UPDATE products SET stock = stock + $1, is_available = TRUE WHERE id=$2 AND stock IS NOT NULL', [item.quantity, item.product_id]);
    }
    notify(order.customer_id, { type:'order_cancelled', message:`❌ Tu pedido fue cancelado por administración${reason?': '+reason:''}`, order_id:order.id });
    sendPushToUser(order.customer_id, { title:'❌ Pedido cancelado', body:`#${order.id.slice(-6).toUpperCase()} fue cancelado por administración.${reason?' '+reason:''}`, tag:`order-${order.id}`, url:'/?tab=tracking' });
    // Email notification
    const biz = await q1('SELECT name FROM businesses WHERE id=$1', [order.business_id]);
    sendOrderStatusEmail(order, 'cancelled', biz?.name).catch(() => {});
    await q('INSERT INTO audit_log (id,admin_id,action,target_id,details) VALUES ($1,$2,$3,$4,$5)',
      [uuid(), req.user.id, 'admin_cancel_order', req.params.id, JSON.stringify({ reason: reason||'Cancelado por administración', order_total: order.total })]);
    res.json({ success: true });
  } catch(e) { console.error('Admin cancel error:', e.message); res.status(500).json({ error: 'Error interno al cancelar pedido.' }); }
});

// Exportar CSV
app.get('/api/admin/export/users', auth, role('admin'), async (req, res) => {
  try {
    const users = await qa('SELECT id,name,email,phone,role,city,department,created_at FROM users ORDER BY created_at DESC', []);
    const csv = ['ID,Nombre,Email,Teléfono,Rol,Ciudad,Dpto,Registro',
      ...users.map(u=>`${u.id},${JSON.stringify(u.name)},${u.email},${u.phone||''},${u.role},${u.city||''},${u.department||''},${new Date(u.created_at).toLocaleDateString('es-UY')}`)].join('\n');
    res.setHeader('Content-Type','text/csv;charset=utf-8');
    res.setHeader('Content-Disposition','attachment;filename="usuarios.csv"');
    res.send('\uFEFF'+csv);
  } catch(e) { res.status(500).json({ error:'Error al exportar usuarios.' }); }
});
app.get('/api/admin/export/businesses', auth, role('admin'), async (req, res) => {
  try {
    const rows = await qa(`SELECT b.name,b.category,b.city,u.name as owner,u.email,s.status as sub,s.current_period_end,b.created_at
      FROM businesses b JOIN users u ON b.owner_id=u.id LEFT JOIN subscriptions s ON s.business_id=b.id ORDER BY b.created_at DESC`,[]);
    const csv = ['Negocio,Categoría,Ciudad,Dueño,Email,Suscripción,Vence,Registro',
      ...rows.map(r=>`${JSON.stringify(r.name)},${r.category||''},${r.city||''},${JSON.stringify(r.owner)},${r.email},${r.sub||''},${r.current_period_end?new Date(r.current_period_end).toLocaleDateString('es-UY'):''},${new Date(r.created_at).toLocaleDateString('es-UY')}`)].join('\n');
    res.setHeader('Content-Type','text/csv;charset=utf-8');
    res.setHeader('Content-Disposition','attachment;filename="negocios.csv"');
    res.send('\uFEFF'+csv);
  } catch(e) { res.status(500).json({ error:'Error al exportar negocios.' }); }
});
app.get('/api/admin/export/orders', auth, role('admin'), async (req, res) => {
  try {
    const { from, to } = req.query;
    const dateFrom = from || new Date(Date.now()-30*24*60*60*1000).toISOString().split('T')[0];
    const dateTo = to || new Date().toISOString().split('T')[0];
    const rows = await qa(`SELECT o.id,o.status,o.total,o.platform_fee,o.payment_method,u.name as customer,u.email,b.name as business,o.created_at
      FROM orders o JOIN users u ON o.customer_id=u.id JOIN businesses b ON o.business_id=b.id
      WHERE DATE(o.created_at) BETWEEN $1 AND $2 ORDER BY o.created_at DESC`, [dateFrom, dateTo]);
    const csv = ['ID,Estado,Total,Fee,Pago,Cliente,Email,Negocio,Fecha',
      ...rows.map(r=>`${r.id.slice(-8)},${r.status},$${r.total},$${r.platform_fee||0},${r.payment_method||''},${JSON.stringify(r.customer)},${r.email},${JSON.stringify(r.business)},${new Date(r.created_at).toLocaleString('es-UY')}`)].join('\n');
    res.setHeader('Content-Type','text/csv;charset=utf-8');
    res.setHeader('Content-Disposition',`attachment;filename="pedidos-${dateFrom}-${dateTo}.csv"`);
    res.send('\uFEFF'+csv);
  } catch(e) { res.status(500).json({ error:'Error al exportar pedidos.' }); }
});

// Toggle open/closed negocio
app.post('/api/admin/businesses/:id/toggle-open', auth, role('admin'), async (req, res) => {
  const b = await q1('SELECT is_open FROM businesses WHERE id=$1',[req.params.id]);
  if (!b) return res.status(404).json({ error:'No encontrado' });
  await q('UPDATE businesses SET is_open=$1 WHERE id=$2',[!b.is_open,req.params.id]);
  res.json({ is_open: !b.is_open });
});

// Cancelar suscripción con notificación
app.post('/api/admin/subscriptions/:id/cancel-notify', auth, role('admin'), async (req, res) => {
  try {
    const { reason } = req.body;
    const sub = await q1('SELECT * FROM subscriptions WHERE id=$1',[req.params.id]);
    if (!sub) return res.status(404).json({ error:'No encontrada' });
    await q("UPDATE subscriptions SET status='cancelled',updated_at=NOW() WHERE id=$1",[req.params.id]);
    notify(sub.owner_id, { type:'subscription_cancelled', message:`❌ Tu suscripción fue cancelada${reason?': '+reason:''}` });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: 'Error interno. Intentá de nuevo.' }); }
});

// ── Geocoding proxy (alias) ───────────────────────────
// Legacy endpoint — redirects to /api/geocode/reverse
app.get('/api/geocode', async (req, res) => {
  const lat = parseFloat(req.query.lat);
  const lng = parseFloat(req.query.lng);
  if (isNaN(lat) || isNaN(lng)) return res.status(400).json({ error: 'lat y lng requeridos' });
  // Forward to the main geocode endpoint
  try {
    const cacheKey = `${lat.toFixed(3)},${lng.toFixed(3)}`;
    if (geoCache.has(cacheKey)) return res.json(geoCache.get(cacheKey));
    const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&accept-language=es&zoom=14`;
    const response = await fetch(url, {
      headers: { 'User-Agent': 'blow-app/1.0 (hola@blow.uy)' },
      signal: AbortSignal.timeout(6000)
    });
    if (!response.ok) throw new Error(`Nominatim error ${response.status}`);
    const geo = await response.json();
    const addr = geo.address || {};
    const result = {
      city:    addr.city || addr.town || addr.village || addr.municipality || addr.suburb || addr.county || '',
      dept:    addr.state || addr.county || '',
      street:  addr.road ? `${addr.road}${addr.house_number ? ' ' + addr.house_number : ''}` : '',
      country: addr.country_code?.toUpperCase() || '',
      display: geo.display_name || ''
    };
    if (geoCache.size >= GEO_CACHE_MAX) { geoCache.delete(geoCache.keys().next().value); }
    geoCache.set(cacheKey, result);
    setTimeout(() => geoCache.delete(cacheKey), 30 * 60 * 1000);
    res.json(result);
  } catch(e) {
    res.status(502).json({ error: 'No se pudo obtener la dirección. Intentá de nuevo.' });
  }
});

// ── Push Notifications ────────────────────────
// Devuelve la public key VAPID para que el frontend pueda suscribirse
app.get('/api/push/vapid-public-key', (req, res) => {
  if (!webpush || !process.env.VAPID_PUBLIC_KEY)
    return res.status(503).json({ error: 'Push no disponible' });
  res.json({ key: process.env.VAPID_PUBLIC_KEY });
});

// Guarda suscripción push del owner
app.post('/api/push/subscribe', auth, async (req, res) => {
  const { endpoint, keys } = req.body || {};
  if (!endpoint || !keys?.p256dh || !keys?.auth)
    return res.status(400).json({ error: 'Datos de suscripción inválidos' });
  try {
    await q(
      `INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (user_id, endpoint) DO UPDATE SET p256dh=$4, auth=$5`,
      [uuid(), req.user.id, endpoint, keys.p256dh, keys.auth]
    );
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: 'Error interno. Intentá de nuevo.' }); }
});

// Elimina suscripción push
app.delete('/api/push/unsubscribe', auth, async (req, res) => {
  const { endpoint } = req.body || {};
  if (endpoint) {
    await q('DELETE FROM push_subscriptions WHERE user_id=$1 AND endpoint=$2', [req.user.id, endpoint]);
  } else {
    await q('DELETE FROM push_subscriptions WHERE user_id=$1', [req.user.id]);
  }
  res.json({ ok: true });
});

// ── Health + Static ───────────────────────────
app.get('/health', async (_,res) => {
  try { await db.query('SELECT 1'); res.json({ status:'ok',db:'postgres',mp:!!mp,cloudinary:!!cloudinary,ts:new Date().toISOString() }); }
  catch(e) { res.status(500).json({ status:'error' }); }
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
  } catch(e) { res.status(500).json({ error: 'Error interno. Intentá de nuevo.' }); }
});

app.get('/api/coupons/available', auth, async (req, res) => {
  try {
    const coupons = await qa('SELECT c.*, COALESCE((SELECT COUNT(*) FROM coupon_uses WHERE coupon_id=c.id AND user_id=$1),0) as my_uses, b.name as business_name FROM coupons c LEFT JOIN businesses b ON b.id=c.business_id WHERE c.active=true AND (c.expires_at IS NULL OR c.expires_at > NOW()) AND (c.max_uses IS NULL OR c.uses_count < c.max_uses) ORDER BY c.created_at DESC', [req.user.id]);
    res.json(coupons);
  } catch(e) { res.status(500).json({ error: 'Error al cargar cupones.' }); }
});

app.post('/api/admin/coupons', auth, role('admin'), async (req, res) => {
  try {
    const { code, description, discount_type, discount_value, min_order, max_uses, per_user, business_id, expires_at } = req.body;
    if (!code || !discount_value) return res.status(400).json({ error: 'Código y descuento requeridos' });
    const dVal = parseFloat(discount_value);
    if (isNaN(dVal) || dVal <= 0) return res.status(400).json({ error: 'El descuento debe ser mayor a cero' });
    const dType = discount_type || 'percent';
    if (!['percent','fixed'].includes(dType)) return res.status(400).json({ error: 'Tipo de descuento invalido' });
    if (dType === 'percent' && dVal > 100) return res.status(400).json({ error: 'El descuento en porcentaje no puede superar 100%' });
    const existing = await q1('SELECT id FROM coupons WHERE UPPER(code)=UPPER($1)', [code.trim()]);
    if (existing) return res.status(409).json({ error: 'Ya existe ese código' });
    const id = uuid();
    await q('INSERT INTO coupons (id,code,description,discount_type,discount_value,min_order,max_uses,per_user,business_id,created_by,expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
      [id, code.trim().toUpperCase(), description||'', dType, dVal, min_order||0, max_uses||null, per_user||1, business_id||null, req.user.id, expires_at||null]);
    res.status(201).json({ id });
  } catch(e) { res.status(500).json({ error: 'Error interno. Intentá de nuevo.' }); }
});

app.get('/api/admin/coupons', auth, role('admin'), async (req, res) => {
  try { res.json(await qa('SELECT c.*, b.name as business_name FROM coupons c LEFT JOIN businesses b ON b.id=c.business_id ORDER BY c.created_at DESC', [])); }
  catch(e) { res.status(500).json({ error: 'Error interno. Intentá de nuevo.' }); }
});

app.patch('/api/admin/coupons/:id', auth, role('admin'), async (req, res) => {
  try { await q('UPDATE coupons SET active=$1 WHERE id=$2', [req.body.active, req.params.id]); res.json({ ok: true }); }
  catch(e) { res.status(500).json({ error: 'Error interno. Intentá de nuevo.' }); }
});

app.delete('/api/admin/coupons/:id', auth, role('admin'), async (req, res) => {
  try { await q('DELETE FROM coupons WHERE id=$1', [req.params.id]); res.json({ ok: true }); }
  catch(e) { res.status(500).json({ error: 'Error interno. Intentá de nuevo.' }); }
});

app.post('/api/owner/coupons', auth, async (req, res) => {
  if (req.user.role !== 'owner') return res.status(403).json({ error: 'Sin permisos' });
  try {
    const biz = await q1('SELECT id FROM businesses WHERE owner_id=$1', [req.user.id]);
    if (!biz) return res.status(404).json({ error: 'Negocio no encontrado' });
    const { code, description, discount_type, discount_value, min_order } = req.body;
    if (!code || !discount_value) return res.status(400).json({ error: 'Código y descuento requeridos' });
    const dVal2 = parseFloat(discount_value);
    if (isNaN(dVal2) || dVal2 <= 0) return res.status(400).json({ error: 'El descuento debe ser mayor a cero' });
    const dType2 = discount_type || 'percent';
    if (!['percent','fixed'].includes(dType2)) return res.status(400).json({ error: 'Tipo de descuento invalido' });
    if (dType2 === 'percent' && dVal2 > 100) return res.status(400).json({ error: 'El descuento en porcentaje no puede superar 100%' });
    const existing = await q1('SELECT id FROM coupons WHERE UPPER(code)=UPPER($1)', [code.trim()]);
    if (existing) return res.status(409).json({ error: 'Ya existe ese código' });
    const id = uuid();
    await q('INSERT INTO coupons (id,code,description,discount_type,discount_value,min_order,per_user,business_id,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [id, code.trim().toUpperCase(), description||'', dType2, dVal2, min_order||0, 1, biz.id, req.user.id]);
    res.status(201).json({ id });
  } catch(e) { res.status(500).json({ error: 'Error interno. Intentá de nuevo.' }); }
});

app.get('/api/owner/coupons', auth, async (req, res) => {
  if (req.user.role !== 'owner') return res.status(403).json({ error: 'Sin permisos' });
  try {
    const biz = await q1('SELECT id FROM businesses WHERE owner_id=$1', [req.user.id]);
    if (!biz) return res.json([]);
    res.json(await qa('SELECT * FROM coupons WHERE business_id=$1 ORDER BY created_at DESC', [biz.id]));
  } catch(e) { res.status(500).json({ error: 'Error interno. Intentá de nuevo.' }); }
});

app.delete('/api/owner/coupons/:id', auth, async (req, res) => {
  if (req.user.role !== 'owner') return res.status(403).json({ error: 'Sin permisos' });
  try {
    const biz = await q1('SELECT id FROM businesses WHERE owner_id=$1', [req.user.id]);
    await q('DELETE FROM coupons WHERE id=$1 AND business_id=$2', [req.params.id, biz?.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: 'Error interno. Intentá de nuevo.' }); }
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
  } catch(e) { res.status(500).json({ error: 'Error interno. Intentá de nuevo.' }); }
});

app.get('/api/admin/help', auth, role('admin'), async (req, res) => {
  try { res.json(await qa('SELECT * FROM help_messages ORDER BY created_at DESC LIMIT 100', [])); }
  catch(e) { res.status(500).json({ error: 'Error interno. Intentá de nuevo.' }); }
});

app.patch('/api/admin/help/:id', auth, role('admin'), async (req, res) => {
  try {
    const { reply } = req.body;
    const msg = await q1('SELECT * FROM help_messages WHERE id=$1', [req.params.id]);
    if (!msg) return res.status(404).json({ error: 'No encontrado' });
    await q("UPDATE help_messages SET admin_reply=$1, status='resolved' WHERE id=$2", [reply, req.params.id]);
    await sendEmail(msg.user_email, 'Respuesta de soporte — Blow', '<p>Hola <b>' + escHtml(msg.user_name) + '</b>, respondimos tu consulta:</p><blockquote>' + escHtml(reply) + '</blockquote>');
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: 'Error interno. Intentá de nuevo.' }); }
});

app.get('/api',(_,res)=>res.json({ app:'Blow API v4',db:'PostgreSQL',status:'running' }));

// ── SUPPORT LIVE CHAT ──
app.get('/api/support/messages', auth, async (req, res) => {
  try {
    const msgs = await qa('SELECT * FROM support_chat WHERE user_id=$1 ORDER BY created_at ASC', [req.user.id]);
    res.json(msgs);
  } catch(e) { res.json([]); }
});

app.post('/api/support/messages', auth, async (req, res) => {
  const { body } = req.body;
  if (!body?.trim()) return res.status(400).json({ error:'Mensaje vacío' });
  try {
    const msg = await q1(
      'INSERT INTO support_chat (id,user_id,sender_role,body) VALUES ($1,$2,$3,$4) RETURNING *',
      [uuid(), req.user.id, req.user.role === 'admin' ? 'admin' : 'customer', body.trim().slice(0,1000)]
    );
    // Notify all admin users via WS
    const admins = await qa("SELECT id FROM users WHERE role='admin'", []);
    for (const adm of admins) {
      notify(adm.id, { type:'support_message', user_id:req.user.id, body:body.trim().slice(0,80), sender_role:'customer' });
    }
    res.json(msg);
  } catch(e) { console.error('Server error:', e.message); res.status(500).json({ error:'Error interno. Intentá de nuevo.' }); }
});

// Admin: list all users with support chats
app.get('/api/admin/support/conversations', auth, role('admin'), async (req, res) => {
  try {
    const convos = await qa(`
      SELECT sc.user_id, u.name as user_name, u.email as user_email,
        MAX(sc.created_at) as last_message_at,
        COUNT(*)::int as message_count,
        (SELECT body FROM support_chat WHERE user_id=sc.user_id ORDER BY created_at DESC LIMIT 1) as last_message
      FROM support_chat sc
      JOIN users u ON u.id = sc.user_id
      GROUP BY sc.user_id, u.name, u.email
      ORDER BY MAX(sc.created_at) DESC
      LIMIT 50
    `, []);
    res.json(convos);
  } catch(e) { res.json([]); }
});

// Admin: get messages for a specific user
app.get('/api/admin/support/messages/:userId', auth, role('admin'), async (req, res) => {
  try {
    res.json(await qa('SELECT * FROM support_chat WHERE user_id=$1 ORDER BY created_at ASC', [req.params.userId]));
  } catch(e) { res.json([]); }
});

// Admin: reply to a user
app.post('/api/admin/support/messages/:userId', auth, role('admin'), async (req, res) => {
  const { body } = req.body;
  if (!body?.trim()) return res.status(400).json({ error:'Mensaje vacío' });
  try {
    const msg = await q1(
      'INSERT INTO support_chat (id,user_id,sender_role,body) VALUES ($1,$2,$3,$4) RETURNING *',
      [uuid(), req.params.userId, 'admin', body.trim().slice(0,1000)]
    );
    // Notify user via WS
    notify(req.params.userId, { type:'support_reply', body:body.trim().slice(0,80) });
    res.json(msg);
  } catch(e) { console.error('Server error:', e.message); res.status(500).json({ error:'Error interno. Intentá de nuevo.' }); }
});
app.get('/admin',(_,res)=>res.sendFile(path.join(__dirname,'public','admin.html')));
app.get('/business',(_,res)=>res.sendFile(path.join(__dirname,'public','business.html')));

// ── PROMO BANNERS API ──
app.get('/api/banners', async (req,res)=>{
  try {
    const bannerType = req.query.type || 'promo';
    const rows = await db.query(
      "SELECT id,title,subtitle,highlight,highlight_label,emoji,bg_color,image_url FROM promo_banners WHERE active=TRUE AND banner_type=$1 ORDER BY sort_order ASC, created_at DESC",
      [bannerType]
    );
    res.json(rows.rows);
  } catch(e){ res.json([]); }
});
app.get('/api/banners/admin', auth, role('admin'), async (req,res)=>{
  try {
    const bannerType = req.query.type;
    let query = "SELECT *,active as is_active FROM promo_banners";
    let params = [];
    if (bannerType) { query += " WHERE banner_type=$1"; params.push(bannerType); }
    query += " ORDER BY sort_order ASC, created_at DESC";
    const rows = await db.query(query, params);
    res.json(rows.rows);
  } catch(e){ res.json([]); }
});
app.post('/api/admin/banners', auth, role('admin'), async (req,res)=>{
  const {title,subtitle,highlight,highlight_label,emoji,bg_color,link_url,link,sort_order,is_active,image_url,banner_type} = req.body;
  const id = 'ban_'+Date.now();
  const active = is_active !== false;
  const type = banner_type || 'promo';
  await db.query("INSERT INTO promo_banners(id,title,subtitle,highlight,highlight_label,emoji,bg_color,link,sort_order,active,image_url,banner_type) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)",
    [id,title||'',subtitle||'',highlight||'',highlight_label||'',emoji||'🍔',bg_color||'#FA0050',link_url||link||'',sort_order||0,active,image_url||'',type]);
  res.json({ok:true,id});
});
// Upload banner image (returns URL, doesn't require banner ID)
app.post('/api/admin/banners/upload-image', auth, role('admin'), uploadMiddleware('photo'), async (req,res)=>{
  if(!req.file) return res.status(400).json({error:'No image'});
  try {
    let imageUrl;
    if (req.file.secure_url) { imageUrl = req.file.secure_url; }
    else if (req.file.buffer) {
      const result = await cloudinary.uploader.upload(`data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`,{folder:'blow_banners',transformation:[{width:800,height:300,crop:'fill'}]});
      imageUrl = result.secure_url;
    } else { imageUrl = req.file.path; }
    res.json({ok:true,url:imageUrl});
  } catch(e){ res.status(500).json({error:'Error interno. Intentá de nuevo.'}); }
});
app.patch('/api/admin/banners/:id', auth, role('admin'), async (req,res)=>{
  try {
    const {title,subtitle,highlight,highlight_label,emoji,bg_color,link,sort_order,active,is_active,image_url} = req.body;
    const activeVal = is_active !== undefined ? is_active : active;
    await db.query("UPDATE promo_banners SET title=COALESCE($1,title),subtitle=COALESCE($2,subtitle),highlight=COALESCE($3,highlight),highlight_label=COALESCE($4,highlight_label),emoji=COALESCE($5,emoji),bg_color=COALESCE($6,bg_color),link=COALESCE($7,link),sort_order=COALESCE($8,sort_order),active=COALESCE($9,active),image_url=COALESCE($10,image_url),updated_at=NOW() WHERE id=$11",
      [title,subtitle,highlight,highlight_label,emoji,bg_color,link,sort_order,activeVal,image_url,req.params.id]);
    res.json({ok:true});
  } catch(e){ console.error('banners PATCH error:', e.message); res.status(500).json({error:'Error interno. Intentá de nuevo.'}); }
});
app.delete('/api/admin/banners/:id', auth, role('admin'), async (req,res)=>{
  try {
    await db.query("DELETE FROM promo_banners WHERE id=$1",[req.params.id]);
    res.json({ok:true});
  } catch(e){ console.error('banners DELETE error:', e.message); res.status(500).json({error:'Error interno. Intentá de nuevo.'}); }
});
app.post('/api/admin/banners/:id/image', auth, role('admin'), uploadMiddleware('image'), async (req,res)=>{
  if(!req.file) return res.status(400).json({error:'No image'});
  try {
    let imageUrl;
    if (req.file.buffer) {
      const result = await cloudinary.uploader.upload(`data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`,{folder:'blow_banners',transformation:[{width:800,height:300,crop:'fill'}]});
      imageUrl = result.secure_url;
    } else { imageUrl = req.file.path || req.file.secure_url; }
    await db.query("UPDATE promo_banners SET image_url=$1 WHERE id=$2",[imageUrl,req.params.id]);
    res.json({ok:true,url:imageUrl});
  } catch(e){ res.status(500).json({error:'Error interno. Intentá de nuevo.'}); }
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
app.get('/api/admin/featured', auth, role('admin'), async (req,res)=>{
  if(req.user.role!=='admin') return res.status(403).json({error:'No autorizado'});
  const rows = await db.query(`SELECT fs.*, b.name as biz_name FROM featured_slots fs LEFT JOIN businesses b ON fs.business_id=b.id ORDER BY fs.sort_order ASC`);
  res.json(rows.rows);
});
app.post('/api/admin/featured', auth, role('admin'), async (req,res)=>{
  if(req.user.role!=='admin') return res.status(403).json({error:'No autorizado'});
  const {business_id,custom_title,sort_order} = req.body;
  const id = 'feat_'+Date.now();
  await db.query("INSERT INTO featured_slots(id,business_id,custom_title,sort_order) VALUES($1,$2,$3,$4)",[id,business_id,custom_title||'',sort_order||0]);
  res.json({ok:true,id});
});
app.post('/api/admin/featured/:id/image', auth, role('admin'), uploadMiddleware('image'), async (req,res)=>{
  if(req.user.role!=='admin') return res.status(403).json({error:'No autorizado'});
  if(!req.file) return res.status(400).json({error:'No image'});
  try {
    let imageUrl;
    if (req.file.buffer) {
      const result = await cloudinary.uploader.upload(`data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`,{folder:'blow_featured',transformation:[{width:600,height:400,crop:'fill'}]});
      imageUrl = result.secure_url;
    } else { imageUrl = req.file.path || req.file.secure_url; }
    await db.query("UPDATE featured_slots SET custom_image=$1 WHERE id=$2",[imageUrl,req.params.id]);
    res.json({ok:true,url:imageUrl});
  } catch(e){ res.status(500).json({error:'Error interno. Intentá de nuevo.'}); }
});
app.patch('/api/admin/featured/:id', auth, role('admin'), async (req,res)=>{
  if(req.user.role!=='admin') return res.status(403).json({error:'No autorizado'});
  const {active,sort_order,custom_title} = req.body;
  await db.query("UPDATE featured_slots SET active=COALESCE($1,active),sort_order=COALESCE($2,sort_order),custom_title=COALESCE($3,custom_title) WHERE id=$4",[active,sort_order,custom_title,req.params.id]);
  res.json({ok:true});
});
app.delete('/api/admin/featured/:id', auth, role('admin'), async (req,res)=>{
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
app.post('/api/admin/config/blowplus-banner', auth, role('admin'), async (req,res)=>{
  try {
    if(req.user.role!=='admin') return res.status(403).json({error:'No autorizado'});
    const {title, subtitle} = req.body;
    await db.query("INSERT INTO app_config(key,value) VALUES('blowplus_banner',$1) ON CONFLICT(key) DO UPDATE SET value=$1",
      [JSON.stringify({title:(title||'').slice(0,200), subtitle:(subtitle||'').slice(0,300)})]);
    res.json({ok:true});
  } catch(e) { console.error('blowplus-banner error:', e.message); res.status(500).json({error:'Error interno. Intentá de nuevo.'}); }
});


// ── TOP CUSTOMERS (admin: all app, owner: their business) ──
app.get('/api/admin/top-customers', auth, role('admin'), async (req,res)=>{
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
  } catch(e){ res.status(500).json({error:'Error interno. Intentá de nuevo.'}); }
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
  } catch(e){ res.status(500).json({error:'Error interno. Intentá de nuevo.'}); }
});

// ── ASSIGN COUPON TO USER ──
app.post('/api/admin/coupons/:id/assign', auth, role('admin'), async (req,res)=>{
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
  } catch(e){ res.status(500).json({error:'Error interno. Intentá de nuevo.'}); }
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
  } catch(e){ res.status(500).json({error:'Error interno. Intentá de nuevo.'}); }
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
  const {name, phone} = req.body;
  if (!name) return res.status(400).json({error:'Nombre requerido'});
  const cleanName = sanitize(name, 100);
  if (!cleanName) return res.status(400).json({error:'Nombre invalido'});
  try {
    await db.query('UPDATE users SET name=$1, phone=$2 WHERE id=$3',
      [cleanName, sanitize(phone||'', 30)||null, req.user.id]);
    const updated = await q1('SELECT id,name,email,phone,role,avatar_url,blow_plus,blow_plus_expires FROM users WHERE id=$1',[req.user.id]);
    res.json({ok:true, user: updated});
  } catch(e) {
    res.status(500).json({error:'Error interno. Intenta de nuevo.'});
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
  } catch(e) { res.status(500).json({error:'Error interno. Intentá de nuevo.'}); }
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
    console.log(`\n⚡  Blow v4 → http://localhost:${PORT}`);
    console.log(`🐘  PostgreSQL  : ${process.env.DATABASE_URL?'✅ configurado':'❌ falta DATABASE_URL'}`);
    console.log(`☁️   Cloudinary  : ${cloudinary?'✅ configurado':'⚠️  no configurado'}`);
    console.log(`🔑  MP Token    : ${process.env.MP_ACCESS_TOKEN?.startsWith('APP_USR-')?'✅ OK':'❌ falta'}`);
    console.log(`🔐  JWT         : ${process.env.JWT_SECRET!=='dev_secret_cambiar_en_prod'?'✅ OK':'⚠️  cambiar'}\n`);
  });

  // ── Schedule auto-open/close (cada minuto) ──
  setInterval(async () => {
    try {
      const businesses = await qa(`SELECT id, is_open, schedule FROM businesses WHERE schedule IS NOT NULL`,[]);
      const now = new Date();
      // Usar timezone de Montevideo correctamente en vez de offset fijo
      const uyNowStr = now.toLocaleString('en-US', { timeZone: 'America/Montevideo' });
      const uyNow = new Date(uyNowStr);
      const dayNames = ['sun','mon','tue','wed','thu','fri','sat'];
      const dayKey = dayNames[uyNow.getDay()];
      const currentMins = uyNow.getHours() * 60 + uyNow.getMinutes();

      for (const biz of businesses) {
        let sched;
        try { sched = typeof biz.schedule === 'string' ? JSON.parse(biz.schedule) : biz.schedule; }
        catch(_) { continue; }
        if (!sched || !sched[dayKey]) continue;
        const { open, close, enabled } = sched[dayKey];
        if (!enabled) continue;
        const [oh,om] = open.split(':').map(Number);
        const [ch,cm] = close.split(':').map(Number);
        const openMins  = oh * 60 + om;
        const closeMins = ch * 60 + cm;
        const shouldBeOpen = currentMins >= openMins && currentMins < closeMins;
        if (shouldBeOpen !== biz.is_open) {
          await q(`UPDATE businesses SET is_open=$1 WHERE id=$2`,[shouldBeOpen, biz.id]);
          console.log(`⏰ Schedule: ${biz.id} → ${shouldBeOpen ? 'ABIERTO' : 'CERRADO'}`);
        }
      }
    } catch(e) { console.error('Schedule cron error:', e.message); }
  }, 60000); // cada 60 segundos

  // ── Auto-cancel stale pending orders (cada 5 minutos) ──
  setInterval(async () => {
    try {
      // Cancelar pedidos 'pending' sin pago después de 30 minutos
      const stalePending = await qa(
        `SELECT id, customer_id, business_id FROM orders WHERE status='pending' AND created_at < NOW() - INTERVAL '30 minutes'`, []
      );
      for (const order of stalePending) {
        await q(`UPDATE orders SET status='cancelled', cancel_reason='Pago no completado (expirado)', cancelled_at=NOW(), updated_at=NOW() WHERE id=$1`, [order.id]);
        const items = await qa('SELECT product_id, quantity FROM order_items WHERE order_id=$1', [order.id]);
        for (const item of items) {
          await q('UPDATE products SET stock = stock + $1, is_available = TRUE WHERE id=$2 AND stock IS NOT NULL', [item.quantity, item.product_id]);
        }
        notify(order.customer_id, { type:'order_cancelled', message:`Tu pedido #${order.id.slice(-6).toUpperCase()} fue cancelado por falta de pago.`, order_id:order.id });
        const biz = await q1('SELECT owner_id FROM businesses WHERE id=$1', [order.business_id]);
        if (biz) notify(biz.owner_id, { type:'order_cancelled', message:`Pedido #${order.id.slice(-6).toUpperCase()} cancelado (pago expirado)`, order_id:order.id });
        console.log(`🗑️ Auto-cancelled stale pending order: ${order.id}`);
      }

      // Cancelar pedidos 'paid' sin aceptar después de 2 horas + reembolso automático
      const stalePaid = await qa(
        `SELECT * FROM orders WHERE status='paid' AND created_at < NOW() - INTERVAL '2 hours'`, []
      );
      for (const order of stalePaid) {
        await q(`UPDATE orders SET status='cancelled', cancel_reason='Negocio no respondió a tiempo', cancelled_at=NOW(), updated_at=NOW() WHERE id=$1`, [order.id]);
        const items = await qa('SELECT product_id, quantity FROM order_items WHERE order_id=$1', [order.id]);
        for (const item of items) {
          await q('UPDATE products SET stock = stock + $1, is_available = TRUE WHERE id=$2 AND stock IS NOT NULL', [item.quantity, item.product_id]);
        }
        // Reembolso automático MP
        if (mp && order.mp_payment_id && order.payment_method === 'mercadopago') {
          try {
            await mp.payment.refund(order.mp_payment_id);
            console.log(`💸 Auto-refund for unaccepted order: ${order.id}`);
          } catch(refundErr) {
            console.error(`❌ Auto-refund failed for order ${order.id}:`, refundErr.message);
          }
        }
        notify(order.customer_id, { type:'order_cancelled', message:`❌ Tu pedido #${order.id.slice(-6).toUpperCase()} fue cancelado porque el negocio no respondió. El reembolso se procesará automáticamente.`, order_id:order.id });
        const biz = await q1('SELECT owner_id FROM businesses WHERE id=$1', [order.business_id]);
        if (biz) notify(biz.owner_id, { type:'order_cancelled', message:`⚠️ Pedido #${order.id.slice(-6).toUpperCase()} cancelado automáticamente por falta de respuesta.`, order_id:order.id });
        console.log(`🗑️ Auto-cancelled unaccepted paid order: ${order.id}`);
      }
    } catch(e) { console.error('Stale orders cleanup error:', e.message); }
  }, 5 * 60000); // cada 5 minutos

  // ── Auto-suspend expired subscriptions (cada 30 minutos) ──
  setInterval(async () => {
    try {
      const expired = await qa(
        `SELECT s.id, s.business_id, s.owner_id FROM subscriptions s
         WHERE s.status='active' AND s.current_period_end IS NOT NULL AND s.current_period_end < NOW()`, []
      );
      for (const sub of expired) {
        await q("UPDATE subscriptions SET status='past_due', updated_at=NOW() WHERE id=$1", [sub.id]);
        // Close the business so it stops receiving orders
        await q("UPDATE businesses SET is_open=FALSE WHERE id=$1", [sub.business_id]);
        notify(sub.owner_id, { type:'subscription_issue', message:'⚠️ Tu suscripción venció. Renovála para seguir recibiendo pedidos.' });
        console.log(`⏰ Subscription expired: business ${sub.business_id}`);
      }
    } catch(e) { console.error('Subscription expiry check error:', e.message); }
  }, 30 * 60000); // cada 30 minutos

}).catch(e=>{ console.error('❌ Error DB:',e.message); process.exit(1); });

// ── Handlers globales para evitar crash del proceso ──
process.on('unhandledRejection', (reason, promise) => {
  console.error('⚠️  Unhandled Rejection:', reason?.message || reason);
});
process.on('uncaughtException', (err) => {
  console.error('⚠️  Uncaught Exception:', err.message);
  // No hacer process.exit — Railway reinicia si es necesario
});
