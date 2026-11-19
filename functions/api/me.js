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

    const [missionStats, referralStats] = await Promise.all([
      env.DB.prepare(`
        SELECT
          (SELECT COUNT(DISTINCT mission_id) FROM mission_submissions
           WHERE user_id = ? AND status = 'approved') AS approved_missions,
          (SELECT COUNT(*) FROM telegram_channel_claims WHERE user_id = ?) AS channel_claims
      `).bind(userUuid, userUuid).first().catch(() => null),
      env.DB.prepare(`
        SELECT COUNT(*) AS total
        FROM referrals
        WHERE referrer_id = ? AND status = 'rewarded'
      `).bind(userUuid).first().catch(() => null)
    ]);
    const completedMissions = Number(missionStats?.approved_missions || 0) +
      Number(missionStats?.channel_claims || 0);
    const successfulReferrals = Number(referralStats?.total || 0);

    return json({
      success: true,
      userId: row.user_uuid,
      displayId: row.public_id,
      points: Number(row.points || 0),
      username: row.username || "",
      firstName: row.first_name || "",
      lastName: row.last_name || "",
      photoUrl: row.photo_url || "",
      telegramUrl: row.telegram_url || (row.username ? "https://t.me/" + row.username : ""),
      stats: { completedMissions, successfulReferrals },
      achievements: {
        beginner: completedMissions >= 1,
        active: completedMissions >= 3,
        legend: completedMissions >= 10
      }
    });
  } catch {
    return json({ success: false, error: "COULD_NOT_LOAD_USER_PROFILE" }, 500);
  }
}
