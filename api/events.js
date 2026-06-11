// /api/events
//   GET    - list events
//   POST   - add/update event (coordinator PIN)
//   DELETE - remove event by ?id= (coordinator PIN)
import { sql, ensureSchema, checkCoordinator, readBody, uid, eventId } from './_db.js';

export default async function handler(req, res) {
  await ensureSchema();

  if (req.method === 'GET') {
    // Coordinator (logged in) gets full data incl. scanner creds.
    if ((await checkCoordinator(req)).ok) {
      const events = await sql`
        SELECT e.*, e.event_time AS time,
          (SELECT COUNT(*) FROM signups s
            WHERE s.event_id = e.id AND s.status <> 'rejected') AS taken,
          (SELECT COUNT(*) FROM signups s
            WHERE s.event_id = e.id AND s.status = 'approved') AS approved_count
        FROM events e
        ORDER BY e.date NULLS LAST, e.created_at`;
      return res.status(200).json({ events });
    }
    // Public list: do NOT expose scan_login/scan_pass.
    const events = await sql`
      SELECT e.id, e.title, e.date, e.event_time AS time, e.place, e.need, e.source, e.created_at, e.image,
        (SELECT COUNT(*) FROM signups s
          WHERE s.event_id = e.id AND s.status <> 'rejected') AS taken,
        (SELECT COUNT(*) FROM signups s
          WHERE s.event_id = e.id AND s.status = 'approved') AS approved_count
      FROM events e
      ORDER BY e.date NULLS LAST, e.created_at`;
    return res.status(200).json({ events });
  }

  if (req.method === 'POST') {
    if (!(await checkCoordinator(req)).ok) return res.status(401).json({ error: 'Coordinator login required' });
    const b = await readBody(req);
    if (!b.title) return res.status(400).json({ error: 'Title required' });
    let id = b.id;
    if (!id) {
      // generate unique 8-digit code
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
