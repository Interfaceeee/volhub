// /api/volunteers
//   POST {action:'register', phone, name, birthday, password}  — регистрация (задаёт пароль)
//   POST {action:'login', phone, password}                     — вход, возвращает профиль+записи
//   GET  (с правами координатора)                              — список всех волонтёров
//   PATCH {phone, name?, birthday?, newPassword?}              — координатор правит/сбрасывает пароль
import { sql, ensureSchema, checkCoordinator, readBody, hashPassword, verifyPassword } from './_db.js';

// привести телефон к единому виду: только цифры и ведущий +
function normPhone(p) {
  let s = String(p || '').trim();
  const plus = s.startsWith('+');
  s = s.replace(/[^0-9]/g, '');
  return (plus ? '+' : '') + s;
}

// собрать профиль + записи волонтёра (сканер только по подтверждённым)
async function profileWithSignups(phone) {
  const prof = await sql`SELECT phone, name, birthday, tg_chat_id, avatar FROM volunteers WHERE phone = ${phone}`;
  if (!prof.length) return null;
  const p = prof[0];
  const profile = { phone: p.phone, name: p.name, birthday: p.birthday, avatar: p.avatar || null, tg_linked: !!p.tg_chat_id };
  const rows = await sql`
    SELECT s.id, s.status, s.badge, s.vest, s.event_id,
           e.title, e.date, e.place,
           CASE WHEN s.status = 'approved' THEN e.scan_login ELSE NULL END AS scan_login,
           CASE WHEN s.status = 'approved' THEN e.scan_pass  ELSE NULL END AS scan_pass
    FROM signups s JOIN events e ON e.id = s.event_id
    WHERE s.phone = ${phone}
    ORDER BY e.date NULLS LAST`;
  return { profile, signups: rows };
}

