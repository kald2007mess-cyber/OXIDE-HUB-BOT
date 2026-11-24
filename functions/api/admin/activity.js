import { authorizeAdmin, adminAuthResponse } from "../_lib/admin-auth.js";
function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
}
export async function onRequestPost({ request, env }) {
  try {
    if (!env.DB) return json({ success: false, error: "DATABASE_NOT_CONFIGURED" }, 500);
    const body = await request.json().catch(() => ({}));
    const auth = await authorizeAdmin(String(body.initData || ""), env, "users");
    if (!auth.ok) return adminAuthResponse(auth);
    const page = Math.max(1, Math.floor(Number(body.page) || 1));
    const limit = Math.max(1, Math.min(50, Math.floor(Number(body.limit) || 20)));
    const query = String(body.query || "").trim().slice(0, 100);
    const search = "%" + query.replace(/[%_]/g, "") + "%";
    const where = query ? "WHERE a.telegram_user_id LIKE ? OR u.public_id LIKE ? OR p.username LIKE ? OR p.first_name LIKE ? OR p.last_name LIKE ?" : "";
    const params = query ? [search, search, search, search, search] : [];
    const count = await env.DB.prepare("SELECT COUNT(*) AS total FROM oxide_user_activity a LEFT JOIN users u ON u.user_uuid=a.user_uuid LEFT JOIN oxide_profiles p ON p.user_uuid=a.user_uuid " + where).bind(...params).first();
    const total = Number(count?.total || 0);
    const totalPages = Math.max(1, Math.ceil(total / limit));
    const safePage = Math.min(page, totalPages);
    const offset = (safePage - 1) * limit;
    const rows = await env.DB.prepare("SELECT a.telegram_user_id AS telegramId,a.first_seen_at AS firstSeenAt,a.last_seen_at AS lastSeenAt,a.visit_count AS visitCount,u.public_id AS publicId,p.username AS username,p.first_name AS firstName,p.last_name AS lastName FROM oxide_user_activity a LEFT JOIN users u ON u.user_uuid=a.user_uuid LEFT JOIN oxide_profiles p ON p.user_uuid=a.user_uuid " + where + " ORDER BY a.last_seen_at DESC LIMIT ? OFFSET ?").bind(...(query ? [...params, limit, offset] : [limit, offset])).all();
    return json({ success: true, records: rows.results || [], total, page: safePage, limit, totalPages });
  } catch (error) {
    console.error("Admin activity API error:", error);
    return json({ success: false, error: "ADMIN_ACTIVITY_FAILED" }, 500);
  }
}