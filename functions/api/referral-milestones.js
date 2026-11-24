import { getVisitor, json } from "./_lib/session.js";

const MILESTONES = {
  5: { target: 5, reward: 100 },
  10: { target: 10, reward: 200 },
  20: { target: 20, reward: 500 }
};

async function ensureTables(DB) {
  await DB.prepare(`
    CREATE TABLE IF NOT EXISTS referral_milestone_claims (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      milestone_id INTEGER NOT NULL,
      reward INTEGER NOT NULL,
      claimed_at INTEGER NOT NULL,
      UNIQUE(user_id, milestone_id)
    )
  `).run();
  await DB.prepare("CREATE INDEX IF NOT EXISTS idx_referral_milestone_user ON referral_milestone_claims(user_id)").run();
}

async function getProgress(DB, userId) {
  const eligible = await DB.prepare(`
    SELECT COUNT(*) AS total
    FROM referrals
    WHERE referrer_id = ? AND status = 'rewarded'
  `).bind(userId).first();
  const total = await DB.prepare("SELECT COUNT(*) AS total FROM referrals WHERE referrer_id = ?").bind(userId).first();
  const claims = await DB.prepare(`
    SELECT milestone_id FROM referral_milestone_claims
    WHERE user_id = ? ORDER BY milestone_id
  `).bind(userId).all();
  return {
    eligible: Number(eligible?.total || 0),
    total: Number(total?.total || 0),
    claimed: (claims.results || []).map(row => Number(row.milestone_id))
  };
}

export async function onRequestGet({ request, env }) {
  try {
    if (!env.DB || !env.SESSION_SECRET) return json({ success: false, error: "SERVER_CONFIGURATION_MISSING" }, 500);
    const userId = await getVisitor(request, env);
    if (!userId) return json({ success: false, error: "USER_NOT_FOUND" }, 401);
    await ensureTables(env.DB);
    const progress = await getProgress(env.DB, userId);
    return json({ success: true, ...progress });
  } catch (error) {
    console.error("Referral milestone GET failed:", error);
    return json({ success: false, error: "MILESTONES_LOAD_FAILED" }, 500);
  }
}

export async function onRequestPost({ request, env }) {
  try {
    if (!env.DB || !env.SESSION_SECRET) return json({ success: false, error: "SERVER_CONFIGURATION_MISSING" }, 500);
    const userId = await getVisitor(request, env);
    if (!userId) return json({ success: false, error: "USER_NOT_FOUND" }, 401);
    const body = await request.json().catch(() => ({}));
    const milestoneId = Number(body?.milestoneId);
    const milestone = MILESTONES[milestoneId];
    if (!milestone) return json({ success: false, error: "INVALID_MILESTONE" }, 400);

    await ensureTables(env.DB);
    const account = await env.DB.prepare(
      "SELECT points FROM users WHERE user_uuid = ? AND status = 'active'"
    ).bind(userId).first();
    if (!account) return json({ success: false, error: "USER_NOT_FOUND" }, 404);

    const claimedAt = Math.floor(Date.now() / 1000);
    const results = await env.DB.batch([
      env.DB.prepare(`
        INSERT OR IGNORE INTO referral_milestone_claims
          (user_id, milestone_id, reward, claimed_at)
        SELECT ?, ?, ?, ?
        WHERE (
          SELECT COUNT(*) FROM referrals
          WHERE referrer_id = ? AND (? = 5 AND status = 'rewarded' OR ? <> 5)
        ) >= ?
      `).bind(userId, milestoneId, milestone.reward, claimedAt, userId, milestoneId, milestoneId, milestone.target),
      env.DB.prepare(`
        UPDATE users SET points = points + ?, updated_at = ?
        WHERE user_uuid = ? AND status = 'active' AND changes() = 1
      `).bind(milestone.reward, claimedAt, userId),
      env.DB.prepare(`
        INSERT INTO point_ledger
          (user_uuid, delta, balance_after, reason, reference_type, reference_id, created_at)
        SELECT user_uuid, ?, points, 'referral_milestone_reward',
               'referral_milestone', ?, ?
        FROM users WHERE user_uuid = ? AND changes() = 1
      `).bind(milestone.reward, String(milestoneId), claimedAt, userId)
    ]);

    if (Number(results?.[0]?.meta?.changes || 0) !== 1) {
      const progress = await getProgress(env.DB, userId);
      const alreadyClaimed = progress.claimed.includes(milestoneId);
      return json({
        success: false,
        error: alreadyClaimed ? "ALREADY_CLAIMED" : "MILESTONE_NOT_READY",
        ...progress
      }, 409);
    }

    const updated = await env.DB.prepare(
      "SELECT points FROM users WHERE user_uuid = ?"
    ).bind(userId).first();
    const progress = await getProgress(env.DB, userId);
    return json({
      success: true,
      reward: milestone.reward,
      balance: Number(updated?.points || 0),
      ...progress
    });
  } catch (error) {
    console.error("Referral milestone claim failed:", error);
    return json({ success: false, error: "MILESTONE_CLAIM_FAILED" }, 500);
  }
}
