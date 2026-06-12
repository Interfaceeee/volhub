// /api/events
//   GET    - публичный список событий из внешнего API Ticketon (kg-events)
//            (Кино и Туры исключаются — они не нужны волонтёрам)
//   POST   - add/update event (coordinator PIN)  [работает с локальной БД]
//   DELETE - remove event by ?id= (coordinator PIN)
import { sql, ensureSchema, checkCoordinator, readBody, uid, eventId } from './_db.js';

const TICKETON_URL = 'https://n8n.ticketon.kz/webhook/kg-events';

// Категории, которые НЕ показываем волонтёрам
const EXCLUDED_CATEGORIES = ['кино', 'туры'];

// "session_start_time" может прийти в разных форматах — нормализуем в {date:'YYYY-MM-DD', time:'HH:MM'}
function parseStart(raw) {
  if (!raw) return { date: null, time: null };
  const s = String(raw).trim();
  // ISO: 2026-06-20T19:30:00 / 2026-06-20T19:30:00.000Z
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
  if (m) return { date: `${m[1]}-${m[2]}-${m[3]}`, time: `${m[4]}:${m[5]}` };
  // только дата: 2026-06-20
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return { date: `${m[1]}-${m[2]}-${m[3]}`, time: null };
  // dd.mm.yyyy [HH:MM]
  m = s.match(/^(\d{2})\.(\d{2})\.(\d{4})(?:[ T](\d{2}):(\d{2}))?/);
  if (m) return { date: `${m[3]}-${m[2]}-${m[1]}`, time: m[4] ? `${m[4]}:${m[5]}` : null };
  // в крайнем случае — пробуем Date
  const d = new Date(s);
  if (!isNaN(d.getTime())) {
    const pad = n => String(n).padStart(2, '0');
    return { date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, time: `${pad(d.getHours())}:${pad(d.getMinutes())}` };
  }
  return { date: null, time: null };
}

function isExcluded(row) {
  const main = (row.event_category_name || '').toLowerCase().trim();
  if (EXCLUDED_CATEGORIES.includes(main)) return true;
  // проверяем и список categories на всякий случай
  const cats = Array.isArray(row.categories) ? row.categories : [];
  for (const c of cats) {
    const n = (c && c.name ? String(c.name) : '').toLowerCase().trim();
    if (EXCLUDED_CATEGORIES.includes(n)) return true;
  }
  return false;
}

async function fetchTicketonEvents() {
  const resp = await fetch(TICKETON_URL, { headers: { accept: 'application/json' } });
  if (!resp.ok) throw new Error('Ticketon ' + resp.status);
  const json = await resp.json();
  const rows = Array.isArray(json) ? json : (json.data || []);

  // схлопываем по event_id: одно событие = одна карточка (берём самый ранний сеанс)
  const byId = new Map();
  for (const row of rows) {
    if (isExcluded(row)) continue;
    const id = String(row.event_id);
    const { date, time } = parseStart(row.session_start_time);
    const existing = byId.get(id);
    if (!existing) {
      byId.set(id, {
        id,
        title: row.event_name || 'Без названия',
        date,
        time,
        place: row.venue_name || row.venue_address || null,
        address: row.venue_address || null,
        category: row.event_category_name || null,
        slug: row.event_slug || null,
        need: 4,            // дефолт: сколько волонтёров нужно
        source: 'ticketon',
        image: null,
        taken: 0,
        approved_count: 0,
      });
    } else {
      // если у уже сохранённого нет даты, а у этого есть — подставим; и берём более раннюю дату
      if (date && (!existing.date || date < existing.date)) {
        existing.date = date; existing.time = time;
      }
    }
  }
  return [...byId.values()];
}