export default async function handler(req, res) {
  await ensureSchema();

  if (req.method === 'POST') {
    const b = await readBody(req);
    const action = b.action || 'register';
    const phone = normPhone(b.phone);

    if (action === 'register') {
      const name = (b.name || '').trim();
      const password = b.password || '';
      if (!phone || !name || !password) return res.status(400).json({ error: 'Нужны имя, телефон и пароль' });
      // если профиль уже есть и с паролем — не даём перезаписать (это чужой аккаунт)
      const exists = await sql`SELECT pass_hash FROM volunteers WHERE phone = ${phone}`;
      if (exists.length && exists[0].pass_hash) {
        return res.status(409).json({ error: 'Этот телефон уже зарегистрирован. Войдите по паролю.' });
      }
      const hash = hashPassword(password);
      await sql`
        INSERT INTO volunteers (phone, name, birthday, pass_hash, avatar)
        VALUES (${phone}, ${name}, ${b.birthday || null}, ${hash}, ${b.avatar || null})
        ON CONFLICT (phone) DO UPDATE SET name = EXCLUDED.name, birthday = EXCLUDED.birthday, pass_hash = EXCLUDED.pass_hash`;
      return res.status(200).json(await profileWithSignups(phone));
    }

    // обновление собственного профиля волонтёром (нужен пароль для подтверждения)
    if (action === 'update') {
      const password = b.password || '';
      const rows = await sql`SELECT pass_hash FROM volunteers WHERE phone = ${phone}`;
      if (!rows.length || !verifyPassword(password, rows[0].pass_hash)) return res.status(401).json({ error: 'Неверный пароль' });
      await sql`
        UPDATE volunteers
        SET name = COALESCE(${b.name ?? null}, name),
            birthday = COALESCE(${b.birthday ?? null}, birthday),
            avatar = COALESCE(${b.avatar ?? null}, avatar)
        WHERE phone = ${phone}`;
      if (b.name) await sql`UPDATE signups SET name = ${b.name} WHERE phone = ${phone}`;
      if (b.newPassword) await sql`UPDATE volunteers SET pass_hash = ${hashPassword(b.newPassword)} WHERE phone = ${phone}`;
      return res.status(200).json(await profileWithSignups(phone));
    }

    if (action === 'login') {
      const password = b.password || '';
      if (!phone || !password) return res.status(400).json({ error: 'Нужны телефон и пароль' });
      const rows = await sql`SELECT pass_hash FROM volunteers WHERE phone = ${phone}`;
      if (!rows.length) return res.status(404).json({ error: 'Профиль не найден. Зарегистрируйтесь.' });
      if (!verifyPassword(password, rows[0].pass_hash)) return res.status(401).json({ error: 'Неверный пароль' });
      return res.status(200).json(await profileWithSignups(phone));
    }

    // выдать код привязки Telegram (нужен телефон+пароль)
    if (action === 'tglink') {
      const password = b.password || '';
      const rows = await sql`SELECT pass_hash FROM volunteers WHERE phone = ${phone}`;
      if (!rows.length || !verifyPassword(password, rows[0].pass_hash)) return res.status(401).json({ error: 'Неверный пароль' });
      const code = 'v' + Math.random().toString(36).slice(2, 9);
      await sql`UPDATE volunteers SET tg_code = ${code} WHERE phone = ${phone}`;
      const bot = (process.env.TELEGRAM_BOT_USERNAME || '').replace(/^@/, '');
      return res.status(200).json({ ok: true, code, bot, link: bot ? `https://t.me/${bot}?start=${code}` : null });
    }

    return res.status(400).json({ error: 'Неизвестное действие' });
  }

  if (req.method === 'GET') {
    const auth = await checkCoordinator(req);
    if (!auth.ok) return res.status(401).json({ error: 'Только для координатора' });
    // если передан ?phone= — отдаём полный профиль одного волонтёра с историей и инвентарём
    const onePhone = (req.query.phone || '').trim();
    if (onePhone) {
      const prof = await sql`SELECT phone, name, birthday, avatar FROM volunteers WHERE phone = ${onePhone}`;
      if (!prof.length) return res.status(404).json({ error: 'Профиль не найден' });
      const rows = await sql`
        SELECT s.id, s.status, s.badge, s.vest, s.event_id, e.title, e.date, e.place
        FROM signups s JOIN events e ON e.id = s.event_id
        WHERE s.phone = ${onePhone}
        ORDER BY e.date NULLS LAST`;
      return res.status(200).json({ profile: prof[0], signups: rows });
    }
    const vols = await sql`SELECT phone, name, birthday, avatar FROM volunteers ORDER BY name`;
    return res.status(200).json({ volunteers: vols });
  }

  if (req.method === 'PATCH') {
    const auth = await checkCoordinator(req);
    if (!auth.ok) return res.status(401).json({ error: 'Только для координатора' });
    const b = await readBody(req);
    const phone = normPhone(b.phone);
    if (!phone) return res.status(400).json({ error: 'Нужен телефон' });
    if (b.name !== undefined || b.birthday !== undefined || b.avatar !== undefined) {
      await sql`
        UPDATE volunteers
        SET name = COALESCE(${b.name ?? null}, name),
            birthday = COALESCE(${b.birthday ?? null}, birthday),
            avatar = COALESCE(${b.avatar ?? null}, avatar)
        WHERE phone = ${phone}`;
      if (b.name) await sql`UPDATE signups SET name = ${b.name} WHERE phone = ${phone}`;
    }
    // сброс пароля волонтёра координатором
    if (b.newPassword) {
      await sql`UPDATE volunteers SET pass_hash = ${hashPassword(b.newPassword)} WHERE phone = ${phone}`;
    }
    return res.status(200).json({ ok: true });
  }

  if (req.method === 'DELETE') {
    const auth = await checkCoordinator(req);
    if (!auth.ok) return res.status(401).json({ error: 'Только для координатора' });
    const phone = normPhone(req.query.phone);
    if (!phone) return res.status(400).json({ error: 'Нужен телефон' });
    await sql`DELETE FROM signups WHERE phone = ${phone}`;
    await sql`DELETE FROM volunteers WHERE phone = ${phone}`;
    return res.status(200).json({ ok: true });
  }

  res.status(405).json({ error: 'Method not allowed' });
}
