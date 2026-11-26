import { authorizeAdmin, adminAuthResponse } from "../_lib/admin-auth.js";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
  });
}

async function checkMember(telegramId, token) {
  const response = await fetch("https://api.telegram.org/bot" + token + "/getChatMember", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: "@OxideHubOfficial", user_id: Number(telegramId) })
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data?.ok || !data.result) {
    return { checked: false, error: data?.description || "CHANNEL_CHECK_UNAVAILABLE" };
  }
  const status = String(data.result.status || "");
  const joined = ["creator", "administrator", "member"].includes(status) ||
    (status === "restricted" && data.result.is_member === true);
  const notJoined = ["left", "kicked"].includes(status) ||
    (status === "restricted" && data.result.is_member === false);
  return { checked: true, joined, notJoined, status };
}

export async function onRequestPost({ request, env }) {
  try {
    if (!env.DB || !env.TELEGRAM_BOT_TOKEN) {
      return json({ success: false, error: "SERVER_CONFIGURATION_MISSING" }, 500);
    }
    const body = await request.json().catch(() => ({}));
    const auth = await authorizeAdmin(String(body.initData || ""), env, "users");
    if (!auth.ok) return adminAuthResponse(auth);

    const page = Math.max(1, Math.min(1000000, Math.floor(Number(body.page) || 1)));
    const limit = Math.max(1, Math.min(50, Math.floor(Number(body.limit) || 20)));
    const query = String(body.query || "").trim().slice(0, 100);
    const search = "%" + query.replace(/[%_]/g, "") + "%";
    const where = query
      ? "AND (u.public_id LIKE ? OR u.user_uuid LIKE ? OR p.username LIKE ? OR p.first_name LIKE ? OR p.last_name LIKE ?)"
      : "";
    const params = query ? [search, search, search, search, search] : [];

    const count = await env.DB.prepare(`
      SELECT COUNT(*) AS total
      FROM users u
      INNER JOIN telegram_identities ti ON ti.user_uuid = u.user_uuid
      LEFT JOIN oxide_profiles p ON p.user_uuid = u.user_uuid
      WHERE u.status = 'active' ${where}
    `).bind(...params).first();

    const totalCandidates = Number(count?.total || 0);
    const totalPages = Math.max(1, Math.ceil(totalCandidates / limit));
    const safePage = Math.min(page, totalPages);
    const rows = await env.DB.prepare(`
      SELECT u.public_id AS id, u.user_uuid AS userUuid, u.points,
             u.created_at AS createdAt, ti.telegram_user_id AS telegramId,
             p.first_name AS firstName, p.last_name AS lastName,
             p.username AS username, p.photo_url AS photoUrl,
             p.telegram_url AS telegramUrl
      FROM users u
      INNER JOIN telegram_identities ti ON ti.user_uuid = u.user_uuid
      LEFT JOIN oxide_profiles p ON p.user_uuid = u.user_uuid
      WHERE u.status = 'active' ${where}
      ORDER BY u.created_at DESC, u.user_uuid ASC
      LIMIT ? OFFSET ?
    `).bind(...(query ? [...params, limit, (safePage - 1) * limit] : [limit, (safePage - 1) * limit])).all();

    const candidates = rows.results || [];
    const nonSubscribers = [];
    let checkErrors = 0;
    for (let start = 0; start < candidates.length; start += 5) {
      const batch = candidates.slice(start, start + 5);
      const checked = await Promise.all(batch.map(user => checkMember(user.telegramId, env.TELEGRAM_BOT_TOKEN)));
      checked.forEach((result, index) => {
        if (!result.checked) { checkErrors++; return; }
        if (result.notJoined) {
          const user = candidates[start + index];
          nonSubscribers.push({
            id: user.id, userUuid: user.userUuid, points: user.points,
            createdAt: user.createdAt, firstName: user.firstName,
            lastName: user.lastName, username: user.username,
            photoUrl: user.photoUrl, telegramUrl: user.telegramUrl
          });
        }
      });
    }

    if (candidates.length && checkErrors === candidates.length) {
      return json({
        success: false,
        error: "CHANNEL_CHECK_UNAVAILABLE",
        message: "Проверьте, что бот является администратором канала @OxideHubOfficial."
      }, 503);
    }

    return json({
      success: true,
      users: nonSubscribers,
      total: nonSubscribers.length,
      totalCandidates,
      page: safePage,
      limit,
      totalPages,
      scanned: candidates.length,
      checkErrors
    });
  } catch (error) {
    console.error("Admin channel non-subscribers API error:", error);
    return json({ success: false, error: "CHANNEL_NON_SUBSCRIBERS_FAILED" }, 500);
  }
}
