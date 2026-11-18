
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

    // الرصيد الإجمالي للمستخدم من جميع مصادر المكافآت
    const user = await env.DB.prepare(`
      SELECT user_id, points
      FROM visitors
      WHERE user_id = ?
    `).bind(userId).first();

    if (!user) {
      return json({
        success: false,
        error: "USER_NOT_FOUND"
      }, 404);
    }

    // إحصائيات الإحالات فقط
    const stats = await env.DB.prepare(`
      SELECT
        COUNT(*) AS total,
        COALESCE(SUM(points_awarded), 0) AS earned
      FROM referrals
      WHERE referrer_id = ?
    `).bind(userId).first();

    // Top users are read from persistent D1 records and enriched with Telegram profiles.
    const pointsRanking = await env.DB.prepare(`
      SELECT v.user_id, COALESCE(u.public_id, p.public_id) AS display_id,
             v.points, p.username, p.photo_url, p.telegram_url
      FROM visitors v
      LEFT JOIN users u ON u.user_uuid = v.user_id
      LEFT JOIN oxide_profiles p ON p.user_uuid = v.user_id
      ORDER BY COALESCE(v.points, 0) DESC, v.created_at ASC, v.user_id ASC
      LIMIT 10
    `).all();

    const referralRanking = await env.DB.prepare(`
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

    return json({
      success: true,

      referralCode: (await env.DB.prepare("SELECT public_id FROM users WHERE user_uuid = ? LIMIT 1").bind(userId).first())?.public_id || shortId(user.user_id),

      user: {
        userId: (await env.DB.prepare("SELECT public_id FROM users WHERE user_uuid = ? LIMIT 1").bind(userId).first())?.public_id || shortId(user.user_id),
        points: Number(user.points || 0),
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
    return json({
      success: false,
      error: "Could not load referral data"
    }, 500);
  }
}

export async function onRequestPost({ request, env }) {
  try {
    if (!env.DB || !env.SESSION_SECRET) {
      return json({ success: false, error: "SERVER_CONFIGURATION_MISSING" }, 500);
    }

    const body = await request.json().catch(() => ({}));
    const enteredCode = String(body.referrerId || body.code || "").trim().toUpperCase();
    const uuidPattern = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i;
    let referrer = null;

    if (uuidPattern.test(enteredCode)) {
      referrer = await env.DB.prepare(
        "SELECT user_id FROM visitors WHERE UPPER(user_id) = ? LIMIT 1"
      ).bind(enteredCode).first();
    } else {
      const profile = await env.DB.prepare(`
        SELECT user_uuid AS user_id FROM oxide_profiles
        WHERE UPPER(public_id) = ? LIMIT 1
      `).bind(enteredCode).first();
      if (profile) referrer = profile;
      else {
        const legacyMatch = enteredCode.match(/^OX-?([0-9A-F]{8})$/);
        if (legacyMatch) {
          const matches = await env.DB.prepare(`
            SELECT user_id FROM visitors
            WHERE UPPER(SUBSTR(REPLACE(user_id, '-', ''), 1, 8)) = ?
            LIMIT 2
          `).bind(legacyMatch[1]).all();
          if ((matches.results || []).length === 1) referrer = matches.results[0];
          else if ((matches.results || []).length > 1) {
            return json({ success: false, error: "REFERRAL_CODE_AMBIGUOUS" }, 409);
          }
        }
      }
    }

    if (!referrer) {
      return json({ success: false, error: "REFERRER_NOT_FOUND" }, 404);
    }

    const userId = await getVisitor(request, env);
    if (!userId) {
      return json({ success: false, error: "NO_TELEGRAM_SESSION" }, 401);
    }

    if (String(userId).toLowerCase() === String(referrer.user_id).toLowerCase()) {
      return json({ success: false, error: "SELF_REFERRAL" }, 400);
    }

    const now = Math.floor(Date.now() / 1000);
    await env.DB.prepare(`
      INSERT OR IGNORE INTO visitors (user_id, progress, points, created_at)
      VALUES (?, 0, 0, ?)
    `).bind(userId, now).run();

    const already = await env.DB.prepare(
      "SELECT id FROM referrals WHERE referred_id = ? LIMIT 1"
    ).bind(userId).first();
    if (already) {
      return json({ success: true, alreadyRegistered: true }, 200);
    }

    // Keep the existing database trigger compatible: insert the historical
    // 15-point event, then top it up by 35 so the referrer receives exactly 50.
    // Each follow-up statement runs only when the preceding statement changed one row.
    const results = await env.DB.batch([
      env.DB.prepare(`
        INSERT OR IGNORE INTO referrals
          (referrer_id, referred_id, points_awarded, created_at)
        VALUES (?, ?, 15, ?)
      `).bind(referrer.user_id, userId, now),
      env.DB.prepare(`
        UPDATE visitors SET points = points + 30
        WHERE user_id = ?
          AND changes() = 1
          AND EXISTS (SELECT 1 FROM referrals WHERE referred_id = ?)
      `).bind(userId, userId),
      env.DB.prepare(`
        UPDATE referrals SET points_awarded = 50
        WHERE referred_id = ?
          AND points_awarded = 15
          AND changes() = 1
      `).bind(userId),
      env.DB.prepare(`
        UPDATE visitors SET points = points + 35
        WHERE user_id = ?
          AND changes() = 1
          AND EXISTS (SELECT 1 FROM referrals WHERE referred_id = ? AND points_awarded = 50)
      `).bind(referrer.user_id, userId),
      env.DB.prepare(`
        UPDATE users SET points = (SELECT points FROM visitors WHERE user_id = users.user_uuid),
          updated_at = ?
        WHERE user_uuid = ? AND EXISTS (SELECT 1 FROM referrals WHERE referred_id = ? AND points_awarded = 50)
      `).bind(now, userId, userId),
      env.DB.prepare(`
        UPDATE users SET points = (SELECT points FROM visitors WHERE user_id = users.user_uuid),
          updated_at = ?
        WHERE user_uuid = ? AND EXISTS (SELECT 1 FROM referrals WHERE referred_id = ? AND points_awarded = 50)
      `).bind(now, referrer.user_id, userId)
    ]);

    if (Number(results?.[0]?.meta?.changes || 0) !== 1) {
      return json({ success: false, error: "REFERRAL_ALREADY_USED" }, 409);
    }

    return json({
      success: true,
      registered: true,
      invitedPointsAwarded: 30,
      referrerPointsAwarded: 50,
      userId: shortId(userId)
    });
  } catch (error) {
    console.error("Referral registration failed:", error);
    return json({ success: false, error: "Could not register referral" }, 500);
  }
}
