// /api/signups
//   GET    — список заявок (нужен PIN: это координаторский экран)
//   POST   — волонтёр записывается (PIN НЕ нужен)
//   PATCH  — координатор меняет статус / бейдж / манишку (нужен PIN)
//   DELETE — удалить заявку по ?id= (нужен PIN)
import { sql, ensureSchema, checkCoordinator, readBody, uid, verifyPassword, tgSend } from './_db.js';

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
    const phone = b.phone.trim();
    // защита от дублей: один волонтёр — одна запись на событие
    const dup = await sql`SELECT id FROM signups WHERE phone = ${phone} AND event_id = ${b.eventId}`;
    if (dup.length) return res.status(200).json({ ok: true, id: dup[0].id, already: true });
    const id = uid();
    await sql`
      INSERT INTO signups (id, name, phone, event_id, status)
      VALUES (${id}, ${b.name.trim()}, ${phone}, ${b.eventId}, 'pending')`;
    return res.status(200).json({ ok: true, id });
  }

  // ПУБЛИЧНО: список записавшихся на конкретное событие (без телефонов) — для страницы события
  if (req.method === 'GET' && req.query.eventId) {
    const eventId = req.query.eventId;
    const rows = await sql`
      SELECT s.name, s.status, v.avatar
      FROM signups s
      LEFT JOIN volunteers v ON v.phone = s.phone
      WHERE s.event_id = ${eventId} AND s.status <> 'rejected'
      ORDER BY (s.status = 'approved') DESC, s.created_at`;
    const people = rows.map(r => ({
      name: r.name,
      approved: r.status === 'approved',
      avatar: r.avatar || null,
    }));
    return res.status(200).json({ people });
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
    if (b.status !== undefined) {
      await sql`UPDATE signups SET status = ${b.status} WHERE id = ${b.id}`;
      // при подтверждении — шлём уведомление в Telegram, если волонтёр привязан
      if (b.status === 'approved') {
        const rows = await sql`
          SELECT s.phone, s.event_id, e.title, e.date, e.scan_login, e.scan_pass, v.tg_chat_id, v.name AS vname
          FROM signups s
          LEFT JOIN events e ON e.id = s.event_id
          LEFT JOIN volunteers v ON v.phone = s.phone
          WHERE s.id = ${b.id}`;
        if (rows.length && rows[0].tg_chat_id) {
          const r = rows[0];
          const evName = r.title || 'мероприятие';
          let text = `✅ <b>Запись подтверждена!</b>\n\nСобытие: <b>${evName}</b>`;
          if (r.scan_login || r.scan_pass) {
            text += `\n\n🎫 Доступ к сканеру билетов:\nЛогин: <code>${r.scan_login || '—'}</code>\nПароль: <code>${r.scan_pass || '—'}</code>`;
          }
          text += `\n\nБейдж и манишку получишь у координатора на месте.`;
          await tgSend(r.tg_chat_id, text);
        }
      }
    }
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
