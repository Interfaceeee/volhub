// Общий модуль для работы с базой Neon (Postgres).
// Берёт строку подключения из любой из стандартных переменных,
// которые создаёт интеграция Neon на Vercel.

import { neon } from '@neondatabase/serverless';
import { scryptSync, randomBytes, timingSafeEqual } from 'crypto';

const CONN =
  process.env.DATABASE_URL ||
  process.env.POSTGRES_URL ||
  process.env.POSTGRES_URL_NON_POOLING ||
  process.env.POSTGRES_URL_NO_SSL;

const sql = neon(CONN);

// Создаёт таблицы при первом обращении (безопасно вызывать всегда).
let ready = false;
export async function ensureSchema() {
  if (ready) return;
  await sql`
    CREATE TABLE IF NOT EXISTS events (
      id          TEXT PRIMARY KEY,
      title       TEXT NOT NULL,
      date        TEXT,
      place       TEXT,
      need        INTEGER DEFAULT 4,
      source      TEXT DEFAULT 'manual',
      created_at  TIMESTAMPTZ DEFAULT now()
    )`;
  await sql`
    CREATE TABLE IF NOT EXISTS signups (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      phone       TEXT NOT NULL,
      event_id    TEXT NOT NULL,
      status      TEXT DEFAULT 'pending',
      badge       BOOLEAN DEFAULT false,
      vest        BOOLEAN DEFAULT false,
      created_at  TIMESTAMPTZ DEFAULT now()
    )`;
  // профили волонтёров: телефон — логин, плюс пароль (хэш)
  await sql`
    CREATE TABLE IF NOT EXISTS volunteers (
      phone       TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      birthday    TEXT,
      pass_hash   TEXT,
      created_at  TIMESTAMPTZ DEFAULT now()
    )`;
  await sql`ALTER TABLE volunteers ADD COLUMN IF NOT EXISTS pass_hash TEXT`;
  // Telegram: chat_id для отправки уведомлений и временный код привязки
  await sql`ALTER TABLE volunteers ADD COLUMN IF NOT EXISTS tg_chat_id TEXT`;
  await sql`ALTER TABLE volunteers ADD COLUMN IF NOT EXISTS tg_code TEXT`;
  // именованные учётки координаторов (логин + хэш пароля)
  await sql`
    CREATE TABLE IF NOT EXISTS coordinators (
      login       TEXT PRIMARY KEY,
      name        TEXT,
      pass_hash   TEXT NOT NULL,
      created_at  TIMESTAMPTZ DEFAULT now()
    )`;
  // поля логина/пароля сканера билетов на событии (вводит координатор)
  await sql`ALTER TABLE events ADD COLUMN IF NOT EXISTS scan_login TEXT`;
  await sql`ALTER TABLE events ADD COLUMN IF NOT EXISTS scan_pass TEXT`;
  await sql`ALTER TABLE events ADD COLUMN IF NOT EXISTS time TEXT`;
  await sql`ALTER TABLE events ADD COLUMN IF NOT EXISTS image TEXT`;
  ready = true;
}

export { sql };

// Хэш пароля: scrypt с солью. Формат "соль:хэш" (hex).
export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(String(password), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}
export function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  const test = scryptSync(String(password), salt, 64).toString('hex');
  try { return timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(test, 'hex')); }
  catch { return false; }
}

// Старый общий PIN — остаётся как "мастер-вход" для первого координатора.
export function checkPin(req) {
  const pin = process.env.COORD_PIN || '1234';
  const given = req.headers['x-coord-pin'];
  return given && given === pin;
}

// Полная проверка прав координатора: либо мастер-PIN, либо валидная учётка.
// Заголовки: x-coord-pin (мастер) ИЛИ x-coord-login + x-coord-pass.
export async function checkCoordinator(req) {
  if (checkPin(req)) return { ok: true, login: 'master' };
  const login = req.headers['x-coord-login'];
  const pass = req.headers['x-coord-pass'];
  if (!login || !pass) return { ok: false };
  const rows = await sql`SELECT login, pass_hash FROM coordinators WHERE login = ${login}`;
  if (!rows.length) return { ok: false };
  if (!verifyPassword(pass, rows[0].pass_hash)) return { ok: false };
  return { ok: true, login };
}

// Помогает читать JSON-тело запроса в serverless-функции.
export async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  let raw = '';
  for await (const chunk of req) raw += chunk;
  try { return raw ? JSON.parse(raw) : {}; } catch { return {}; }
}

export function uid() {
  return Math.random().toString(36).slice(2, 10);
}

// 8-значный числовой код события (10000000–99999999)
export function eventId() {
  return String(Math.floor(10000000 + Math.random() * 90000000));
}

// Отправка сообщения в Telegram через Bot API. Токен — в переменной TELEGRAM_BOT_TOKEN.
export async function tgSend(chatId, text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token || !chatId) return false;
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
    });
    return r.ok;
  } catch (_) { return false; }
}
