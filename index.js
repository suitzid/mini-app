// Orenix Mini App — сервер: Telegram-бот (Stars), API для мини-аппа, выдача покупок через админ-аккаунт.
// Запуск: node --env-file=.env index.js   (Node 20.6+)
import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
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

if (!BOT_TOKEN  !PUBLIC_URL  !ADMIN_EMAIL || !ADMIN_PASSWORD) {
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
    if (retry && (m.includes('jwt')  m.includes('forbidden')  error.code === 'PGRST301')) {
      await adminLogin();
      return rpc(name, args, false);
    }
    throw new Error(${name}: ${error.message});
  }
  return data;
}
const one = (d) => (Array.isArray(d) ? d[0] : d);

/* ---------------- Telegram Bot API ---------------- */
async function tg(method, body = {}) {
  const r = await fetch(https://api.telegram.org/bot${BOT_TOKEN}/${method}, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
  });
  const j = await r.json();
  if (!j.ok) throw new Error(${method}: ${j.description});
  return j.result;
}
const say = (chat_id, text, extra = {}) => tg('sendMessage', { chat_id, text, ...extra }).catch((e) => console.error('sendMessage', e.message));

function verifyInitData(raw) {
  if (!raw) return null;
  const p = new URLSearchParams(raw);
  const hash = p.get('hash');
  if (!hash) return null;
  p.delete('hash');
  const check = [...p.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => ${k}=${v}).join('\n');
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
    for (const [fn, key] of [['admin_search_user', 'p_query'], ['admin_users_find', 'p_query']]) {app.post('/api/order', wrap(async (req, res) => {
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
  res.json({ greeting: s.general.supportGreeting  '', messages: (msgs  []).map((m) => ({ id: m.id, fromAdmin: m.from_admin, body: m.body, at: m.created_at })) });
}));

app.post('/api/support', wrap(async (req, res) => {
  const u = req.tgUser;
  if (limited('sup:' + u.id, 1500)) return res.status(429).json({ error: 'Слишком часто' });
  const body = String((req.body && req.body.body) || '').trim().slice(0, 2000);
  if (!body) return res.status(400).json({ error: 'Пустое сообщение' });
  await rpc('mini_get_or_create_user', { p_tg_id: u.id, p_username: u.username  null, p_first_name: u.first_name  null });
  await rpc('mini_support_send', { p_tg_id: u.id, p_body: body });
  res.json({ ok: true });
}));

/* ---------------- старт ---------------- */
await adminLogin();
await tg('deleteWebhook', { drop_pending_updates: false }).catch(() => {});
await tg('setChatMenuButton', { menu_button: { type: 'web_app', text: 'Orenix', web_app: { url: PUBLIC_URL } } }).catch((e) => console.error('menu', e.message));
app.listen(PORT, () => console.log('Mini App server: http://localhost:' + PORT));
pollLoop();