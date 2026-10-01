// Attempt counters stored in D1 (rate_limits table). A counter starts again
// once its time window has passed.

// How many attempts are recorded for this key in the current window.
export async function peek(db, key, windowSeconds) {
  const row = await db
    .prepare("SELECT count FROM rate_limits WHERE key = ?1 AND window_start > datetime('now', ?2)")
    .bind(key, `-${windowSeconds} seconds`)
    .first();
  return row?.count ?? 0;
}

// Records one attempt and returns the new count. With lockAt set, reaching that
// count restarts the window, so the block lasts a full window from that moment.
export async function bump(db, key, windowSeconds, lockAt = null) {
  const since = `-${windowSeconds} seconds`;
  const row = await db
    .prepare(
      `INSERT INTO rate_limits (key, count, window_start) VALUES (?1, 1, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET
         count = CASE WHEN window_start > datetime('now', ?2) THEN count + 1 ELSE 1 END,
         window_start = CASE WHEN window_start > datetime('now', ?2) THEN window_start ELSE datetime('now') END
       RETURNING count`
    )
    .bind(key, since)
    .first();
  if (lockAt && row.count === lockAt) {
    await db.prepare("UPDATE rate_limits SET window_start = datetime('now') WHERE key = ?").bind(key).run();
  }
  return row.count;
}

export async function clear(db, key) {
  await db.prepare("DELETE FROM rate_limits WHERE key = ?").bind(key).run();
}
