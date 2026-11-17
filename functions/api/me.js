import { getVisitor, json } from "./_lib/session.js";

export async function onRequestGet({ request, env }) {
  try {
    if (!env.DB || !env.SESSION_SECRET) {
      return json({ success: false, error: "SERVER_CONFIGURATION_MISSING" }, 500);
    }

    const userUuid = await getVisitor(request, env);
    if (!userUuid) return json({ success: false, error: "NO_TELEGRAM_SESSION" }, 401);

    const row = await env.DB.prepare(`
      SELECT user_uuid, public_id, points, status
      FROM users
      WHERE user_uuid = ?
      LIMIT 1
    `).bind(userUuid).first();

    if (!row || row.status !== "active") {
      return json({ success: false, error: "ACCOUNT_NOT_ACTIVE" }, 403);
    }

    return json({
      success: true,
      userId: row.user_uuid,
      displayId: row.public_id,
      points: Number(row.points || 0)
    });
  } catch {
    return json({ success: false, error: "COULD_NOT_LOAD_USER_PROFILE" }, 500);
  }
}
