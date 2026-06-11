// /api/events
//   GET    — список событий (для всех)
//   POST   — добавить событие (нужен PIN координатора)
//   DELETE — удалить событие по ?id= (нужен PIN)
import { sql, ensureSchema, checkCoordinator, readBody, uid, eventId } from './_db.js';

export default async function handler(req, res) {
  await ensureSchema();

  if (req.method === 'GET') {
    // Координатор (с входом) получает полные данные, включая логин/пароль сканера.
    if ((await checkCoordinator(req)).ok) {
      const events = await sql`
        SELECT e.*,
          (SELECT COUNT(*) FROM signups s
            WHERE s.event_id = e.id AND s.status <> 'rejected') AS taken
        FROM events e
        ORDER BY e.date NULLS LAST, e.created_at`;
      return res.status(200).json({ events });
    }
    // ВАЖНО: scan_login/scan_pass НЕ отдаём в общий список (это секрет).
    const events = await sql`
      SELECT e.id, e.title, e.date, e.place, e.need, e.source, e.created_at,
        (SELECT COUNT(*) FROM signups s
          WHERE s.event_id = e.id AND s.status <> 'rejected') AS taken
      FROM events e
      ORDER BY e.date NULLS LAST, e.created_at`;
    return res.status(200).json({ events });
  }

  if (req.method === 'POST') {
    if (!(await checkCoordinator(req)).ok) return res.status(401).json({ error: 'Нужен вход координатора' });
    const b = await readBody(req);
    if (!b.title) return res.status(400).json({ error: 'Нужно название' });
    let id = b.id;
    if (!id) {
      // генерируем уникальный 8-значный код
      do { id = eventId(); } while ((await sql`SELECT 1 FROM events WHERE id = ${id}`).length);
    }
    await sql`
      INSERT INTO events (id, title, date, place, need, source, scan_login, scan_pass)
      VALUES (${id}, ${b.title}, ${b.date || null}, ${b.place || null},
              ${b.need || 4}, ${b.source || 'manual'},
              ${b.scan_login || null}, ${b.scan_pass || null})
      ON CONFLICT (id) DO UPDATE SET
        title = EXCLUDED.title, date = EXCLUDED.date,
        place = EXCLUDED.place, need = EXCLUDED.need,
        scan_login = EXCLUDED.scan_login, scan_pass = EXCLUDED.scan_pass`;
    return res.status(200).json({ ok: true, id });
  }

  if (req.method === 'DELETE') {
    if (!(await checkCoordinator(req)).ok) return res.status(401).json({ error: 'Нужен вход координатора' });
    const id = req.query.id;
    if (!id) return res.status(400).json({ error: 'Нужен id' });
    await sql`DELETE FROM signups WHERE event_id = ${id}`;
    await sql`DELETE FROM events WHERE id = ${id}`;
    return res.status(200).json({ ok: true });
  }

  res.status(405).json({ error: 'Method not allowed' });
}
