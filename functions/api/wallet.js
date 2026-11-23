import { getVisitor, json } from "./_lib/session.js";

const TAP_RATES = [0, 0.01, 0.02, 0.03, 0.05, 0.08, 0.12];
const STORAGE_CAPS = [0, 1000, 1500, 2000];
const ENERGY_CAPACITIES = [0, 500, 1000, 1500, 2000, 3000];
const ENERGY_UPGRADE_COSTS = [0, 100, 300, 750, 1500];
const MINING_RATES = [0, 0.001, 0.01, 0.05];
const UPGRADE_COSTS = {
  tap: [0, 100, 300, 750, 1500, 3000],
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
      energy_level INTEGER NOT NULL DEFAULT 1,
      energy INTEGER NOT NULL DEFAULT 500,
      max_energy INTEGER NOT NULL DEFAULT 500,
      energy_updated_at_ms INTEGER NOT NULL DEFAULT 0,
      last_mining_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `).run();
  const walletColumns = await DB.prepare("PRAGMA table_info(oxide_wallet_state)").all();
  const walletColumnNames = new Set((walletColumns.results || []).map(column => column.name));
  if (!walletColumnNames.has("energy_level")) await DB.prepare("ALTER TABLE oxide_wallet_state ADD COLUMN energy_level INTEGER NOT NULL DEFAULT 1").run();
  if (!walletColumnNames.has("energy")) await DB.prepare("ALTER TABLE oxide_wallet_state ADD COLUMN energy INTEGER NOT NULL DEFAULT 500").run();
  if (!walletColumnNames.has("max_energy")) await DB.prepare("ALTER TABLE oxide_wallet_state ADD COLUMN max_energy INTEGER NOT NULL DEFAULT 500").run();
  if (!walletColumnNames.has("energy_updated_at_ms")) await DB.prepare("ALTER TABLE oxide_wallet_state ADD COLUMN energy_updated_at_ms INTEGER NOT NULL DEFAULT 0").run();
  await DB.prepare("UPDATE oxide_wallet_state SET energy_updated_at_ms = ? WHERE energy_updated_at_ms = 0").bind(now * 1000).run();
  await DB.prepare(`
    INSERT OR IGNORE INTO oxide_wallet_state
      (user_id, taps, tap_level, storage_level, mining_level, last_mining_at, updated_at)
    VALUES (?, 0, 1, 1, 1, ?, ?)
  `).bind(userId, now, now).run();
}

// users.points is the canonical balance. visitors.points is mirrored only
// for older screens and ranking queries that still read the legacy table.
async function syncLegacyPoints(DB, userId, now) {
  await DB.prepare(`
    INSERT INTO visitors (user_id, progress, points, cycle_started_at, created_at)
    SELECT user_uuid, 0, points, ?, ?
    FROM users WHERE user_uuid = ?
    ON CONFLICT(user_id) DO UPDATE SET points = excluded.points
  `).bind(now, now, userId).run();
}


async function refreshEnergy(DB, userId, nowMs = Date.now()) {
  const state = await DB.prepare("SELECT energy, max_energy, energy_updated_at_ms FROM oxide_wallet_state WHERE user_id = ? LIMIT 1").bind(userId).first();
  if (!state) return;
  const maxEnergy = Math.max(1, Number(state.max_energy || 500));
  let energy = Math.max(0, Math.min(maxEnergy, Number(state.energy ?? maxEnergy)));
  let updatedAtMs = Number(state.energy_updated_at_ms || nowMs);
  const regenMs = 7200000 / maxEnergy;
  if (energy >= maxEnergy) {
    energy = maxEnergy;
    updatedAtMs = nowMs;
  } else {
    const gained = Math.floor(Math.max(0, nowMs - updatedAtMs) / regenMs);
    if (gained > 0) {
      energy = Math.min(maxEnergy, energy + gained);
      updatedAtMs = energy >= maxEnergy ? nowMs : updatedAtMs + gained * regenMs;
    }
  }
  if (energy !== Number(state.energy) || updatedAtMs !== Number(state.energy_updated_at_ms)) {
    await DB.prepare("UPDATE oxide_wallet_state SET energy = ?, energy_updated_at_ms = ? WHERE user_id = ?")
      .bind(energy, updatedAtMs, userId).run();
  }
}

async function walletSnapshot(DB, userId) {
  const [account, state] = await Promise.all([
    DB.prepare("SELECT points FROM users WHERE user_uuid = ? AND status = 'active' LIMIT 1").bind(userId).first(),
    DB.prepare("SELECT taps, tap_level, storage_level, mining_level, energy_level, energy, max_energy, energy_updated_at_ms FROM oxide_wallet_state WHERE user_id = ? LIMIT 1").bind(userId).first()
  ]);
  return {
    points: Number(account?.points || 0),
    taps: Number(state?.taps || 0),
    levels: {
      tap: Number(state?.tap_level || 1),
      storage: Number(state?.storage_level || 1),
      mining: Number(state?.mining_level || 1),
      energy: Number(state?.energy_level || 1)
    },
    energy: Number(state?.energy ?? 500),
    maxEnergy: Number(state?.max_energy || 500),
    energyUpdatedAtMs: Number(state?.energy_updated_at_ms || Date.now()),
    energyRegenMs: 7200000 / Math.max(1, Number(state?.max_energy || 500)),
    serverTimeMs: Date.now()
  };
}

export async function onRequestGet({ request, env }) {
  try {
    if (!env.DB || !env.SESSION_SECRET) return json({ success: false, error: "SERVER_CONFIGURATION_MISSING" }, 500);
    const userId = await getVisitor(request, env);
    if (!userId) return json({ success: false, error: "NO_TELEGRAM_SESSION" }, 401);
    const now = Math.floor(Date.now() / 1000);
    await ensureWallet(env.DB, userId, now);
    await refreshEnergy(env.DB, userId);
    await syncLegacyPoints(env.DB, userId, now);
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
    await refreshEnergy(env.DB, userId);

    if (action === "tap") {
      const state = await env.DB.prepare("SELECT taps, tap_level, energy, max_energy, energy_updated_at_ms FROM oxide_wallet_state WHERE user_id = ?").bind(userId).first();
      const energyNow = Number(state?.energy ?? 0);
      const maxEnergy = Math.max(1, Number(state?.max_energy || 500));
      if (energyNow < 1) {
        return json({ success: false, error: "ENERGY_EMPTY", energy: energyNow, maxEnergy, energyUpdatedAtMs: Number(state?.energy_updated_at_ms || Date.now()), serverTimeMs: Date.now() }, 409);
      }
      const level = Math.max(1, Math.min(6, Number(state?.tap_level || 1)));
      const reward = TAP_RATES[level] || 0.01;
      const expectedEnergyTime = Number(state?.energy_updated_at_ms || Date.now());
      const reference = crypto.randomUUID();
      const results = await env.DB.batch([
        env.DB.prepare(`
          UPDATE oxide_wallet_state
          SET taps = taps + 1, energy = energy - 1, updated_at = ?
          WHERE user_id = ? AND energy = ? AND energy_updated_at_ms = ?
            AND EXISTS (SELECT 1 FROM users WHERE user_uuid = ? AND status = 'active')
        `).bind(now, userId, energyNow, expectedEnergyTime, userId),
        env.DB.prepare(`
          UPDATE users SET points = points + ?, updated_at = ?
          WHERE user_uuid = ? AND status = 'active' AND changes() = 1
        `).bind(reward, now, userId),
        env.DB.prepare(`
          INSERT INTO point_ledger
            (user_uuid,delta,balance_after,reason,reference_type,reference_id,created_at)
          SELECT user_uuid,?,points,'wallet_tap','wallet_tap',?,?
          FROM users WHERE user_uuid = ? AND changes() = 1
        `).bind(reward, reference, now, userId)
      ]);
      if (Number(results?.[0]?.meta?.changes || 0) !== 1 ||
          Number(results?.[1]?.meta?.changes || 0) !== 1 ||
          Number(results?.[2]?.meta?.changes || 0) !== 1) {
        const latest = await walletSnapshot(env.DB, userId);
        return json({ success: false, error: "ENERGY_EMPTY", ...latest }, 409);
      }
      await syncLegacyPoints(env.DB, userId, now);

    } else if (action === "upgrade") {
      const kind = String(body.kind || "");
      if (kind === "energy") {
        const state = await env.DB.prepare("SELECT energy_level, energy, max_energy FROM oxide_wallet_state WHERE user_id = ?").bind(userId).first();
        const level = Math.max(1, Number(state?.energy_level || 1));
        if (level >= 5) return json({ success: false, error: "MAX_LEVEL" }, 409);
        const cost = ENERGY_UPGRADE_COSTS[level];
        const nextCapacity = ENERGY_CAPACITIES[level + 1];
        const currentCapacity = Math.max(500, Number(state?.max_energy || 500));
        const reference = crypto.randomUUID();
        const nowMs = Date.now();
        const results = await env.DB.batch([
          env.DB.prepare(`
            UPDATE oxide_wallet_state
            SET energy_level = energy_level + 1,
                max_energy = ?,
                energy = MIN(?, energy + ?),
                energy_updated_at_ms = ?,
                updated_at = ?
            WHERE user_id = ? AND energy_level = ?
              AND EXISTS (SELECT 1 FROM users WHERE user_uuid = ? AND status = 'active' AND points >= ?)
          `).bind(nextCapacity, nextCapacity, Math.max(0, nextCapacity - currentCapacity), nowMs, now, userId, level, userId, cost),
          env.DB.prepare(`
            UPDATE users SET points = points - ?, updated_at = ?
            WHERE user_uuid = ? AND status = 'active' AND points >= ? AND changes() = 1
          `).bind(cost, now, userId, cost),
          env.DB.prepare(`
            INSERT INTO point_ledger
              (user_uuid,delta,balance_after,reason,reference_type,reference_id,created_at)
            SELECT user_uuid,?,points,'wallet_upgrade','wallet_upgrade',?,?
            FROM users WHERE user_uuid = ? AND changes() = 1
          `).bind(-cost, reference, now, userId)
        ]);
        if (Number(results?.[0]?.meta?.changes || 0) !== 1 ||
            Number(results?.[1]?.meta?.changes || 0) !== 1 ||
            Number(results?.[2]?.meta?.changes || 0) !== 1) {
          return json({ success: false, error: "INSUFFICIENT_BALANCE_OR_CONFLICT" }, 409);
        }
        await syncLegacyPoints(env.DB, userId, now);
      } else {
        if (!Object.hasOwn(UPGRADE_COSTS, kind)) return json({ success: false, error: "INVALID_UPGRADE" }, 400);
        const state = await env.DB.prepare("SELECT tap_level, storage_level, mining_level FROM oxide_wallet_state WHERE user_id = ?").bind(userId).first();
        const level = Number(state?.[kind + "_level"] || 1);
        const maxLevel = kind === "tap" ? 6 : 3;
        if (level >= maxLevel) return json({ success: false, error: "MAX_LEVEL" }, 409);
        const cost = UPGRADE_COSTS[kind][level];
      const reference = crypto.randomUUID();
      const results = await env.DB.batch([
        env.DB.prepare(`
          UPDATE oxide_wallet_state
          SET ${kind}_level = ${kind}_level + 1, updated_at = ?
          WHERE user_id = ? AND ${kind}_level = ?
            AND EXISTS (SELECT 1 FROM users WHERE user_uuid = ? AND status = 'active' AND points >= ?)
        `).bind(now, userId, level, userId, cost),
        env.DB.prepare(`
          UPDATE users SET points = points - ?, updated_at = ?
          WHERE user_uuid = ? AND status = 'active' AND points >= ? AND changes() = 1
        `).bind(cost, now, userId, cost),
        env.DB.prepare(`
          INSERT INTO point_ledger
            (user_uuid,delta,balance_after,reason,reference_type,reference_id,created_at)
          SELECT user_uuid,?,points,'wallet_upgrade','wallet_upgrade',?,?
          FROM users WHERE user_uuid = ? AND changes() = 1
        `).bind(-cost, reference, now, userId)
      ]);
      if (Number(results?.[0]?.meta?.changes || 0) !== 1 ||
          Number(results?.[1]?.meta?.changes || 0) !== 1 ||
          Number(results?.[2]?.meta?.changes || 0) !== 1) {
        return json({ success: false, error: "INSUFFICIENT_BALANCE_OR_CONFLICT" }, 409);
      }
      await syncLegacyPoints(env.DB, userId, now);
      }

    } else if (action === "claim_mining") {
      const state = await env.DB.prepare("SELECT mining_level, last_mining_at FROM oxide_wallet_state WHERE user_id = ?").bind(userId).first();
      const level = Number(state?.mining_level || 1);
      const previousMiningAt = Number(state?.last_mining_at || now);
      const elapsed = Math.max(0, Math.min(3600, now - previousMiningAt));
      const reward = Math.round(elapsed * MINING_RATES[level] * 1000) / 1000;
      const reference = crypto.randomUUID();
      const results = await env.DB.batch([
        env.DB.prepare(`
          UPDATE oxide_wallet_state SET last_mining_at = ?, updated_at = ?
          WHERE user_id = ? AND last_mining_at = ?
            AND EXISTS (SELECT 1 FROM users WHERE user_uuid = ? AND status = 'active')
        `).bind(now, now, userId, previousMiningAt, userId),
        env.DB.prepare(`
          UPDATE users SET points = points + ?, updated_at = ?
          WHERE user_uuid = ? AND status = 'active' AND changes() = 1
        `).bind(reward, now, userId),
        env.DB.prepare(`
          INSERT INTO point_ledger
            (user_uuid,delta,balance_after,reason,reference_type,reference_id,created_at)
          SELECT user_uuid,?,points,'wallet_mining','wallet_mining',?,?
          FROM users WHERE user_uuid = ? AND changes() = 1
        `).bind(reward, reference, now, userId)
      ]);
      if (Number(results?.[0]?.meta?.changes || 0) !== 1 ||
          Number(results?.[1]?.meta?.changes || 0) !== 1 ||
          Number(results?.[2]?.meta?.changes || 0) !== 1) {
        return json({ success: true, ...(await walletSnapshot(env.DB, userId)) });
      }
      await syncLegacyPoints(env.DB, userId, now);

    } else {
      return json({ success: false, error: "INVALID_ACTION" }, 400);
    }

    return json({ success: true, ...(await walletSnapshot(env.DB, userId)) });
  } catch (error) {
    console.error("Wallet action failed:", error);
    return json({ success: false, error: "WALLET_ACTION_FAILED" }, 500);
  }
}
