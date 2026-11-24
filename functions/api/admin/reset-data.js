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
