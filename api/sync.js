// /api/sync — собирает события с афиши Тикетона и кладёт в базу.
// Вызывается вручную кнопкой в интерфейсе (с PIN) и автоматически по Cron.
//
// ВАЖНО про надёжность:
// Тикетон рендерит афишу на сервере, поэтому события обычно есть прямо
// в HTML страницы. Мы парсим ссылки вида /{категория}/event/{slug}.
// Если разработчики Тикетона дадут JSON-эндпоинт афиши — заменишь блок
// fetchCategory ниже на запрос к нему, остальное менять не нужно.

import { sql, ensureSchema, checkPin } from './_db.js';

const BASE = 'https://ticketon.kg';
// какие разделы афиши Бишкека собираем
const CATEGORIES = [
  'concerts', 'theatres', 'stand-up', 'sports',
  'entertainment', 'master-classes', 'children',
];

// Достаём события из сырого HTML страницы категории.
function parseEvents(html, category) {
  const found = new Map();
  // ссылки на конкретные события
  const re = /href="(\/[a-z0-9-]+\/event\/[a-z0-9-]+)"/gi;
  let m;
  while ((m = re.exec(html))) {
    const href = m[1];
    if (found.has(href)) continue;
    // вытащим кусок HTML вокруг ссылки, чтобы найти заголовок
    const idx = m.index;
    const chunk = html.slice(idx, idx + 600);
    // заголовок: первый осмысленный текст после ссылки
    const titleMatch = chunk.match(/>([^<>{]{3,90})</);
    const slug = href.split('/').pop();
    const title = (titleMatch && titleMatch[1].trim()) ||
      slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    found.set(href, {
      id: href,                 // ссылка как стабильный id
      title: title.slice(0, 120),
      url: BASE + href,
      category,
    });
  }
  return [...found.values()];
}

async function fetchCategory(category) {
  const url = `${BASE}/bishkek/${category}`;
  const r = await fetch(url, {
    headers: { 'user-agent': 'Mozilla/5.0 VolHub sync' },
  });
  if (!r.ok) return [];
  const html = await r.text();
  return parseEvents(html, category);
}

export default async function handler(req, res) {
  await ensureSchema();

  // Cron Vercel шлёт заголовок authorization c CRON_SECRET.
  // Ручной вызов из интерфейса — с PIN координатора.
  const cronOk = req.headers['authorization'] === `Bearer ${process.env.CRON_SECRET}`;
  if (!cronOk && !checkPin(req)) {
    return res.status(401).json({ error: 'Не авторизовано' });
  }

  let collected = [];
  const errors = [];
  for (const cat of CATEGORIES) {
    try {
      const evs = await fetchCategory(cat);
      collected = collected.concat(evs);
    } catch (e) {
      errors.push(`${cat}: ${String(e).slice(0, 60)}`);
    }
  }

  // Защита: если ничего не нашли — НЕ трогаем базу.
  if (collected.length === 0) {
    return res.status(200).json({
      ok: false,
      added: 0,
      note: 'Не удалось распознать события на афише. База не тронута.',
      errors,
    });
  }

  // Добавляем новые события (существующие — обновляем заголовок).
  // Источник 'auto' — чтобы отличать от добавленных вручную.
  let added = 0;
  for (const e of collected) {
    const r = await sql`
      INSERT INTO events (id, title, date, place, need, source)
      VALUES (${e.id}, ${e.title}, ${null}, ${e.url}, ${4}, 'auto')
      ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title
      RETURNING (xmax = 0) AS inserted`;
    if (r[0] && r[0].inserted) added++;
  }

  res.status(200).json({ ok: true, total: collected.length, added, errors });
}
