import { authorizeAdmin, adminAuthResponse } from "../_lib/admin-auth.js";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}

export async function onRequestPost({ request, env }) {
  try {
    if (!env.DB) return json({ success: false, error: "DATABASE_NOT_CONFIGURED" }, 500);
    const body = await request.json().catch(() => ({}));
    const auth = await authorizeAdmin(String(body.initData || ""), env);
    if (!auth.ok) return adminAuthResponse(auth);
    if (!auth.owner) return json({ success: false, error: "OWNER_ONLY" }, 403);
    if (body.confirmation !== "RESET OXIDE DATA") {
      return json({ success: false, error: "CONFIRMATION_REQUIRED" }, 400);
    }

    // Ensure resettable activity tables exist even on a newly initialized database.
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS mission_submissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      mission_id INTEGER NOT NULL,
      proof_file_id TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL,
      reviewed_at INTEGER
    )`).run();
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS telegram_channel_claims (
      user_id TEXT NOT NULL,
      mission_id INTEGER NOT NULL,
      claimed_at INTEGER NOT NULL,
      PRIMARY KEY(user_id, mission_id)
    )`).run();
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS point_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_uuid TEXT NOT NULL,
      delta REAL NOT NULL,
      balance_after REAL NOT NULL,
      reason TEXT NOT NULL,
      reference_type TEXT NOT NULL,
      reference_id TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`).run();

    // Deliberately preserve referrals and every referral-related record.
    // Keep user accounts, profiles, missions, wallet upgrades and referral history.
    const statements = [
      env.DB.prepare("UPDATE users SET points = 0, updated_at = ?").bind(Math.floor(Date.now() / 1000)),
      env.DB.prepare("UPDATE visitors SET points = 0, progress = 0"),
      env.DB.prepare("DELETE FROM mission_submissions"),
      env.DB.prepare("DELETE FROM telegram_channel_claims"),
      env.DB.prepare("DELETE FROM point_ledger"),
      env.DB.prepare("DELETE FROM oxide_user_activity")
    ];
    await env.DB.batch(statements);

    return json({
      success: true,
      reset: {
        userPoints: true,
        missionProgress: true,
        missionRecords: true,
        pointHistory: true,
        loginHistory: true,
        referralsPreserved: true
      }
    });
  } catch (error) {
    console.error("Admin data reset failed:", error);
    return json({ success: false, error: "ADMIN_RESET_FAILED" }, 500);
  }
}