export default async function handler(req, res) {
  if (req.method === 'GET') {
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    try {
      await ensureSchema();
      const events = await fetchTicketonEvents();
      // подтягиваем реальные счётчики записей из базы по всем событиям разом
      try {
        const counts = await sql`
          SELECT TRIM(event_id::text) AS eid,
            SUM(CASE WHEN status <> 'rejected' THEN 1 ELSE 0 END) AS taken,
            SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) AS approved_count
          FROM signups GROUP BY TRIM(event_id::text)`;
        const byEvent = {};
        for (const c of counts) byEvent[String(c.eid)] = c;
        for (const ev of events) {
          const c = byEvent[String(ev.id).trim()];
          if (c) { ev.taken = Number(c.taken) || 0; ev.approved_count = Number(c.approved_count) || 0; }
        }
      } catch (e) { console.error('count signups failed:', e && e.message); }
      // подмешиваем сохранённые координатором поля из базы (сканер, need, image, время)
      try {
        const overrides = await sql`SELECT id, need, scan_login, scan_pass, image, event_time FROM events`;
        const ovById = {};
        for (const o of overrides) ovById[String(o.id)] = o;
        for (const ev of events) {
          const o = ovById[String(ev.id)];
          if (o) {
            if (o.need != null) ev.need = Number(o.need);
            if (o.scan_login) ev.scan_login = o.scan_login;
            if (o.scan_pass) ev.scan_pass = o.scan_pass;
            if (o.image) ev.image = o.image;
            if (o.event_time && !ev.time) ev.time = o.event_time;
          }
        }
      } catch (e) { console.error('overrides failed:', e && e.message); }
      // сортировка по дате (без даты — в конец)
      events.sort((a, b) => {
        if (!a.date) return 1;
        if (!b.date) return -1;
        return a.date.localeCompare(b.date);
      });
      return res.status(200).json({ events });
    } catch (err) {
      console.error('Ticketon fetch failed:', err);
      return res.status(502).json({ error: 'upstream_failed', events: [] });
    }
  }

  // ===== Координаторские операции по-прежнему работают с локальной БД =====
  await ensureSchema();

  // ПУБЛИЧНО: кэшируем найденную фронтом афишу, чтобы не парсить заново.
  // PUT {id, image} — сохраняет картинку события (создаёт строку-заглушку при необходимости)
  if (req.method === 'PUT') {
    const b = await readBody(req);
    if (!b.id || !b.image) return res.status(400).json({ error: 'id and image required' });
    if (!/^https?:\/\//.test(String(b.image))) return res.status(400).json({ error: 'bad image url' });
    try {
      await sql`
        INSERT INTO events (id, title, source, image)
        VALUES (${String(b.id)}, ${b.title || 'Ticketon'}, 'ticketon', ${b.image})
        ON CONFLICT (id) DO UPDATE SET image = EXCLUDED.image`;
      return res.status(200).json({ ok: true });
    } catch (e) {
      console.error('cache poster failed:', e && e.message);
      return res.status(200).json({ ok: false });
    }
  }

  if (req.method === 'POST') {
    if (!(await checkCoordinator(req)).ok) return res.status(401).json({ error: 'Coordinator login required' });
    const b = await readBody(req);
    if (!b.title) return res.status(400).json({ error: 'Title required' });
    let id = b.id;
    if (!id) {
      do { id = eventId(); } while ((await sql`SELECT 1 FROM events WHERE id = ${id}`).length);
    }
    await sql`
      INSERT INTO events (id, title, date, event_time, place, need, source, scan_login, scan_pass, image)
      VALUES (${id}, ${b.title}, ${b.date || null}, ${b.time || null}, ${b.place || null},
              ${b.need || 4}, ${b.source || 'manual'},
              ${b.scan_login || null}, ${b.scan_pass || null}, ${b.image || null})
      ON CONFLICT (id) DO UPDATE SET
        title = EXCLUDED.title, date = EXCLUDED.date, event_time = EXCLUDED.event_time,
        place = EXCLUDED.place, need = EXCLUDED.need,
        scan_login = EXCLUDED.scan_login, scan_pass = EXCLUDED.scan_pass,
        image = COALESCE(EXCLUDED.image, events.image)`;
    return res.status(200).json({ ok: true, id });
  }

  if (req.method === 'DELETE') {
    if (!(await checkCoordinator(req)).ok) return res.status(401).json({ error: 'Coordinator login required' });
    const id = req.query.id;
    if (!id) return res.status(400).json({ error: 'id required' });
    await sql`DELETE FROM signups WHERE event_id = ${id}`;
    await sql`DELETE FROM events WHERE id = ${id}`;
    return res.status(200).json({ ok: true });
  }

  res.status(405).json({ error: 'Method not allowed' });
}
