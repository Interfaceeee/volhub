// /api/events
//   GET    — список событий (для всех)
//   POST   — добавить событие (нужен PIN координатора)
//   DELETE — удалить событие по ?id= (нужен PIN)
import { sql, ensureSchema, checkPin, readBody, uid } from './_db.js';

export default async function handler(req, res) {
  await ensureSchema();

  if (req.method === 'GET') {
    const events = await sql`
      SELECT e.*,
        (SELECT COUNT(*) FROM signups s
          WHERE s.event_id = e.id AND s.status <> 'rejected') AS taken
      FROM events e
      ORDER BY e.date NULLS LAST, e.created_at`;
    return res.status(200).json({ events });
  }

  if (req.method === 'POST') {
    if (!checkPin(req)) return res.status(401).json({ error: 'Нужен PIN координатора' });
    const b = await readBody(req);
    if (!b.title) return res.status(400).json({ error: 'Нужно название' });
    const id = b.id || uid();
    await sql`
      INSERT INTO events (id, title, date, place, need, source)
      VALUES (${id}, ${b.title}, ${b.date || null}, ${b.place || null},
              ${b.need || 4}, ${b.source || 'manual'})
      ON CONFLICT (id) DO UPDATE SET
        title = EXCLUDED.title, date = EXCLUDED.date,
        place = EXCLUDED.place, need = EXCLUDED.need`;
    return res.status(200).json({ ok: true, id });
  }

  if (req.method === 'DELETE') {
    if (!checkPin(req)) return res.status(401).json({ error: 'Нужен PIN координатора' });
    const id = req.query.id;
    if (!id) return res.status(400).json({ error: 'Нужен id' });
    await sql`DELETE FROM signups WHERE event_id = ${id}`;
    await sql`DELETE FROM events WHERE id = ${id}`;
    return res.status(200).json({ ok: true });
  }

  res.status(405).json({ error: 'Method not allowed' });
}
