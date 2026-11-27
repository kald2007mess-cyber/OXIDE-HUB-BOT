import { getVisitor, json } from "./_lib/session.js";

const OFFERS = ["beta", "android", "ios", "beta_pc"];
const COST = 1000;

async function ensure(DB) {
  await DB.prepare("CREATE TABLE IF NOT EXISTS platform_paid_unlocks (user_uuid TEXT NOT NULL, offer TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(user_uuid, offer))").run();
  await DB.prepare("CREATE TABLE IF NOT EXISTS point_ledger (id INTEGER PRIMARY KEY AUTOINCREMENT, user_uuid TEXT NOT NULL, delta REAL NOT NULL, balance_after REAL NOT NULL, reason TEXT NOT NULL, reference_type TEXT NOT NULL, reference_id TEXT NOT NULL, created_at INTEGER NOT NULL)").run();
}

export async function onRequestPost({ request, env }) {
  try {
    if (!env.DB || !env.SESSION_SECRET) return json({ success: false, error: "SERVER_CONFIGURATION_MISSING" }, 500);
    const userUuid = await getVisitor(request, env);
    if (!userUuid) return json({ success: false, error: "NO_TELEGRAM_SESSION" }, 401);
    const body = await request.json().catch(() => ({}));
    const offer = String(body.offer || "").toLowerCase();
    if (!OFFERS.includes(offer)) return json({ success: false, error: "INVALID_OFFER" }, 400);
    await ensure(env.DB);
    const existing = await env.DB.prepare("SELECT 1 AS unlocked FROM platform_paid_unlocks WHERE user_uuid=? AND offer=?").bind(userUuid, offer).first();
    if (existing) {
      const account = await env.DB.prepare("SELECT points FROM users WHERE user_uuid=? AND status='active'").bind(userUuid).first();
      return json({ success: true, alreadyUnlocked: true, offer, points: Number(account?.points || 0) });
    }
    const now = Math.floor(Date.now() / 1000);
    const result = await env.DB.batch([
      env.DB.prepare("UPDATE users SET points=points-?,updated_at=? WHERE user_uuid=? AND status='active' AND points>=? AND NOT EXISTS(SELECT 1 FROM platform_paid_unlocks WHERE user_uuid=? AND offer=?) RETURNING points").bind(COST, now, userUuid, COST, userUuid, offer),
      env.DB.prepare("INSERT INTO platform_paid_unlocks(user_uuid,offer,created_at) SELECT ?,?,? WHERE changes()=1").bind(userUuid, offer, now),
      env.DB.prepare("INSERT INTO point_ledger(user_uuid,delta,balance_after,reason,reference_type,reference_id,created_at) SELECT user_uuid,?,points,'platform_go_unlock','platform_offer',?,? FROM users WHERE user_uuid=? AND EXISTS(SELECT 1 FROM platform_paid_unlocks WHERE user_uuid=? AND offer=?) AND changes()=1").bind(-COST, offer, now, userUuid, userUuid, offer),
      env.DB.prepare("UPDATE visitors SET points=(SELECT points FROM users WHERE user_uuid=?) WHERE user_id=? AND EXISTS(SELECT 1 FROM platform_paid_unlocks WHERE user_uuid=? AND offer=?)").bind(userUuid, userUuid, userUuid, offer)
    ]);
    const debit = result?.[0]?.results?.[0] || null;
    if (Number(result?.[0]?.meta?.changes || 0) !== 1 || Number(result?.[1]?.meta?.changes || 0) !== 1) {
      const unlocked = await env.DB.prepare("SELECT 1 AS unlocked FROM platform_paid_unlocks WHERE user_uuid=? AND offer=?").bind(userUuid, offer).first();
      const account = await env.DB.prepare("SELECT points FROM users WHERE user_uuid=? AND status='active'").bind(userUuid).first();
      if (unlocked) return json({ success: true, alreadyUnlocked: true, offer, points: Number(account?.points || 0) });
      return json({ success: false, error: account ? "INSUFFICIENT_POINTS" : "USER_NOT_FOUND" }, account ? 400 : 404);
    }
    const account = await env.DB.prepare("SELECT points FROM users WHERE user_uuid=?").bind(userUuid).first();
    return json({ success: true, offer, cost: COST, points: Number(account?.points ?? debit?.points ?? 0) });
  } catch (error) {
    console.error("Platform unlock purchase failed:", error);
    return json({ success: false, error: "PLATFORM_UNLOCK_FAILED" }, 500);
  }
}
