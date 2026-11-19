import { getVisitor, json } from "../_lib/session.js";

export async function onRequestGet({ request, env }) {
  try {
    if (!env.DB || !env.SESSION_SECRET) {
      return json({ success: false, error: "SERVER_CONFIGURATION_MISSING" }, 500);
    }

    const userId = await getVisitor(request, env);
    if (!userId) return json({ success: false, error: "NO_TELEGRAM_SESSION" }, 401);

    // Older accounts may not have triggered any wallet module yet.
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

    const result = await env.DB.prepare(`
      SELECT id, delta, balance_after, reason, reference_type, reference_id, created_at
      FROM point_ledger
      WHERE user_uuid = ?
      ORDER BY created_at DESC, id DESC
      LIMIT 50
    `).bind(userId).all();

    return json({
      success: true,
      items: (result.results || []).map(row => ({
        id: Number(row.id),
        delta: Number(row.delta || 0),
        balanceAfter: Number(row.balance_after || 0),
        reason: String(row.reason || "transaction"),
        referenceType: String(row.reference_type || ""),
        referenceId: String(row.reference_id || ""),
        createdAt: Number(row.created_at || 0)
      }))
    });
  } catch (error) {
    console.error("Wallet history load failed:", error);
    return json({ success: false, error: "WALLET_HISTORY_FAILED" }, 500);
  }
}
