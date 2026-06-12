// Shared module for the Neon (Postgres) database.
// Reads the connection string from any of the standard env vars
// created by the Neon integration on Vercel.

import { neon } from '@neondatabase/serverless';
import { scryptSync, randomBytes, timingSafeEqual } from 'crypto';

const CONN =
  process.env.DATABASE_URL ||
  process.env.POSTGRES_URL ||
  process.env.POSTGRES_URL_NON_POOLING ||
  process.env.POSTGRES_URL_NO_SSL;

const sql = neon(CONN);

// Creates tables on first call (safe to call every time).
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
  // volunteer profiles: phone is the login, plus password hash
  await sql`
    CREATE TABLE IF NOT EXISTS volunteers (
      phone       TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      birthday    TEXT,
      pass_hash   TEXT,
      created_at  TIMESTAMPTZ DEFAULT now()
    )`;
  await sql`ALTER TABLE volunteers ADD COLUMN IF NOT EXISTS pass_hash TEXT`;
  // Telegram: chat_id for notifications and a temporary linking code
  await sql`ALTER TABLE volunteers ADD COLUMN IF NOT EXISTS tg_chat_id TEXT`;
  await sql`ALTER TABLE volunteers ADD COLUMN IF NOT EXISTS tg_code TEXT`;
  await sql`ALTER TABLE volunteers ADD COLUMN IF NOT EXISTS avatar TEXT`;
  // named coordinator accounts (login + password hash)
  await sql`
    CREATE TABLE IF NOT EXISTS coordinators (
      login       TEXT PRIMARY KEY,
      name        TEXT,
      pass_hash   TEXT NOT NULL,
      created_at  TIMESTAMPTZ DEFAULT now()
    )`;
  // ticket scanner login/pass fields per event (set by coordinator)
  await sql`ALTER TABLE events ADD COLUMN IF NOT EXISTS scan_login TEXT`;
  await sql`ALTER TABLE events ADD COLUMN IF NOT EXISTS scan_pass TEXT`;
  await sql`ALTER TABLE events ADD COLUMN IF NOT EXISTS event_time TEXT`;
  await sql`ALTER TABLE events ADD COLUMN IF NOT EXISTS image TEXT`;
  ready = true;
}

export { sql };

// Password hash: scrypt with salt. Format "salt:hash" (hex).
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

// Legacy shared PIN - kept as master login for the first coordinator.
export function checkPin(req) {
  const pin = process.env.COORD_PIN || '1234';
  const given = req.headers['x-coord-pin'];
  return given && given === pin;
}

// Full coordinator auth: master PIN or a valid account.
// Headers: x-coord-pin (master) OR x-coord-login + x-coord-pass.
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

// Reads the JSON request body in a serverless function.
export async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  let raw = '';
  for await (const chunk of req) raw += chunk;
  try { return raw ? JSON.parse(raw) : {}; } catch { return {}; }
}

export function uid() {
  return Math.random().toString(36).slice(2, 10);
}

// 8-digit numeric event code (10000000-99999999)
export function eventId() {
  return String(Math.floor(10000000 + Math.random() * 90000000));
}

// Send a Telegram message via Bot API. Token in TELEGRAM_BOT_TOKEN env var.
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
