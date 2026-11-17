import { authorizeAdmin, adminAuthResponse } from "../_lib/admin-auth.js";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
  });
}

export async function onRequestPost({ request, env }) {
  try {
    if (!env.DB) return json({ success: false, error: "DATABASE_NOT_CONFIGURED" }, 500);
    const body = await request.json().catch(() => ({}));
    const auth = await authorizeAdmin(String(body.initData || ""), env, "users");
    if (!auth.ok) return adminAuthResponse(auth);

    const page = Math.max(1, Math.min(1000000, Math.floor(Number(body.page) || 1)));
    const limit = Math.max(1, Math.min(50, Math.floor(Number(body.limit) || 20)));
    const query = String(body.query || "").trim().slice(0, 100);
    const search = query ? `%${query.replace(/[\\%_]/g, "\\$&")} %`.replace(" %", "%") : "%";
    const where = query ? "WHERE u.public_id LIKE ? ESCAPE '\\\\' OR u.user_uuid LIKE ? ESCAPE '\\\\'" : "";

    const count = await env.DB.prepare(`
      SELECT COUNT(*) AS total
      FROM users u
      ${where}
    `).bind(...(query ? [search, search] : [])).first();

    const total = Number(count?.total || 0);
    const totalPages = Math.max(1, Math.ceil(total / limit));
    const safePage = Math.min(page, totalPages);
    const offset = (safePage - 1) * limit;

    const result = await env.DB.prepare(`
      SELECT u.public_id AS id, u.points,
             COALESCE(v.progress, 0) AS progress,
             u.created_at AS createdAt
      FROM users u
      LEFT JOIN visitors v ON v.user_id = u.user_uuid
      ${where}
      ORDER BY u.created_at DESC, u.user_uuid ASC
      LIMIT ? OFFSET ?
    `).bind(...(query ? [search, search, limit, offset] : [limit, offset])).all();

    return json({
      success: true,
      users: result.results || [],
      total,
      page: safePage,
      limit,
      totalPages
    });
  } catch (error) {
    console.error("Admin users API error:", error);
    return json({ success: false, error: "ADMIN_USERS_FAILED" }, 500);
  }
}
