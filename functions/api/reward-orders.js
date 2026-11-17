import { getVisitor, json } from "./_lib/session.js";

export async function onRequestGet({ request, env }) {
  try {
    if (!env.DB || !env.SESSION_SECRET) return json({ success: false, error: "SERVER_CONFIGURATION_MISSING" }, 500);
    const userUuid = await getVisitor(request, env);
    if (!userUuid) return json({ success: false, error: "NO_TELEGRAM_SESSION" }, 401);
    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS redemption_orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_uuid TEXT NOT NULL REFERENCES users(user_uuid),
        public_id TEXT NOT NULL,
        offer_id INTEGER NOT NULL,
        offer_name TEXT NOT NULL,
        points_cost INTEGER NOT NULL,
        user_uuid_input TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at INTEGER NOT NULL,
        reviewed_at INTEGER,
        telegram_message_id INTEGER
      )
    `).run();
    const result = await env.DB.prepare(`
      SELECT id, offer_name, points_cost, status, created_at, reviewed_at
      FROM redemption_orders
      WHERE user_uuid = ?
      ORDER BY created_at DESC, id DESC
      LIMIT 30
    `).bind(userUuid).all();
    return json({ success: true, orders: result.results || [] });
  } catch {
    return json({ success: false, error: "REWARD_ORDERS_LOAD_FAILED" }, 500);
  }
}
