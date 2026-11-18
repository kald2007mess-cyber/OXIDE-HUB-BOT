import { getVisitor, json } from "./_lib/session.js";

const REWARD_POINTS = 10;
const MAX_ADS = 10;
const CYCLE_SECONDS = 5 * 60 * 60;
const CLAIM_COOLDOWN_SECONDS = 30;

export async function onRequestPost({ request, env }) {
  try {
    if (!env.DB || !env.SESSION_SECRET) {
      return json({ success: false, error: "SERVER_CONFIGURATION_MISSING" }, 500);
    }

    const userId = await getVisitor(request, env);
    if (!userId) return json({ success: false, error: "NO_TELEGRAM_SESSION" }, 401);

    const now = Math.floor(Date.now() / 1000);
    const account = await env.DB.prepare(
      "SELECT status FROM users WHERE user_uuid = ? LIMIT 1"
    ).bind(userId).first();

    if (!account || account.status !== "active") {
      return json({ success: false, error: "ACCOUNT_NOT_ACTIVE" }, 403);
    }

    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS reward_ad_cycles (
        user_id TEXT PRIMARY KEY,
        completed_ads INTEGER NOT NULL DEFAULT 0,
        cycle_started_at INTEGER NOT NULL
      )
    `).run();

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
      CREATE TABLE IF NOT EXISTS adsgram_reward_state (
        user_id TEXT PRIMARY KEY,
        last_claim_at INTEGER NOT NULL DEFAULT 0
      )
    `).run();

    await env.DB.prepare(
      "INSERT OR IGNORE INTO reward_ad_cycles (user_id, completed_ads, cycle_started_at) VALUES (?, 0, ?)"
    ).bind(userId, now).run();

    await env.DB.prepare(
      "INSERT OR IGNORE INTO adsgram_reward_state (user_id, last_claim_at) VALUES (?, 0)"
    ).bind(userId).run();

    const cycle = await env.DB.prepare(
      "SELECT completed_ads, cycle_started_at FROM reward_ad_cycles WHERE user_id = ?"
    ).bind(userId).first();

    let completed = Number(cycle?.completed_ads || 0);
    const startedAt = Number(cycle?.cycle_started_at || now);

    if (now - startedAt >= CYCLE_SECONDS) {
      await env.DB.prepare(
        "UPDATE reward_ad_cycles SET completed_ads = 0, cycle_started_at = ? WHERE user_id = ?"
      ).bind(now, userId).run();
      completed = 0;
    }

    if (completed >= MAX_ADS) {
      return json({ success: false, error: "AD_CYCLE_COMPLETE" }, 409);
    }

    const results = await env.DB.batch([
      env.DB.prepare(
        "UPDATE adsgram_reward_state SET last_claim_at = ? WHERE user_id = ? AND last_claim_at <= ?"
      ).bind(now, userId, now - CLAIM_COOLDOWN_SECONDS),
      env.DB.prepare(
        "UPDATE reward_ad_cycles SET completed_ads = completed_ads + 1 WHERE user_id = ? AND completed_ads < ? AND changes() = 1"
      ).bind(userId, MAX_ADS),
      env.DB.prepare(
        "UPDATE visitors SET points = points + ? WHERE user_id = ? AND changes() = 1"
      ).bind(REWARD_POINTS, userId),
      env.DB.prepare(
        "UPDATE users SET points = (SELECT points FROM visitors WHERE user_id = ?), updated_at = ? WHERE user_uuid = ? AND changes() = 1"
      ).bind(userId, now, userId),
      env.DB.prepare(`
        INSERT INTO point_ledger
          (user_uuid,delta,balance_after,reason,reference_type,reference_id,created_at)
        SELECT u.user_uuid,?,u.points,'adsgram_ad_reward','adsgram_ad',CAST(c.completed_ads AS TEXT),?
        FROM users u JOIN reward_ad_cycles c ON c.user_id = u.user_uuid
        WHERE u.user_uuid = ?
          AND EXISTS (SELECT 1 FROM adsgram_reward_state WHERE user_id = ? AND last_claim_at = ?)
          AND changes() = 1
      `).bind(REWARD_POINTS,now,userId,userId,now)
    ]);

    if (Number(results?.[0]?.meta?.changes || 0) !== 1) {
      return json({ success: false, error: "REWARD_COOLDOWN" }, 429);
    }

    if (Number(results?.[1]?.meta?.changes || 0) !== 1 ||
        Number(results?.[2]?.meta?.changes || 0) !== 1) {
      return json({ success: false, error: "REWARD_NOT_APPLIED" }, 409);
    }

    const [balance, updatedCycle] = await Promise.all([
      env.DB.prepare("SELECT points FROM visitors WHERE user_id = ?").bind(userId).first(),
      env.DB.prepare("SELECT completed_ads FROM reward_ad_cycles WHERE user_id = ?").bind(userId).first()
    ]);

    return json({
      success: true,
      pointsAwarded: REWARD_POINTS,
      points: Number(balance?.points || 0),
      completedAds: Math.min(MAX_ADS, Number(updatedCycle?.completed_ads || 0)),
      requiredAds: MAX_ADS
    });
  } catch (error) {
    console.error("AdsGram reward failed:", error);
    return json({ success: false, error: "ADSGRAM_REWARD_FAILED" }, 500);
  }
}
