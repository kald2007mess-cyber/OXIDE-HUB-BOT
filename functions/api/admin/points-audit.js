import { authorizeAdmin, adminAuthResponse } from "../_lib/admin-auth.js";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
  });
}

async function safeRows(DB, sql, params = []) {
  try {
    const result = await DB.prepare(sql).bind(...params).all();
    return result.results || [];
  } catch (error) {
    console.error("Points audit source unavailable:", error);
    return [];
  }
}

export async function onRequestPost({ request, env }) {
  try {
    if (!env.DB) return json({ success: false, error: "DATABASE_NOT_CONFIGURED" }, 500);
    const body = await request.json().catch(() => ({}));
    const auth = await authorizeAdmin(String(body.initData || ""), env, "users");
    if (!auth.ok) return adminAuthResponse(auth);

    const userUuid = String(body.userUuid || "").trim().slice(0, 64);
    if (!/^[0-9a-f-]{30,40}$/i.test(userUuid)) {
      return json({ success: false, error: "INVALID_USER" }, 400);
    }

    const user = await env.DB.prepare(`
      SELECT u.user_uuid AS userUuid, u.public_id AS publicId, u.points,
             u.status, u.created_at AS createdAt, u.updated_at AS updatedAt,
             p.username, p.first_name AS firstName, p.last_name AS lastName,
             p.telegram_user_id AS telegramId
      FROM users u
      LEFT JOIN oxide_profiles p ON p.user_uuid = u.user_uuid
      WHERE u.user_uuid = ?
      LIMIT 1
    `).bind(userUuid).first();
    if (!user) return json({ success: false, error: "USER_NOT_FOUND" }, 404);

    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS point_ledger (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_uuid TEXT NOT NULL,
        delta REAL NOT NULL,
        balance_after REAL NOT NULL,
        reason TEXT NOT NULL,
        reference_type TEXT NOT NULL,
        reference_id TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )
    `).run();
    await env.DB.prepare(`
      CREATE INDEX IF NOT EXISTS idx_point_ledger_user
      ON point_ledger(user_uuid, created_at DESC, id DESC)
    `).run();

    const [ledger, summary, referrals, missions, gifts, adCycle, adState, wallet] = await Promise.all([
      safeRows(env.DB, `
        SELECT id, delta, balance_after, reason, reference_type AS referenceType,
               reference_id AS referenceId, created_at AS createdAt
        FROM point_ledger WHERE user_uuid = ?
        ORDER BY created_at DESC, id DESC LIMIT 200
      `, [userUuid]),
      safeRows(env.DB, `
        SELECT reason, COUNT(*) AS count, SUM(delta) AS total
        FROM point_ledger WHERE user_uuid = ? GROUP BY reason ORDER BY total DESC
      `, [userUuid]),
      safeRows(env.DB, `
        SELECT r.id, r.referred_id AS referredId, r.points_awarded AS pointsAwarded,
               r.status, r.risk_score AS riskScore, r.risk_reason AS riskReason,
               r.created_at AS createdAt, p.username, p.first_name AS firstName,
               p.last_name AS lastName, u.public_id AS referredPublicId
        FROM referrals r
        LEFT JOIN oxide_profiles p ON p.user_uuid = r.referred_id
        LEFT JOIN users u ON u.user_uuid = r.referred_id
        WHERE r.referrer_id = ? OR r.referred_id = ?
        ORDER BY r.created_at DESC LIMIT 100
      `, [userUuid, userUuid]),
      safeRows(env.DB, `
        SELECT s.id, s.mission_id AS missionId, s.status, s.created_at AS createdAt,
               s.reviewed_at AS reviewedAt, m.title, m.reward_points AS rewardPoints
        FROM mission_submissions s
        LEFT JOIN oxide_admin_missions m ON m.id = s.mission_id
        WHERE s.user_id = ?
        ORDER BY s.created_at DESC, s.id DESC LIMIT 100
      `, [userUuid]),
      safeRows(env.DB, `
        SELECT id, title, reward_points AS rewardPoints, created_at AS createdAt,
               claimed_at AS claimedAt, type
        FROM oxide_notifications
        WHERE user_id = ? AND type = 'reward'
        ORDER BY created_at DESC, id DESC LIMIT 100
      `, [userUuid]),
      safeRows(env.DB, `
        SELECT completed_ads AS completedAds, cycle_started_at AS cycleStartedAt
        FROM reward_ad_cycles WHERE user_id = ? LIMIT 1
      `, [userUuid]),
      safeRows(env.DB, `
        SELECT last_claim_at AS lastClaimAt FROM adsgram_reward_state
        WHERE user_id = ? LIMIT 1
      `, [userUuid]),
      safeRows(env.DB, `
        SELECT taps, tap_level AS tapLevel, storage_level AS storageLevel,
               mining_level AS miningLevel, last_mining_at AS lastMiningAt,
               updated_at AS updatedAt
        FROM oxide_wallet_state WHERE user_id = ? LIMIT 1
      `, [userUuid])
    ]);

    return json({
      success: true,
      user,
      ledger,
      summary,
      referrals,
      missions,
      gifts,
      adCycle: adCycle[0] || null,
      adState: adState[0] || null,
      wallet: wallet[0] || null,
      coverage: {
        ledgerRows: ledger.length,
        ledgerLimit: 200,
        note: "The ledger contains only events recorded by versions that wrote to it. Older ads, taps, mining and some referral credits may not have individual historical entries."
      }
    });
  } catch (error) {
    console.error("Admin points audit error:", error);
    return json({ success: false, error: "POINTS_AUDIT_FAILED" }, 500);
  }
}
