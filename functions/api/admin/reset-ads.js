import { authorizeAdmin, adminAuthResponse } from "../_lib/admin-auth.js";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
  });
}

async function ensureAdTables(DB) {
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
  await DB.prepare(`CREATE TABLE IF NOT EXISTS platform_ad_progress (
    user_id TEXT PRIMARY KEY,
    beta_ads INTEGER NOT NULL DEFAULT 0,
    android_ads INTEGER NOT NULL DEFAULT 0,
    ios_ads INTEGER NOT NULL DEFAULT 0,
    cycle_started_at INTEGER NOT NULL
  )`).run();
}

export async function onRequestPost({ request, env }) {
  try {
    if (!env.DB) return json({ success: false, error: "DATABASE_NOT_CONFIGURED" }, 500);
    const body = await request.json().catch(() => ({}));
    const auth = await authorizeAdmin(String(body.initData || ""), env);
    if (!auth.ok) return adminAuthResponse(auth);
    if (!auth.owner) return json({ success: false, error: "OWNER_ONLY" }, 403);
    if (body.confirmation !== "RESET ALL ADS") {
      return json({ success: false, error: "CONFIRMATION_REQUIRED" }, 400);
    }

    await ensureAdTables(env.DB);
    const now = Math.floor(Date.now() / 1000);
    const users = await env.DB.prepare("SELECT COUNT(*) AS total FROM users").first();

    await env.DB.batch([
      env.DB.prepare("UPDATE platform_ad_progress SET beta_ads=0,android_ads=0,ios_ads=0,cycle_started_at=?").bind(now),
      env.DB.prepare("UPDATE reward_ad_cycles SET completed_ads=0,cycle_started_at=?").bind(now),
      env.DB.prepare("UPDATE adsgram_reward_state SET last_claim_at=0"),
      env.DB.prepare("DELETE FROM adsgram_pending_offer")
    ]);

    return json({ success: true, resetUsers: Number(users?.total || 0), resetPlatforms: ["BETA", "ANDROID", "iOS"] });
  } catch (error) {
    console.error("Admin ad progress reset failed:", error);
    return json({ success: false, error: "RESET_AD_PROGRESS_FAILED" }, 500);
  }
}
