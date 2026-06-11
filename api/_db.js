// Общий модуль для работы с базой Neon (Postgres).
// Берёт строку подключения из любой из стандартных переменных,
// которые создаёт интеграция Neon на Vercel.

import { neon } from '@neondatabase/serverless';

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
  // профили волонтёров: телефон — логин (без подтверждения)
  await sql`
    CREATE TABLE IF NOT EXISTS volunteers (
      phone       TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      birthday    TEXT,
      created_at  TIMESTAMPTZ DEFAULT now()
    )`;
  // поля логина/пароля сканера билетов на событии (вводит координатор)
  await sql`ALTER TABLE events ADD COLUMN IF NOT EXISTS scan_login TEXT`;
  await sql`ALTER TABLE events ADD COLUMN IF NOT EXISTS scan_pass TEXT`;
  ready = true;
}

export { sql };

// Простой общий секрет для координаторских действий.
// Меняется через переменную окружения COORD_PIN в Vercel.
export function checkPin(req) {
  const pin = process.env.COORD_PIN || '1234';
  const given = req.headers['x-coord-pin'];
  return given && given === pin;
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
