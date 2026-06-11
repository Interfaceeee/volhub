// /api/volunteers
//   POST  { phone, name, birthday }     — создать/обновить профиль (без подтверждения)
//   GET   ?phone=...                     — профиль + его записи (со сканером по подтверждённым)
//   GET   (с PIN координатора)           — список всех волонтёров (для координатора)
//   PATCH { phone, name?, birthday? }    — координатор правит профиль (нужен PIN)
import { sql, ensureSchema, checkPin, readBody } from './_db.js';

export default async function handler(req, res) {
  await ensureSchema();

  if (req.method === 'POST') {
    const b = await readBody(req);
    const phone = (b.phone || '').trim();
    const name = (b.name || '').trim();
    if (!phone || !name) return res.status(400).json({ error: 'Нужны имя и телефон' });
    await sql`
      INSERT INTO volunteers (phone, name, birthday)
      VALUES (${phone}, ${name}, ${b.birthday || null})
      ON CONFLICT (phone) DO UPDATE SET name = EXCLUDED.name, birthday = EXCLUDED.birthday`;
    return res.status(200).json({ ok: true, phone });
  }

  if (req.method === 'GET') {
    // координатор (с PIN) — список всех волонтёров
    if (checkPin(req)) {
      const vols = await sql`SELECT * FROM volunteers ORDER BY name`;
      return res.status(200).json({ volunteers: vols });
    }
    // волонтёр — свой профиль и записи
    const phone = (req.query.phone || '').trim();
    if (!phone) return res.status(400).json({ error: 'Нужен телефон' });
    const prof = await sql`SELECT * FROM volunteers WHERE phone = ${phone}`;
    if (!prof.length) return res.status(404).json({ error: 'Профиль не найден' });
    // записи волонтёра + данные события; сканер показываем ТОЛЬКО для подтверждённых
    const rows = await sql`
      SELECT s.id, s.status, s.badge, s.vest, s.event_id,
             e.title, e.date, e.place,
             CASE WHEN s.status = 'approved' THEN e.scan_login ELSE NULL END AS scan_login,
             CASE WHEN s.status = 'approved' THEN e.scan_pass  ELSE NULL END AS scan_pass
      FROM signups s JOIN events e ON e.id = s.event_id
      WHERE s.phone = ${phone}
      ORDER BY e.date NULLS LAST`;
    return res.status(200).json({ profile: prof[0], signups: rows });
  }

  if (req.method === 'PATCH') {
    if (!checkPin(req)) return res.status(401).json({ error: 'Нужен PIN координатора' });
    const b = await readBody(req);
    const phone = (b.phone || '').trim();
    if (!phone) return res.status(400).json({ error: 'Нужен телефон' });
    await sql`
      UPDATE volunteers
      SET name = COALESCE(${b.name ?? null}, name),
          birthday = COALESCE(${b.birthday ?? null}, birthday)
      WHERE phone = ${phone}`;
    // если у волонтёра менялось имя — обновим и в его заявках для консистентности
    if (b.name) await sql`UPDATE signups SET name = ${b.name} WHERE phone = ${phone}`;
    return res.status(200).json({ ok: true });
  }

  res.status(405).json({ error: 'Method not allowed' });
}
