// Общий модуль для работы с базой Neon (Postgres).
// Использует переменную окружения DATABASE_URL, которую Vercel
// подставит автоматически после подключения интеграции Neon.

import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.DATABASE_URL);

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
