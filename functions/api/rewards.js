import { getVisitor, json } from "./_lib/session.js";

const OFFERS = [
  { id: 1, name: "55 COINS", points: 1500 },
  { id: 2, name: "145 COINS", points: 3500 },
  { id: 3, name: "PREMIUM", points: 3000 },
  { id: 4, name: "25 BP COINS", points: 3500 }
];

async function ensureOrdersTable(DB) {
  await DB.prepare(`
    CREATE TABLE IF NOT EXISTS redemption_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_uuid TEXT NOT NULL REFERENCES users(user_uuid),
      public_id TEXT NOT NULL,
      offer_id INTEGER NOT NULL,
      offer_name TEXT NOT NULL,
      points_cost INTEGER NOT NULL,
      user_uuid_input TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL,
      reviewed_at INTEGER,
      telegram_message_id INTEGER
    )
  `).run();
}

export async function onRequestGet({ request, env }) {
  try {
    if (!env.DB || !env.SESSION_SECRET) return json({ success: false, error: "SERVER_CONFIGURATION_MISSING" }, 500);
    const userUuid = await getVisitor(request, env);
    if (!userUuid) return json({ success: false, error: "NO_TELEGRAM_SESSION" }, 401);
    const user = await env.DB.prepare("SELECT points FROM users WHERE user_uuid = ? AND status = 'active'").bind(userUuid).first();
    if (!user) return json({ success: false, error: "USER_NOT_FOUND" }, 404);
    return json({ success: true, points: Number(user.points), offers: OFFERS });
  } catch {
    return json({ success: false, error: "COULD_NOT_LOAD_REWARDS" }, 500);
  }
}

export async function onRequestPost({ request, env }) {
  let userUuid = null;
  let offer = null;
  let orderId = null;
  let debitDone = false;
  try {
    if (!env.DB || !env.SESSION_SECRET || !env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_ADMIN_ID) {
      return json({ success: false, error: "SERVER_CONFIGURATION_MISSING" }, 500);
    }
    userUuid = await getVisitor(request, env);
    if (!userUuid) return json({ success: false, error: "NO_TELEGRAM_SESSION" }, 401);
    const body = await request.json().catch(() => ({}));
    offer = OFFERS.find(item => item.id === Number(body.offerId));
    if (!offer) return json({ success: false, error: "INVALID_OFFER" }, 400);

    const enteredUuid = String(body.userUuid || "").trim();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(enteredUuid) ||
        enteredUuid.toLowerCase() !== userUuid.toLowerCase()) {
      return json({ success: false, error: "UUID_DOES_NOT_MATCH_ACCOUNT" }, 400);
    }

    const user = await env.DB.prepare(
      "SELECT user_uuid, public_id, points FROM users WHERE user_uuid = ? AND status = 'active'"
    ).bind(userUuid).first();
    if (!user) return json({ success: false, error: "USER_NOT_FOUND" }, 404);

    const now = Math.floor(Date.now() / 1000);
    await ensureOrdersTable(env.DB);

    const debit = await env.DB.prepare(`
      UPDATE users SET points = points - ?, updated_at = ?
      WHERE user_uuid = ? AND status = 'active' AND points >= ?
      RETURNING points
    `).bind(offer.points, now, userUuid, offer.points).first();
    if (!debit) return json({ success: false, error: "INSUFFICIENT_POINTS" }, 400);
    debitDone = true;

    await env.DB.prepare(`
      INSERT INTO point_ledger
        (user_uuid, delta, balance_after, reason, reference_type, reference_id, created_at)
      VALUES (?, ?, ?, 'redemption_request', 'redemption', 'pending', ?)
    `).bind(userUuid, -offer.points, Number(debit.points), now).run();

    const inserted = await env.DB.prepare(`
      INSERT INTO redemption_orders
        (user_uuid, public_id, offer_id, offer_name, points_cost, user_uuid_input, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)
      RETURNING id
    `).bind(userUuid, user.public_id, offer.id, offer.name, offer.points, enteredUuid, now).first();
    orderId = Number(inserted.id);

    const messageText = [
      "🎁 OXIDE HUB — طلب استبدال جديد",
      "",
      "الطلب: #" + orderId,
      "المستخدم: " + user.public_id,
      "UUID: " + enteredUuid,
      "العرض: " + offer.name,
      "التكلفة: " + offer.points.toLocaleString() + " نقطة",
      "الرصيد بعد الخصم: " + Number(debit.points).toLocaleString() + " نقطة",
      "",
      "راجع الطلب من لوحة الإدارة."
    ].join("\n");

    const tgResponse = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: env.TELEGRAM_ADMIN_ID, text: messageText })
    });
    const tg = await tgResponse.json();
    if (!tgResponse.ok || !tg.ok) throw new Error("TELEGRAM_DELIVERY_FAILED");

    await env.DB.prepare("UPDATE redemption_orders SET telegram_message_id = ? WHERE id = ?")
      .bind(Number(tg.result?.message_id || 0), orderId).run();

    return json({ success: true, orderId, points: Number(debit.points), status: "pending" });
  } catch {
    if (debitDone && userUuid && offer) {
      try {
        const now = Math.floor(Date.now() / 1000);
        const refund = await env.DB.prepare(
          "UPDATE users SET points = points + ?, updated_at = ? WHERE user_uuid = ? RETURNING points"
        ).bind(offer.points, now, userUuid).first();
        if (refund) {
          await env.DB.prepare(`
            INSERT INTO point_ledger (user_uuid, delta, balance_after, reason, reference_type, reference_id, created_at)
            VALUES (?, ?, ?, 'redemption_compensation', 'redemption', ?, ?)
          `).bind(userUuid, offer.points, Number(refund.points), String(orderId || "failed"), now).run();
        }
        if (orderId) await env.DB.prepare(
          "UPDATE redemption_orders SET status = 'failed', reviewed_at = ? WHERE id = ? AND status = 'pending'"
        ).bind(now, orderId).run();
      } catch {}
    }
    return json({ success: false, error: "REDEMPTION_REQUEST_FAILED" }, 500);
  }
}
