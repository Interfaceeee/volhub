// /api/telegram — webhook для Telegram-бота.
// Телеграм шлёт сюда обновления. Обрабатываем команду /start <код>:
// находим волонтёра по tg_code и сохраняем его chat_id, затем пишем подтверждение.
import { sql, ensureSchema, readBody, tgSend } from './_db.js';

export default async function handler(req, res) {
  await ensureSchema();

  if (req.method !== 'POST') return res.status(200).json({ ok: true });

  const update = await readBody(req);
  const msg = update.message || update.edited_message;
  if (!msg || !msg.text) return res.status(200).json({ ok: true });

  const chatId = msg.chat && msg.chat.id;
  const text = msg.text.trim();

  // /start <код>
  if (text.startsWith('/start')) {
    const parts = text.split(/\s+/);
    const code = parts[1];
    if (!code) {
      await tgSend(chatId, 'Привет! Чтобы получать уведомления о волонтёрстве, открой раздел «Профиль» в приложении и нажми «Привязать Telegram».');
      return res.status(200).json({ ok: true });
    }
    const rows = await sql`SELECT phone, name FROM volunteers WHERE tg_code = ${code}`;
    if (!rows.length) {
      await tgSend(chatId, 'Код не найден или устарел. Открой «Привязать Telegram» в приложении ещё раз.');
      return res.status(200).json({ ok: true });
    }
    await sql`UPDATE volunteers SET tg_chat_id = ${String(chatId)}, tg_code = NULL WHERE phone = ${rows[0].phone}`;
    await tgSend(chatId, `Готово, ${rows[0].name}! 🎉\nТеперь сюда будут приходить уведомления: подтверждение записи и доступ к сканеру билетов.`);
    return res.status(200).json({ ok: true });
  }

  // любое другое сообщение
  await tgSend(chatId, 'Я бот волонтёров Freedom Ticketon. Уведомления приходят автоматически. Управление — в приложении.');
  return res.status(200).json({ ok: true });
}
