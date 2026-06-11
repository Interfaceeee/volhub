// /api/coordinators
//   POST {action:'login', login, password}        — вход координатора (или мастер-PIN)
//   GET   (права координатора)                     — список координаторов
//   POST {action:'add', login, name, password}     — добавить координатора (права координатора)
//   PATCH {login, newPassword}                     — сбросить пароль (права координатора)
//   DELETE ?login=...                              — удалить координатора (права координатора)
import { sql, ensureSchema, checkCoordinator, checkPin, readBody, hashPassword, verifyPassword } from './_db.js';

export default async function handler(req, res) {
  await ensureSchema();

  if (req.method === 'POST') {
    const b = await readBody(req);

    if (b.action === 'login') {
      const login = (b.login || '').trim();
      const password = b.password || '';
      // мастер-вход: логин 'master' + пароль = COORD_PIN
      const masterPin = process.env.COORD_PIN || '1234';
      if (login === 'master' && password === masterPin) {
        return res.status(200).json({ ok: true, login: 'master', name: 'Главный координатор', master: true });
      }
      const rows = await sql`SELECT login, name, pass_hash FROM coordinators WHERE login = ${login}`;
      if (!rows.length || !verifyPassword(password, rows[0].pass_hash)) {
        return res.status(401).json({ error: 'Неверный логин или пароль' });
      }
      return res.status(200).json({ ok: true, login: rows[0].login, name: rows[0].name });
    }

    if (b.action === 'add') {
      const auth = await checkCoordinator(req);
      if (!auth.ok) return res.status(401).json({ error: 'Только для координатора' });
      const login = (b.login || '').trim();
      const password = b.password || '';
      if (!login || !password) return res.status(400).json({ error: 'Нужны логин и пароль' });
      const exists = await sql`SELECT login FROM coordinators WHERE login = ${login}`;
      if (exists.length) return res.status(409).json({ error: 'Такой логин уже есть' });
      await sql`INSERT INTO coordinators (login, name, pass_hash) VALUES (${login}, ${b.name || login}, ${hashPassword(password)})`;
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: 'Неизвестное действие' });
  }

  // дальше всё под правами координатора
  const auth = await checkCoordinator(req);
  if (!auth.ok) return res.status(401).json({ error: 'Только для координатора' });

  if (req.method === 'GET') {
    const rows = await sql`SELECT login, name, created_at FROM coordinators ORDER BY name`;
    return res.status(200).json({ coordinators: rows });
  }

  if (req.method === 'PATCH') {
    const b = await readBody(req);
    const login = (b.login || '').trim();
    if (!login || !b.newPassword) return res.status(400).json({ error: 'Нужны логин и новый пароль' });
    await sql`UPDATE coordinators SET pass_hash = ${hashPassword(b.newPassword)} WHERE login = ${login}`;
    return res.status(200).json({ ok: true });
  }

  if (req.method === 'DELETE') {
    const login = (req.query.login || '').trim();
    if (!login) return res.status(400).json({ error: 'Нужен логин' });
    await sql`DELETE FROM coordinators WHERE login = ${login}`;
    return res.status(200).json({ ok: true });
  }

  res.status(405).json({ error: 'Method not allowed' });
}
