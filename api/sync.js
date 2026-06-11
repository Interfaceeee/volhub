// /api/sync - priyom sobytiy, sobrannyh v brauzere (variant zakladka).
// Sayt Ticketon blokiruet servernye zaprosy (403), poetomu server sam
// afishu ne parsit. Sobytiya sobirayutsya v realnom brauzere cherez
// zakladku-bukmarklet i prisylayutsya syuda POST-zaprosom.

import { sql, ensureSchema, readBody } from './_db.js';

export default async function handler(req, res) {
  await ensureSchema();

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Use POST' });
  }

  const body = await readBody(req);

  if (!body.secret || body.secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Bad secret' });
  }

  const events = Array.isArray(body.events) ? body.events : [];

  if (events.length === 0) {
    return res.status(200).json({ ok: false, added: 0, note: 'Empty list. DB untouched.' });
  }

  let added = 0;
  let updated = 0;
  for (const e of events) {
    if (!e || !e.id || !e.title) continue;
    const r = await sql`
      INSERT INTO events (id, title, date, place, need, source)
      VALUES (${e.id}, ${String(e.title).slice(0,120)}, ${e.date || null}, ${e.url || null}, ${4}, 'auto')
      ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title, place = EXCLUDED.place
      RETURNING (xmax = 0) AS inserted`;
    if (r[0] && r[0].inserted) added++; else updated++;
  }

  res.status(200).json({ ok: true, received: events.length, added, updated });
}
