import { getVisitor, json } from "./_lib/session.js";

const REWARD_POINTS = 20;
const MAX_ADS = 10;
const CYCLE_SECONDS = 5 * 60 * 60;
const CLAIM_COOLDOWN_SECONDS = 30;

function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || !a || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function ensureTables(DB) {
  await DB.prepare(`
    CREATE TABLE IF NOT EXISTS reward_ad_cycles (
      user_id TEXT PRIMARY KEY,
      completed_ads INTEGER NOT NULL DEFAULT 0,
      cycle_started_at INTEGER NOT NULL
    )
  `).run();
  await DB.prepare(`
    CREATE TABLE IF NOT EXISTS adsgram_reward_state (
      user_id TEXT PRIMARY KEY,
      last_claim_at INTEGER NOT NULL DEFAULT 0
    )
  `).run();
  await DB.prepare(`
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
}

async function readProgress(DB, userId, now) {
  await DB.prepare(
    "INSERT OR IGNORE INTO reward_ad_cycles(user_id,completed_ads,cycle_started_at) VALUES(?,0,?)"
  ).bind(userId, now).run();
  let cycle = await DB.prepare(
    "SELECT completed_ads,cycle_started_at FROM reward_ad_cycles WHERE user_id=?"
  ).bind(userId).first();
  if (now - Number(cycle?.cycle_started_at || now) >= CYCLE_SECONDS) {
    await DB.prepare(
      "UPDATE reward_ad_cycles SET completed_ads=0,cycle_started_at=? WHERE user_id=?"
    ).bind(now, userId).run();
    cycle = { completed_ads: 0, cycle_started_at: now };
  }
  return Math.min(MAX_ADS, Math.max(0, Number(cycle?.completed_ads || 0)));
}

async function awardVerifiedAd(DB, userUuid, now) {
  await DB.prepare(
    "INSERT OR IGNORE INTO adsgram_reward_state(user_id,last_claim_at) VALUES(?,0)"
  ).bind(userUuid).run();

  const current = await readProgress(DB, userUuid, now);
  if (current >= MAX_ADS) return { success: false, error: "AD_CYCLE_COMPLETE" };

  const reference = crypto.randomUUID();
  const results = await DB.batch([
    DB.prepare(
      "UPDATE adsgram_reward_state SET last_claim_at=? WHERE user_id=? AND last_claim_at<=?"
    ).bind(now, userUuid, now - CLAIM_COOLDOWN_SECONDS),
    DB.prepare(
      "UPDATE reward_ad_cycles SET completed_ads=completed_ads+1 WHERE user_id=? AND completed_ads<? AND changes()=1"
    ).bind(userUuid, MAX_ADS),
    DB.prepare(
      "UPDATE users SET points=points+?,updated_at=? WHERE user_uuid=? AND status='active' AND changes()=1"
    ).bind(REWARD_POINTS, now, userUuid),
    DB.prepare(`
      INSERT INTO point_ledger
        (user_uuid,delta,balance_after,reason,reference_type,reference_id,created_at)
      SELECT user_uuid,?,points,'adsgram_ad_reward','adsgram_ad',?,?
      FROM users
      WHERE user_uuid=?
        AND EXISTS(SELECT 1 FROM adsgram_reward_state WHERE user_id=? AND last_claim_at=?)
        AND changes()=1
    `).bind(REWARD_POINTS, reference, now, userUuid, userUuid, now)
  ]);

  if (Number(results?.[0]?.meta?.changes || 0) !== 1) {
    return { success: false, error: "REWARD_COOLDOWN" };
  }
  if (Number(results?.[1]?.meta?.changes || 0) !== 1 ||
      Number(results?.[2]?.meta?.changes || 0) !== 1 ||
      Number(results?.[3]?.meta?.changes || 0) !== 1) {
    return { success: false, error: "REWARD_NOT_APPLIED" };
  }

  // Keep legacy rankings and wallet screens in sync with users.points.
  await DB.prepare(`
    INSERT INTO visitors (user_id, progress, points, cycle_started_at, created_at)
    SELECT user_uuid, 0, points, ?, ?
    FROM users WHERE user_uuid = ?
    ON CONFLICT(user_id) DO UPDATE SET points = excluded.points
  `).bind(now, now, userUuid).run();

  const [balance, completed] = await Promise.all([
    DB.prepare("SELECT points FROM users WHERE user_uuid=?").bind(userUuid).first(),
    DB.prepare("SELECT completed_ads FROM reward_ad_cycles WHERE user_id=?").bind(userUuid).first()
  ]);
  return {
    success: true,
    pointsAwarded: REWARD_POINTS,
    points: Number(balance?.points || 0),
    completedAds: Math.min(MAX_ADS, Number(completed?.completed_ads || 0))
  };
}

export async function onRequestGet({ request, env }) {
  try {
    if (!env.DB) return json({ success: false, error: "DATABASE_NOT_CONFIGURED" }, 500);
    await ensureTables(env.DB);
    const url = new URL(request.url);
    const suppliedSecret = String(url.searchParams.get("key") || "");
    const callbackUserId = String(
      url.searchParams.get("userid") ||
      url.searchParams.get("userId") ||
      url.searchParams.get("user_id") ||
      ""
    );

    // AdsGram Reward URL server callback. The secret is stored only in Cloudflare
    // and in the AdsGram dashboard; it is never sent by the Mini App frontend.
    if (suppliedSecret || callbackUserId) {
      if (!env.ADSGRAM_REWARD_SECRET ||
          !safeEqual(suppliedSecret, String(env.ADSGRAM_REWARD_SECRET)) ||
          !/^[0-9]{5,20}$/.test(callbackUserId)) {
        return json({ success: false, error: "INVALID_REWARD_CALLBACK" }, 403);
      }
      const identity = await env.DB.prepare(
        "SELECT user_uuid FROM telegram_identities WHERE telegram_user_id=? LIMIT 1"
      ).bind(callbackUserId).first();
      if (!identity?.user_uuid) return json({ success: false, error: "TELEGRAM_USER_NOT_FOUND" }, 404);
      const account = await env.DB.prepare(
        "SELECT status FROM users WHERE user_uuid=? LIMIT 1"
      ).bind(identity.user_uuid).first();
      if (!account || account.status !== "active") return json({ success: false, error: "ACCOUNT_NOT_ACTIVE" }, 403);
      const now = Math.floor(Date.now() / 1000);
      const result = await awardVerifiedAd(env.DB, identity.user_uuid, now);
      return json(result, result.success ? 200 : result.error === "REWARD_COOLDOWN" ? 429 : 409);
    }

    // Authenticated read-only endpoint used by the Mini App to poll for the
    // server-confirmed reward after the ad has completed.
    if (!env.SESSION_SECRET) return json({ success: false, error: "SERVER_CONFIGURATION_MISSING" }, 500);
    const userId = await getVisitor(request, env);
    if (!userId) return json({ success: false, error: "NO_TELEGRAM_SESSION" }, 401);
    const now = Math.floor(Date.now() / 1000);
    const completedAds = await readProgress(env.DB, userId, now);
    const user = await env.DB.prepare("SELECT points FROM users WHERE user_uuid=?").bind(userId).first();
    return json({ success: true, completedAds, points: Number(user?.points || 0) });
  } catch (error) {
    console.error("AdsGram reward endpoint failed:", error);
    return json({ success: false, error: "ADSGRAM_REWARD_FAILED" }, 500);
  }
}

// A browser POST is not proof that an advertisement was completed.
// Only the secret-protected AdsGram server callback can issue this reward.
export async function onRequestPost() {
  return json({ success: false, error: "SERVER_CALLBACK_REQUIRED" }, 403);
}
