// Orenix Mini App — сервер: Telegram-бот (Stars), API для мини-аппа, выдача покупок через админ-аккаунт.
// Запуск: node --env-file=.env index.js (Node 20.6+)
import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';

const env = process.env;
const BOT_TOKEN = env.BOT_TOKEN;
const PUBLIC_URL = (env.PUBLIC_URL || '').replace(/\/$/, '');
const PORT = Number(env.PORT || 3000);
const SUPABASE_URL = env.SUPABASE_URL || 'https://plysapfztvihxkioxtch.supabase.co';
const SUPABASE_KEY = env.SUPABASE_KEY || 'sb_publishable_4diavlnDFnk4B4JoFt0MSQ_UeIaycEI';
const ADMIN_EMAIL = env.BOT_ADMIN_EMAIL;
const ADMIN_PASSWORD = env.BOT_ADMIN_PASSWORD;

if (!BOT_TOKEN || !PUBLIC_URL || !ADMIN_EMAIL || !ADMIN_PASSWORD) {
  console.error('Заполните .env: BOT_TOKEN, PUBLIC_URL, BOT_ADMIN_EMAIL, BOT_ADMIN_PASSWORD');
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false, autoRefreshToken: true } });

/* ---------------- вход бота как админ ---------------- */
async function adminLogin() {
  const base = ADMIN_PASSWORD;
  const variants = [...new Set([base, base.toLowerCase(), base.charAt(0).toUpperCase() + base.slice(1).toLowerCase()])];
  let lastErr;
  for (const pw of variants) {
    const { error } = await sb.auth.signInWithPassword({ email: ADMIN_EMAIL, password: pw });
    if (!error) { console.log('Админ-аккаунт бота: вход выполнен'); return; }
    lastErr = error;
  }
  throw new Error('Не удалось войти в админ-аккаунт бота: ' + (lastErr && lastErr.message));
}

async function rpc(name, args = {}, retry = true) {
  const { data, error } = await sb.rpc(name, args);
  if (error) {
    const m = String(error.message || '').toLowerCase();
    if (retry && (m.includes('jwt') || m.includes('forbidden') || error.code === 'PGRST301')) {
      await adminLogin();
      return rpc(name, args, false);
    }
    throw new Error(`${name}: ${error.message}`);
  }
  return data;
}
const one = (d) => (Array.isArray(d) ? d[0] : d);

/* ---------------- Telegram Bot API ---------------- */
async function tg(method, body = {}) {
  const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
  });
  const j = await r.json();
  if (!j.ok) throw new Error(`${method}: ${j.description}`);
  return j.result;
}
const say = (chat_id, text, extra = {}) =>
  tg('sendMessage', { chat_id, text, ...extra }).catch((e) => console.error('sendMessage', e.message));

