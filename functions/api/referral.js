
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
  try {
    if (!env.DB || !env.SESSION_SECRET) {
      return json({
        success: false,
        error: "Server configuration missing"
      }, 500);
    }

    const userId = await getVisitor(request, env);

    if (!userId) {
      return json({
        success: false,
        error: "USER_NOT_FOUND"
      }, 401);
    }

    // Ensure referral storage exists before reading the user's personal link.
    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS referrals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        referrer_id TEXT NOT NULL,
        referred_id TEXT NOT NULL UNIQUE,
        points_awarded INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      )
    `).run();
    // Index creation is an optimization; do not block personal referral data if it fails.
    try {
      await env.DB.prepare(`
        CREATE INDEX IF NOT EXISTS idx_referrals_referrer
        ON referrals(referrer_id)
      `).run();
    } catch (indexError) {
      console.error("Referral index unavailable:", indexError);
    }

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
        SELECT v.user_id, COALESCE(u.public_id, p.public_id) AS display_id,
               v.points, p.username, p.photo_url, p.telegram_url
        FROM visitors v
        LEFT JOIN users u ON u.user_uuid = v.user_id
        LEFT JOIN oxide_profiles p ON p.user_uuid = v.user_id
        ORDER BY COALESCE(v.points, 0) DESC, v.created_at ASC, v.user_id ASC
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
    console.error("Referral data load failed:", error);
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
