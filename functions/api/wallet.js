import { getVisitor, json } from "./_lib/session.js";

const TAP_RATES = [0, 0.01, 0.05, 0.1];
const STORAGE_CAPS = [0, 1000, 1500, 2000];
const MINING_RATES = [0, 0.001, 0.01, 0.05];
const UPGRADE_COSTS = {
  tap: [0, 100, 500],
  storage: [0, 150, 600],
  mining: [0, 300, 1200]
};

async function ensureWallet(DB, userId, now) {
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
  await DB.prepare(`
    CREATE TABLE IF NOT EXISTS oxide_wallet_state (
      user_id TEXT PRIMARY KEY,
      taps INTEGER NOT NULL DEFAULT 0,
      tap_level INTEGER NOT NULL DEFAULT 1,
      storage_level INTEGER NOT NULL DEFAULT 1,
      mining_level INTEGER NOT NULL DEFAULT 1,
      last_mining_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `).run();
  await DB.prepare(`
    INSERT OR IGNORE INTO oxide_wallet_state
      (user_id, taps, tap_level, storage_level, mining_level, last_mining_at, updated_at)
    VALUES (?, 0, 1, 1, 1, ?, ?)
  `).bind(userId, now, now).run();
}

async function walletSnapshot(DB, userId) {
  const [account, state] = await Promise.all([
    DB.prepare("SELECT points FROM visitors WHERE user_id = ? LIMIT 1").bind(userId).first(),
    DB.prepare("SELECT taps, tap_level, storage_level, mining_level, last_mining_at FROM oxide_wallet_state WHERE user_id = ? LIMIT 1").bind(userId).first()
  ]);
  return {
    points: Number(account?.points || 0),
    taps: Number(state?.taps || 0),
    levels: {
      tap: Number(state?.tap_level || 1),
      storage: Number(state?.storage_level || 1),
      mining: Number(state?.mining_level || 1)
    }
  };
}

async function syncUserPoints(DB, userId, now) {
  await DB.prepare(`
    UPDATE users SET points = (SELECT points FROM visitors WHERE user_id = ?), updated_at = ?
    WHERE user_uuid = ?
  `).bind(userId, now, userId).run();
}

export async function onRequestGet({ request, env }) {
  try {
    if (!env.DB || !env.SESSION_SECRET) return json({ success: false, error: "SERVER_CONFIGURATION_MISSING" }, 500);
    const userId = await getVisitor(request, env);
    if (!userId) return json({ success: false, error: "NO_TELEGRAM_SESSION" }, 401);
    const now = Math.floor(Date.now() / 1000);
    await ensureWallet(env.DB, userId, now);
    return json({ success: true, ...(await walletSnapshot(env.DB, userId)) });
  } catch (error) {
    console.error("Wallet load failed:", error);
    return json({ success: false, error: "WALLET_LOAD_FAILED" }, 500);
  }
}