function verifyInitData(raw) {
  if (!raw) return null;
  const p = new URLSearchParams(raw);
  const hash = p.get('hash');
  if (!hash) return null;
  p.delete('hash');
  const check = [...p.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const calc = crypto.createHmac('sha256', secret).update(check).digest('hex');
  const a = Buffer.from(calc), b = Buffer.from(hash);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  if (Date.now() / 1000 - Number(p.get('auth_date') || 0) > 86400) return null;
  try { return JSON.parse(p.get('user')); } catch { return null; }
}

/* ---------------- аккаунт мессенджера ---------------- */
const digits = (s) => String(s || '').replace(/\D/g, '');

async function findProfileId(tgId) {
  const info = one(await rpc('mini_user_info', { p_tg_id: tgId }));
  if (!info) return null;
  if (info.profile_id) return info.profile_id;
  for (const num of info.numbers || []) {
    for (const [fn, key] of [['admin_search_user', 'p_query'], ['admin_users_find', 'p_query']]) {
      for (const q of [num, digits(num)]) {
        try {
          const rows = await rpc(fn, { [key]: q });
          const hit = (rows || []).find((r) => digits(r.phone) === digits(num));
          const id = hit && (hit.id || hit.user_id);
          if (id) { await rpc('mini_link_profile', { p_tg_id: tgId, p_profile: id }); return id; }
        } catch (e) { /* пробуем следующий способ поиска */ }
      }
    }
  }
  return null;
}

/* ---------------- магазин ---------------- */
async function getSettings() {
  const s = (await rpc('mini_settings_all')) || {};
  return { shop: Array.isArray(s.shop) ? s.shop : [], ad: s.ad || { enabled: false }, general: s.general || {} };
}
const publicProduct = (p) => ({ id: p.id, kind: p.kind, title: p.title, desc: p.desc, stars: p.stars });

async function usernameTaken(name) {
  for (const fn of ['resolve_extra_username_any', 'resolve_username']) {
    try {
      const d = await rpc(fn, { p_username: '@' + name });
      const row = one(d);
      if (row && (row.id || row.type || typeof row === 'string')) return true;
    } catch (e) { /* функция может не принимать такой параметр — проверит выдача */ }
  }
  return false;
}

async function fulfill(order) {
  const tgId = Number(order.tg_id);
  const profile = await findProfileId(tgId);
  if (!profile) throw new Error('Аккаунт в мессенджере не найден');
  const pl = order.payload || {};
  switch (order.kind) {
    case 'premium': {
      let days = Number(pl.days || 30);
      try {
        const cur = one(await rpc('admin_get_premium', { p_target: profile }));
        if (cur && cur.is_premium && cur.premium_until) {
          const left = Math.ceil((new Date(cur.premium_until).getTime() - Date.now()) / 86400000);
          if (left > 0) days += left;
        }
      } catch (e) { /* без продления */ }
      await rpc('admin_set_premium', { p_target: profile, p_value: true, p_days: days });
      return 'Orenix Premium активирован на ' + days + ' дн.';
    }
    case 'phone': {
      const label = await rpc('mini_gen_phone');
      await rpc('mini_register_number', { p_tg_id: tgId, p_phone: label });
      await rpc('admin_user_set_phone', { p_user: profile, p_phone: label });
      return 'Новый номер: ' + label + '\nПрежний номер сохранён у вас как дополнительный.';
    }
    case 'username': {
      const name = String(pl.username || '');
      if (!/^[A-Za-z0-9_]{4,32}$/.test(name)) throw new Error('Некорректный юзернейм');
      await rpc('admin_extra_username_add', { p_type: 'user', p_id: String(profile), p_username: '@' + name });
      return 'Дополнительный юзернейм @' + name + ' добавлен.';
    }
    case 'coins': {
      const n = Number(pl.coins || 0);
      if (!(n > 0)) throw new Error('Некорректное количество монет');
      await rpc('admin_adjust_balance', { p_target: profile, p_amount: n, p_reason: 'Mini App · покупка за Stars' });
      return 'Начислено ' + n + ' Cat Coin.';
    }
    default: throw new Error('Неизвестный тип товара');
  }
}

async function processPayment(msg) {
  const sp = msg.successful_payment;
  const orderId = sp.invoice_payload;
  const first = await rpc('mini_order_mark_paid', { p_id: orderId, p_charge: sp.telegram_payment_charge_id });
  if (!first) return; // уже обработан
  const order = one(await rpc('mini_order_get', { p_id: orderId }));
  try {
    const text = await fulfill(order);
    await rpc('mini_order_set_status', { p_id: orderId, p_status: 'granted', p_error: null });
    await say(msg.chat.id, '✅ Покупка выдана\n' + text);
  } catch (e) {
    console.error('Выдача не удалась', orderId, e.message);
    let refunded = false;
    try {
      await tg('refundStarPayment', { user_id: msg.from.id, telegram_payment_charge_id: sp.telegram_payment_charge_id });
      refunded = true;
    } catch (er) { console.error('refund', er.message); }
    await rpc('mini_order_set_status', { p_id: orderId, p_status: refunded ? 'refunded' : 'failed', p_error: e.message }).catch(() => {});
    await say(msg.chat.id, refunded
      ? '⚠️ Не удалось выдать покупку, Stars возвращены. Попробуйте ещё раз или напишите в поддержку в мини-аппе.'
      : '⚠️ Не удалось выдать покупку. Напишите в поддержку в мини-аппе — всё исправим.');
  }
}

/* ---------------- обновления бота (long polling) ---------------- */
async function handleUpdate(u) {
  try {
    if (u.pre_checkout_query) {
      const q = u.pre_checkout_query;
      let ok = false, err = 'Заказ не найден';
      try {
        const o = one(await rpc('mini_order_get', { p_id: q.invoice_payload }));
        ok = !!o && o.status === 'pending' && Number(o.tg_id) === q.from.id && Number(o.stars) === q.total_amount;
        if (!ok) err = 'Заказ недействителен, откройте магазин заново';
      } catch (e) { err = 'Сервис временно недоступен'; }
      await tg('answerPreCheckoutQuery', ok
        ? { pre_checkout_query_id: q.id, ok: true }
        : { pre_checkout_query_id: q.id, ok: false, error_message: err });
    } else if (u.message && u.message.successful_payment) {
      await processPayment(u.message);
    } else if (u.message && typeof u.message.text === 'string' && u.message.text.startsWith('/start')) {
      await say(u.message.chat.id, 'Добро пожаловать в Orenix! Откройте мини-апп: там ваш номер для регистрации, код и магазин.', {
        reply_markup: { inline_keyboard: [[{ text: 'Открыть Orenix', web_app: { url: PUBLIC_URL } }]] }
      });
    }
  } catch (e) { console.error('update', e.message); }
}

async function pollLoop() {
  let offset = 0;
  for (;;) {
    try {
      const ups = await tg('getUpdates', { offset, timeout: 40, allowed_updates: ['message', 'pre_checkout_query'] });
      for (const u of ups) { offset = u.update_id + 1; handleUpdate(u); }
    } catch (e) {
      console.error('getUpdates', e.message);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

/* ---------------- HTTP API ---------------- */
const app = express();
app.use(express.json({ limit: '20kb' }));
const here = path.dirname(fileURLToPath(import.meta.url));
app.use(express.static(path.join(here, 'public')));
// страница мини-аппа: public/index.html, либо index.html / index-3.html рядом с index.js
app.get('/', (_req, res) => {
  for (const f of ['public/index.html', 'index.html', 'index-3.html']) {
    const p = path.join(here, f);
    if (fs.existsSync(p)) return res.sendFile(p);
  }
  res.status(404).send('index.html не найден');
});
app.get('/healthz', (_req, res) => res.send('ok'));

const hits = new Map();
function limited(key, ms) {
  const now = Date.now();
  if ((hits.get(key) || 0) + ms > now) return true;
  hits.set(key, now);
  return false;
}

app.use('/api', (req, res, next) => {
  const user = verifyInitData(req.get('x-initdata'));
  if (!user) return res.status(401).json({ error: 'Откройте мини-апп из Telegram' });
  req.tgUser = user;
  next();
});

const wrap = (fn) => (req, res) => fn(req, res).catch((e) => {
  console.error(req.path, e.message);
  res.status(500).json({ error: 'Ошибка сервера, попробуйте позже' });
});

app.get('/api/state', wrap(async (req, res) => {
  const u = req.tgUser;
  const me = one(await rpc('mini_get_or_create_user', { p_tg_id: u.id, p_username: u.username || null, p_first_name: u.first_name || null }));
  const [settings, profile, orders] = await Promise.all([
    getSettings(), findProfileId(u.id), rpc('mini_orders_list', { p_tg_id: u.id })
  ]);
  res.json({
    phone: me.phone, isNew: me.is_new, registered: !!profile,
    shop: settings.shop.filter((p) => p.enabled !== false).map(publicProduct),
    ad: settings.ad, general: settings.general,
    orders: (orders || []).map((o) => ({ id: o.id, title: o.title, stars: o.stars, status: o.status, createdAt: o.created_at }))
  });
}));

app.get('/api/code', wrap(async (req, res) => {
  const row = one(await rpc('mini_active_code', { p_tg_id: req.tgUser.id }));
  res.json(row ? { code: row.code, expiresAt: row.expires_at } : { code: null });
}));

app.post('/api/order', wrap(async (req, res) => {
  const u = req.tgUser;
  if (limited('order:' + u.id, 2500)) return res.status(429).json({ error: 'Слишком часто, подождите секунду' });
  const { productId, username } = req.body || {};
  const settings = await getSettings();
  const p = settings.shop.find((x) => x.id === productId && x.enabled !== false);
  if (!p) return res.status(404).json({ error: 'Товар недоступен' });
  const stars = Math.round(Number(p.stars));
  if (!(stars >= 1 && stars <= 10000)) return res.status(400).json({ error: 'Некорректная цена товара' });
  const profile = await findProfileId(u.id);
  if (!profile) return res.status(409).json({ error: 'Сначала зарегистрируйтесь в мессенджере со своим номером — покупки выдаются на аккаунт.' });

  const payload = {};
  if (p.kind === 'premium') {
    payload.days = Number(p.days || 30);
    try {
      const cur = one(await rpc('admin_get_premium', { p_target: profile }));
      if (cur && cur.is_premium && !cur.premium_until) return res.status(409).json({ error: 'У вас уже бессрочный Premium.' });
    } catch (e) { /* ignore */ }
  } else if (p.kind === 'coins') {
    payload.coins = Number(p.coins || 0);
  } else if (p.kind === 'username') {
    const name = String(username || '').replace(/^@/, '').trim();
    if (!/^[A-Za-z0-9_]{4,32}$/.test(name)) return res.status(400).json({ error: 'Юзернейм: 4–32 символа, латиница, цифры и _' });
    if (await usernameTaken(name)) return res.status(409).json({ error: '@' + name + ' уже занят' });
    payload.username = name;
  }

  const orderId = await rpc('mini_order_create', { p_tg_id: u.id, p_product_id: p.id, p_kind: p.kind, p_title: p.title, p_stars: stars, p_payload: payload });
  const link = await tg('createInvoiceLink', {
    title: String(p.title).slice(0, 32),
    description: String(p.desc || p.title).slice(0, 255),
    payload: orderId, currency: 'XTR',
    prices: [{ label: String(p.title).slice(0, 32), amount: stars }]
  });
  res.json({ link, orderId });
}));

app.get('/api/support', wrap(async (req, res) => {
  const [msgs, s] = await Promise.all([rpc('mini_support_list', { p_tg_id: req.tgUser.id }), getSettings()]);
  res.json({ greeting: s.general.supportGreeting || '', messages: (msgs || []).map((m) => ({ id: m.id, fromAdmin: m.from_admin, body: m.body, at: m.created_at })) });
}));

app.post('/api/support', wrap(async (req, res) => {
  const u = req.tgUser;
  if (limited('sup:' + u.id, 1500)) return res.status(429).json({ error: 'Слишком часто' });
  const body = String((req.body && req.body.body) || '').trim().slice(0, 2000);
  if (!body) return res.status(400).json({ error: 'Пустое сообщение' });
  await rpc('mini_get_or_create_user', { p_tg_id: u.id, p_username: u.username || null, p_first_name: u.first_name || null });
  await rpc('mini_support_send', { p_tg_id: u.id, p_body: body });
  res.json({ ok: true });
}));

/* ---------------- старт ---------------- */
await adminLogin();
await tg('deleteWebhook', { drop_pending_updates: false }).catch(() => {});
await tg('setChatMenuButton', { menu_button: { type: 'web_app', text: 'Orenix', web_app: { url: PUBLIC_URL } } }).catch((e) => console.error('menu', e.message));
app.listen(PORT, () => console.log('Mini App server: http://localhost:' + PORT));
pollLoop();
