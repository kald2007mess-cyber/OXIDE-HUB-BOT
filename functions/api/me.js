import { getVisitor, json } from "./_lib/session.js";

export async function onRequestGet({ request, env }) {
  try {
    if (!env.DB || !env.SESSION_SECRET) {
      return json({ success: false, error: "SERVER_CONFIGURATION_MISSING" }, 500);
    }

    const userUuid = await getVisitor(request, env);
    if (!userUuid) return json({ success: false, error: "NO_TELEGRAM_SESSION" }, 401);

    const row = await env.DB.prepare(`
      SELECT u.user_uuid, u.public_id, u.points, u.status,
             p.username, p.first_name, p.last_name, p.photo_url, p.telegram_url
      FROM users u
      LEFT JOIN oxide_profiles p ON p.user_uuid = u.user_uuid
      WHERE u.user_uuid = ?
      LIMIT 1
    `).bind(userUuid).first();

    if (!row || row.status !== "active") {
      return json({ success: false, error: "ACCOUNT_NOT_ACTIVE" }, 403);
    }

    return json({
      success: true,
      userId: row.user_uuid,
      displayId: row.public_id,
      points: Number(row.points || 0),
      username: row.username || "",
      firstName: row.first_name || "",
      lastName: row.last_name || "",
      photoUrl: row.photo_url || "",
      telegramUrl: row.telegram_url || (row.username ? "https://t.me/" + row.username : "")
    });
  } catch {
    return json({ success: false, error: "COULD_NOT_LOAD_USER_PROFILE" }, 500);
  }
}
