import { getVisitor, json } from "./_lib/session.js";

export async function onRequestGet({ request, env }) {
  try {
    if (!env.DB || !env.SESSION_SECRET) return json({ success: false, error: "SERVER_CONFIGURATION_MISSING" }, 500);
    const userUuid = await getVisitor(request, env);
    if (!userUuid) return json({ success: false, error: "NO_TELEGRAM_SESSION" }, 401);
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