export async function onRequestPost({ request, env }) {
  try {
    if (!env.DB || !env.SESSION_SECRET) return json({ success: false, error: "SERVER_CONFIGURATION_MISSING" }, 500);
    const userId = await getVisitor(request, env);
    if (!userId) return json({ success: false, error: "NO_TELEGRAM_SESSION" }, 401);
    const body = await request.json().catch(() => ({}));
    const action = String(body.action || "");
    const now = Math.floor(Date.now() / 1000);
    await ensureWallet(env.DB, userId, now);

    if (action === "tap") {
      const state = await env.DB.prepare("SELECT taps, tap_level, storage_level FROM oxide_wallet_state WHERE user_id = ?").bind(userId).first();
      const cap = STORAGE_CAPS[Number(state?.storage_level || 1)];
      const reward = TAP_RATES[Number(state?.tap_level || 1)];
      if (Number(state?.taps || 0) >= cap) return json({ success: false, error: "STORAGE_FULL" }, 409);
      const tapReference = crypto.randomUUID();
      const results = await env.DB.batch([
        env.DB.prepare("UPDATE oxide_wallet_state SET taps = taps + 1, updated_at = ? WHERE user_id = ? AND taps < ?").bind(now, userId, cap),
        env.DB.prepare("UPDATE visitors SET points = points + ? WHERE user_id = ? AND changes() = 1").bind(reward, userId),
        env.DB.prepare("UPDATE users SET points = (SELECT points FROM visitors WHERE user_id = ?), updated_at = ? WHERE user_uuid = ? AND changes() = 1").bind(userId, now, userId),
        env.DB.prepare(`
          INSERT INTO point_ledger (user_uuid,delta,balance_after,reason,reference_type,reference_id,created_at)
          SELECT user_uuid,?,points,'wallet_tap','wallet_tap',?,?
          FROM users WHERE user_uuid = ?
            AND EXISTS (SELECT 1 FROM oxide_wallet_state WHERE user_id = ? AND updated_at = ?)
            AND changes() = 1
        `).bind(reward,tapReference,now,userId,userId,now)
      ]);
      if (Number(results?.[0]?.meta?.changes || 0) !== 1) return json({ success: false, error: "STORAGE_FULL" }, 409);
    } else if (action === "upgrade") {
      const kind = String(body.kind || "");
      if (!Object.hasOwn(UPGRADE_COSTS, kind)) return json({ success: false, error: "INVALID_UPGRADE" }, 400);
      const state = await env.DB.prepare("SELECT tap_level, storage_level, mining_level FROM oxide_wallet_state WHERE user_id = ?").bind(userId).first();
      const level = Number(state?.[kind + "_level"] || 1);
      if (level >= 3) return json({ success: false, error: "MAX_LEVEL" }, 409);
      const cost = UPGRADE_COSTS[kind][level];
      const upgradeReference = crypto.randomUUID();
      const results = await env.DB.batch([
        env.DB.prepare("UPDATE visitors SET points = points - ? WHERE user_id = ? AND points >= ?").bind(cost, userId, cost),
        env.DB.prepare(`UPDATE oxide_wallet_state SET ${kind}_level = ${kind}_level + 1, updated_at = ? WHERE user_id = ? AND ${kind}_level = ? AND changes() = 1`).bind(now, userId, level),
        env.DB.prepare("UPDATE users SET points = (SELECT points FROM visitors WHERE user_id = ?), updated_at = ? WHERE user_uuid = ? AND changes() = 1").bind(userId, now, userId),
        env.DB.prepare(`
          INSERT INTO point_ledger (user_uuid,delta,balance_after,reason,reference_type,reference_id,created_at)
          SELECT user_uuid,?,points,'wallet_upgrade','wallet_upgrade',?,?
          FROM users WHERE user_uuid = ?
            AND EXISTS (SELECT 1 FROM oxide_wallet_state WHERE user_id = ? AND updated_at = ?)
            AND changes() = 1
        `).bind(-cost,upgradeReference,now,userId,userId,now)
      ]);
      if (Number(results?.[0]?.meta?.changes || 0) !== 1 || Number(results?.[1]?.meta?.changes || 0) !== 1) {
        return json({ success: false, error: "INSUFFICIENT_BALANCE_OR_CONFLICT" }, 409);
      }
    } else if (action === "claim_mining") {
      const state = await env.DB.prepare("SELECT mining_level, last_mining_at FROM oxide_wallet_state WHERE user_id = ?").bind(userId).first();
      const level = Number(state?.mining_level || 1);
      const elapsed = Math.max(0, Math.min(3600, now - Number(state?.last_mining_at || now)));
      const reward = Math.round(elapsed * MINING_RATES[level] * 1000) / 1000;
      const miningReference = crypto.randomUUID();
      const results = await env.DB.batch([
        env.DB.prepare("UPDATE oxide_wallet_state SET last_mining_at = ?, updated_at = ? WHERE user_id = ? AND last_mining_at = ?").bind(now, now, userId, Number(state?.last_mining_at || now)),
        env.DB.prepare("UPDATE visitors SET points = points + ? WHERE user_id = ? AND changes() = 1").bind(reward, userId),
        env.DB.prepare("UPDATE users SET points = (SELECT points FROM visitors WHERE user_id = ?), updated_at = ? WHERE user_uuid = ? AND changes() = 1").bind(userId, now, userId),
        env.DB.prepare(`
          INSERT INTO point_ledger (user_uuid,delta,balance_after,reason,reference_type,reference_id,created_at)
          SELECT user_uuid,?,points,'wallet_mining','wallet_mining',?,?
          FROM users WHERE user_uuid = ?
            AND EXISTS (SELECT 1 FROM oxide_wallet_state WHERE user_id = ? AND last_mining_at = ?)
        `).bind(reward,miningReference,now,userId,userId,now)
      ]);
      if (Number(results?.[0]?.meta?.changes || 0) !== 1) return json({ success: true, ...(await walletSnapshot(env.DB, userId)) });
    } else {
      return json({ success: false, error: "INVALID_ACTION" }, 400);
    }

    return json({ success: true, ...(await walletSnapshot(env.DB, userId)) });
  } catch (error) {
    console.error("Wallet action failed:", error);
    return json({ success: false, error: "WALLET_ACTION_FAILED" }, 500);
  }
}
