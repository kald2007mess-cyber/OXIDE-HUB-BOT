
import {
  getVisitor,
  json
} from "./_lib/session.js";

function response(data, cookie = null, status = 200) {
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  };

  if (cookie) headers["Set-Cookie"] = cookie;

  return new Response(JSON.stringify(data), {
    status,
    headers
  });
}

function shortId(id) {
  return "OX-" + String(id)
    .replace(/-/g, "")
    .slice(0, 8)
    .toUpperCase();
}

export async function onRequestGet({ request, env }) {
  let diagnosticStage = "START";
  try {
    if (!env.DB || !env.SESSION_SECRET) {
      return json({
        success: false,
        error: "Server configuration missing"
      }, 500);
    }

    diagnosticStage = "READ_SESSION";
    const userId = await getVisitor(request, env);

    if (!userId) {
      return json({
        success: false,
        error: "USER_NOT_FOUND"
      }, 401);
    }

    // Referral tables and reward recovery are auxiliary: if an older D1 schema
    // needs migration, it must not prevent the user from receiving their invite link.
    try {
      // Ensure referral storage exists and migrate legacy UUID column names in place.
      await env.DB.prepare(`
        CREATE TABLE IF NOT EXISTS referrals (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          referrer_id TEXT NOT NULL,
          referred_id TEXT NOT NULL UNIQUE,
          points_awarded INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL
        )
      `).run();
      const referralInfo = await env.DB.prepare("PRAGMA table_info(referrals)").all();
      const referralColumnNames = new Set((referralInfo.results || []).map(column => column.name));
      if (!referralColumnNames.has("referrer_id")) {
        await env.DB.prepare("ALTER TABLE referrals ADD COLUMN referrer_id TEXT").run();
        referralColumnNames.add("referrer_id");
      }
      if (!referralColumnNames.has("referred_id")) {
        await env.DB.prepare("ALTER TABLE referrals ADD COLUMN referred_id TEXT").run();
        referralColumnNames.add("referred_id");
      }
      if (referralColumnNames.has("referrer_uuid")) {
        await env.DB.prepare("UPDATE referrals SET referrer_id = referrer_uuid WHERE referrer_id IS NULL OR referrer_id = ''").run();
      }
      if (referralColumnNames.has("referred_uuid")) {
        await env.DB.prepare("UPDATE referrals SET referred_id = referred_uuid WHERE referred_id IS NULL OR referred_id = ''").run();
      }
      await env.DB.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_referrals_referred_id ON referrals(referred_id)").run();
      if (!referralColumnNames.has("status")) {
        await env.DB.prepare("ALTER TABLE referrals ADD COLUMN status TEXT NOT NULL DEFAULT 'pending'").run();
        referralColumnNames.add("status");
      }
      if (!referralColumnNames.has("risk_score")) {
        await env.DB.prepare("ALTER TABLE referrals ADD COLUMN risk_score INTEGER NOT NULL DEFAULT 0").run();
        referralColumnNames.add("risk_score");
      }
      if (!referralColumnNames.has("risk_reason")) {
        await env.DB.prepare("ALTER TABLE referrals ADD COLUMN risk_reason TEXT NOT NULL DEFAULT ''").run();
        referralColumnNames.add("risk_reason");
      }
      await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_referrals_referrer ON referrals(referrer_id)").run();
  
      await env.DB.prepare(`
        CREATE TABLE IF NOT EXISTS mission_submissions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id TEXT NOT NULL,
          mission_id INTEGER NOT NULL,
          proof_file_id TEXT,
          status TEXT NOT NULL DEFAULT 'pending',
          created_at INTEGER NOT NULL,
          reviewed_at INTEGER
        )
      `).run();
  
      // Recover eligible referrals left pending if an earlier reward batch failed.
      // Only referrals with an approved mission and no high-risk flag are paid.
      await env.DB.prepare(`
        CREATE TABLE IF NOT EXISTS point_ledger (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_uuid TEXT NOT NULL,
          delta INTEGER NOT NULL,
          balance_after INTEGER NOT NULL,
          reason TEXT NOT NULL,
          reference_type TEXT NOT NULL,
          reference_id TEXT NOT NULL,
          created_at INTEGER NOT NULL
        )
      `).run();
      const eligibleReferrals = await env.DB.prepare(`
        SELECT r.id, r.referrer_id, r.referred_id
        FROM referrals r
        WHERE r.status = 'pending' AND COALESCE(r.risk_score, 0) < 70
          AND EXISTS (
            SELECT 1 FROM mission_submissions s
            WHERE s.user_id = r.referred_id AND s.status = 'approved'
          )
          AND EXISTS (SELECT 1 FROM users u WHERE u.user_uuid = r.referrer_id AND u.status = 'active')
          AND EXISTS (SELECT 1 FROM users u WHERE u.user_uuid = r.referred_id AND u.status = 'active')
        ORDER BY r.id ASC
        LIMIT 100
      `).all();
  
      for (const referral of eligibleReferrals.results || []) {
        const paidAt = Math.floor(Date.now() / 1000);
        await env.DB.batch([
          env.DB.prepare(`
            UPDATE referrals SET status = 'rewarded', points_awarded = 30
            WHERE id = ? AND status = 'pending' AND COALESCE(risk_score, 0) < 70
              AND EXISTS (SELECT 1 FROM mission_submissions WHERE user_id = ? AND status = 'approved')
              AND EXISTS (SELECT 1 FROM users WHERE user_uuid = ? AND status = 'active')
              AND EXISTS (SELECT 1 FROM users WHERE user_uuid = ? AND status = 'active')
          `).bind(referral.id, referral.referred_id, referral.referrer_id, referral.referred_id),
          env.DB.prepare(`
            UPDATE users SET points = points + 30, updated_at = ?
            WHERE user_uuid = ? AND status = 'active' AND changes() = 1
          `).bind(paidAt, referral.referrer_id),
          env.DB.prepare(`
            INSERT INTO point_ledger
              (user_uuid, delta, balance_after, reason, reference_type, reference_id, created_at)
            SELECT user_uuid, 30, points, 'referral_reward', 'referral', CAST(? AS TEXT), ?
            FROM users WHERE user_uuid = ? AND changes() = 1
          `).bind(referral.id, paidAt, referral.referrer_id),
          env.DB.prepare(`
            UPDATE users SET points = points + 50, updated_at = ?
            WHERE user_uuid = ? AND status = 'active' AND changes() = 1
          `).bind(paidAt, referral.referred_id),
          env.DB.prepare(`
            INSERT INTO point_ledger
              (user_uuid, delta, balance_after, reason, reference_type, reference_id, created_at)
            SELECT user_uuid, 50, points, 'referral_invited_bonus', 'referral', CAST(? AS TEXT), ?
            FROM users WHERE user_uuid = ? AND changes() = 1
          `).bind(referral.id, paidAt, referral.referred_id),
          env.DB.prepare(`
            UPDATE visitors SET points = (SELECT points FROM users WHERE user_uuid = ?)
            WHERE user_id = ? AND EXISTS (
              SELECT 1 FROM point_ledger
              WHERE user_uuid = ? AND reason = 'referral_reward'
                AND reference_type = 'referral' AND reference_id = CAST(? AS TEXT)
            )
          `).bind(referral.referrer_id, referral.referrer_id, referral.referrer_id, referral.id),
          env.DB.prepare(`
            UPDATE visitors SET points = (SELECT points FROM users WHERE user_uuid = ?)
            WHERE user_id = ? AND EXISTS (
              SELECT 1 FROM point_ledger
              WHERE user_uuid = ? AND reason = 'referral_invited_bonus'
                AND reference_type = 'referral' AND reference_id = CAST(? AS TEXT)
            )
          `).bind(referral.referred_id, referral.referred_id, referral.referred_id, referral.id)
        ]);
      }
  
  
    } catch (referralSetupError) {
      console.error("Referral storage/recovery step failed; continuing with invite link:", referralSetupError);
    }

    diagnosticStage = "READ_ACCOUNT";
    const account = await env.DB.prepare(`
      SELECT user_uuid, public_id, points
      FROM users
      WHERE user_uuid = ?
      LIMIT 1
    `).bind(userId).first();

    if (!account) {
      return json({ success: false, error: "ACCOUNT_NOT_FOUND" }, 404);
    }

    // Telegram deep links require the real numeric Telegram ID, not the
    // public OX- display code. Resolve it from the verified identity table.
    diagnosticStage = "READ_TELEGRAM_IDENTITY";
    const telegramIdentity = await env.DB.prepare(`
      SELECT telegram_user_id
      FROM telegram_identities
      WHERE user_uuid = ?
      LIMIT 1
    `).bind(userId).first();

    if (!telegramIdentity?.telegram_user_id) {
      return json({ success: false, error: "TELEGRAM_IDENTITY_NOT_FOUND" }, 404);
    }

    // Referral totals are secondary; the user's unique code must still be returned
    // if an older referrals table has a different optional statistics schema.
    let stats = { total: 0, earned: 0 };
    try {
      stats = await env.DB.prepare(`
        SELECT COUNT(*) AS total,
               COALESCE(SUM(points_awarded), 0) AS earned
        FROM referrals
        WHERE referrer_id = ?
      `).bind(userId).first() || stats;
    } catch (statsError) {
      console.error("Referral statistics unavailable:", statsError);
    }

    // Rankings are optional: a ranking-query issue must never hide a user's own invite link.
    let pointsRanking = { results: [] };
    let referralRanking = { results: [] };

    try {
      pointsRanking = await env.DB.prepare(`
        SELECT u.user_uuid AS user_id, COALESCE(u.public_id, p.public_id) AS display_id,
               u.points, p.username, p.photo_url, p.telegram_url
        FROM users u
        LEFT JOIN visitors v ON v.user_id = u.user_uuid
        LEFT JOIN oxide_profiles p ON p.user_uuid = u.user_uuid
        WHERE u.status = 'active'
        ORDER BY COALESCE(u.points, 0) DESC, u.created_at ASC, u.user_uuid ASC
        LIMIT 10
      `).all();
    } catch (rankingError) {
      console.error("Referral points ranking unavailable:", rankingError);
    }

    try {
      referralRanking = await env.DB.prepare(`
        SELECT r.referrer_id, COUNT(*) AS total,
               COALESCE(u.public_id, p.public_id) AS display_id,
               p.username, p.photo_url, p.telegram_url
        FROM referrals r
        LEFT JOIN users u ON u.user_uuid = r.referrer_id
        LEFT JOIN oxide_profiles p ON p.user_uuid = r.referrer_id
        GROUP BY r.referrer_id
        ORDER BY total DESC, r.referrer_id ASC
        LIMIT 10
      `).all();
    } catch (rankingError) {
      console.error("Referral ranking unavailable:", rankingError);
    }

    return json({
      success: true,

      referralCode: String(telegramIdentity.telegram_user_id),

      user: {
        userId: account.public_id || shortId(userId),
        points: Number(account.points || 0),
        referrals: Number(stats?.total || 0),
        earned: Number(stats?.earned || 0)
      },

      pointsRanking: (pointsRanking.results || []).map(
        (item, index) => ({
          rank: index + 1,
          userId: item.display_id || shortId(item.user_id),
          displayId: item.display_id || shortId(item.user_id),
          username: item.username || "",
          photoUrl: item.photo_url || "",
          telegramUrl: item.telegram_url || "",
          points: Number(item.points || 0)
        })
      ),

      referralRanking: (referralRanking.results || []).map(
        (item, index) => ({
          rank: index + 1,
          userId: item.display_id || shortId(item.referrer_id),
          displayId: item.display_id || shortId(item.referrer_id),
          username: item.username || "",
          photoUrl: item.photo_url || "",
          telegramUrl: item.telegram_url || "",
          referrals: Number(item.total || 0)
        })
      )
    });

  } catch (error) {
    console.error("Referral data load failed at", diagnosticStage, error);
    return json({
      success: false,
      error: "Could not load referral data"
    }, 500);
  }
}

export async function onRequestPost() {
  // Referral attribution is now accepted only from a verified Telegram /start payload.
  // This closes the legacy website-code endpoint that could bypass fraud checks.
  return json({
    success: false,
    error: "TELEGRAM_DEEP_LINK_REQUIRED"
  }, 410);
}
