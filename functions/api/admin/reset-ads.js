import { authorizeAdmin, adminAuthResponse } from "../_lib/admin-auth.js";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
  });
}

async function ensureAdTables(DB, now) {
  await DB.prepare(`CREATE TABLE IF NOT EXISTS platform_ad_progress (
    user_id TEXT PRIMARY KEY,
    beta_ads INTEGER NOT NULL DEFAULT 0,
    android_ads INTEGER NOT NULL DEFAULT 0,
    ios_ads INTEGER NOT NULL DEFAULT 0,
    cycle_started_at INTEGER NOT NULL
  )`).run();
  await DB.prepare(`CREATE TABLE IF NOT EXISTS reward_ad_cycles (
    user_id TEXT PRIMARY KEY,
    completed_ads INTEGER NOT NULL DEFAULT 0,
    cycle_started_at INTEGER NOT NULL
  )`).run();
  await DB.prepare(`CREATE TABLE IF NOT EXISTS adsgram_reward_state (
    user_id TEXT PRIMARY KEY,
    last_claim_at INTEGER NOT NULL DEFAULT 0
  )`).run();
  await DB.prepare(`CREATE TABLE IF NOT EXISTS adsgram_pending_offer (
    user_id TEXT PRIMARY KEY,
    offer TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`).run();
  await DB.prepare(`INSERT OR IGNORE INTO platform_ad_progress
    (user_id,beta_ads,android_ads,ios_ads,cycle_started_at)
    SELECT user_uuid,0,0,0,? FROM users`).bind(now).run();
  await DB.prepare(`INSERT OR IGNORE INTO reward_ad_cycles
    (user_id,completed_ads,cycle_started_at)
    SELECT user_uuid,0,? FROM users`).bind(now).run();
}

export async function onRequestPost({ request, env }) {
  try {
    if (!env.DB) return json({ success: false, error: "DATABASE_NOT_CONFIGURED" }, 500);
    const body = await request.json().catch(() => ({}));
    const auth = await authorizeAdmin(String(body.initData || ""), env);
    if (!auth.ok) return adminAuthResponse(auth);
    if (!auth.owner) return json({ success: false, error: "OWNER_ONLY" }, 403);
    if (body.action !== "reset") return json({ success: false, error: "INVALID_ACTION" }, 400);

    const keepId = String(body.keepUserId || "").trim().slice(0, 100);
    const now = Math.floor(Date.now() / 1000);
    await ensureAdTables(env.DB, now);

    let keptUser = null;
    if (keepId) {
      keptUser = await env.DB.prepare(
        "SELECT user_uuid AS userUuid, public_id AS publicId FROM users WHERE lower(public_id)=lower(?) OR user_uuid=? LIMIT 1"
      ).bind(keepId, keepId).first();
      if (!keptUser) return json({ success: false, error: "KEEP_USER_NOT_FOUND" }, 404);
    }

    const keepUuid = keptUser?.userUuid || "";
    await env.DB.batch([
      env.DB.prepare("UPDATE platform_ad_progress SET beta_ads=0,android_ads=0,ios_ads=0,cycle_started_at=?").bind(now),
      env.DB.prepare("UPDATE reward_ad_cycles SET completed_ads=0,cycle_started_at=?").bind(now),
      env.DB.prepare("UPDATE adsgram_reward_state SET last_claim_at=0"),
      env.DB.prepare("DELETE FROM adsgram_pending_offer")
    ]);

    if (keepUuid) {
      await env.DB.batch([
        env.DB.prepare("UPDATE platform_ad_progress SET beta_ads=10,android_ads=10,ios_ads=10,cycle_started_at=? WHERE user_id=?").bind(now, keepUuid),
        env.DB.prepare("UPDATE reward_ad_cycles SET completed_ads=10,cycle_started_at=? WHERE user_id=?").bind(now, keepUuid)
      ]);
    }

    const total = await env.DB.prepare("SELECT COUNT(*) AS total FROM users").first();
    return json({
      success: true,
      resetUsers: Number(total?.total || 0) - (keepUuid ? 1 : 0),
      keptUser: keptUser ? { publicId: keptUser.publicId } : null,
      keptAtTenOfTen: Boolean(keepUuid)
    });
  } catch (error) {
    console.error("Admin ad progress reset failed:", error);
    return json({ success: false, error: "RESET_AD_PROGRESS_FAILED" }, 500);
  }
}
