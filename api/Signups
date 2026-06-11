// /api/signups
//   GET    — список заявок (нужен PIN: это координаторский экран)
//   POST   — волонтёр записывается (PIN НЕ нужен)
//   PATCH  — координатор меняет статус / бейдж / манишку (нужен PIN)
//   DELETE — удалить заявку по ?id= (нужен PIN)
import { sql, ensureSchema, checkCoordinator, readBody, uid, verifyPassword } from './_db.js';

export default async function handler(req, res) {
  await ensureSchema();

  if (req.method === 'POST') {
    const b = await readBody(req);
    // отмена своей записи волонтёром: нужен телефон+пароль и eventId
    if (b.action === 'cancel') {
      const phone = (b.phone || '').trim();
      const password = b.password || '';
      if (!phone || !password || !b.eventId) return res.status(400).json({ error: 'Нужны телефон, пароль и событие' });
      const v = await sql`SELECT pass_hash FROM volunteers WHERE phone = ${phone}`;
      if (!v.length || !verifyPassword(password, v[0].pass_hash)) return res.status(401).json({ error: 'Неверный пароль' });
      await sql`DELETE FROM signups WHERE phone = ${phone} AND event_id = ${b.eventId}`;
      return res.status(200).json({ ok: true });
    }
    // запись волонтёра — открыта для всех
    if (!b.name || !b.phone || !b.eventId) {
      return res.status(400).json({ error: 'Заполни имя, телефон и событие' });
    }
    const id = uid();
    await sql`
      INSERT INTO signups (id, name, phone, event_id, status)
      VALUES (${id}, ${b.name.trim()}, ${b.phone.trim()}, ${b.eventId}, 'pending')`;
    return res.status(200).json({ ok: true, id });
  }

  // всё ниже — только координатор
  const auth = await checkCoordinator(req);
  if (!auth.ok) return res.status(401).json({ error: 'Нужен вход координатора' });

  if (req.method === 'GET') {
    const signups = await sql`SELECT * FROM signups ORDER BY created_at DESC`;
    return res.status(200).json({ signups });
  }

  if (req.method === 'PATCH') {
    const b = await readBody(req);
    if (!b.id) return res.status(400).json({ error: 'Нужен id' });
    // обновляем только переданные поля
    if (b.status !== undefined)
      await sql`UPDATE signups SET status = ${b.status} WHERE id = ${b.id}`;
    if (b.badge !== undefined)
      await sql`UPDATE signups SET badge = ${b.badge} WHERE id = ${b.id}`;
    if (b.vest !== undefined)
      await sql`UPDATE signups SET vest = ${b.vest} WHERE id = ${b.id}`;
    if (b.name !== undefined)
      await sql`UPDATE signups SET name = ${b.name} WHERE id = ${b.id}`;
    if (b.phone !== undefined)
      await sql`UPDATE signups SET phone = ${b.phone} WHERE id = ${b.id}`;
    return res.status(200).json({ ok: true });
  }

  if (req.method === 'DELETE') {
    const id = req.query.id;
    if (!id) return res.status(400).json({ error: 'Нужен id' });
    await sql`DELETE FROM signups WHERE id = ${id}`;
    return res.status(200).json({ ok: true });
  }

  res.status(405).json({ error: 'Method not allowed' });
}
