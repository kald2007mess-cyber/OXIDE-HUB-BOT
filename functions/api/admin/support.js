import { authorizeAdmin, adminAuthResponse } from "../_lib/admin-auth.js";
import { ensureSupportTables, json } from "../_lib/support.js";

async function ensureAdminSupportReads(DB) {
  await DB.prepare(`
    CREATE TABLE IF NOT EXISTS support_admin_reads (
      conversation_id INTEGER PRIMARY KEY,
      last_read_message_id INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    )
  `).run();
}

export async function onRequestPost({ request, env }) {
  try {
    if (!env.DB) return json({ success: false, error: "DATABASE_NOT_CONFIGURED" }, 500);
    const body = await request.json().catch(() => ({}));
    const auth = await authorizeAdmin(String(body.initData || ""), env, "support");
    if (!auth.ok) return adminAuthResponse(auth);

    await ensureSupportTables(env.DB);
    await ensureAdminSupportReads(env.DB);
    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS oxide_profiles (
        telegram_user_id TEXT PRIMARY KEY,
        user_uuid TEXT NOT NULL UNIQUE,
        public_id TEXT NOT NULL UNIQUE,
        username TEXT,
        first_name TEXT,
        last_name TEXT,
        photo_url TEXT,
        telegram_url TEXT NOT NULL DEFAULT '',
        updated_at INTEGER NOT NULL DEFAULT 0
      )
    `).run();

    const action = String(body.action || "");

    if (action === "list") {
      const result = await env.DB.prepare(`
        SELECT c.id AS conversation_id, c.user_id,
               COALESCE(u.public_id, p.public_id, 'OX-' || substr(replace(c.user_id, '-', ''), 1, 8)) AS display_id,
               COALESCE(p.first_name, '') AS first_name,
               COALESCE(p.last_name, '') AS last_name,
               COALESCE(p.username, '') AS username,
               CASE WHEN p.photo_url LIKE 'https://%' THEN p.photo_url ELSE '' END AS photo_url,
               c.status, c.updated_at,
               COALESCE((SELECT message_text FROM support_messages sm
                         WHERE sm.conversation_id = c.id ORDER BY sm.id DESC LIMIT 1), '') AS last_message,
               COALESCE((SELECT sender FROM support_messages sm
                         WHERE sm.conversation_id = c.id ORDER BY sm.id DESC LIMIT 1), '') AS last_sender,
               (SELECT COUNT(*) FROM support_messages sm
                WHERE sm.conversation_id = c.id AND sm.sender = 'user'
                  AND sm.id > COALESCE((SELECT last_read_message_id FROM support_admin_reads ar
                                        WHERE ar.conversation_id = c.id), 0)) AS unread_count
        FROM support_conversations c
        LEFT JOIN users u ON u.user_uuid = c.user_id
        LEFT JOIN oxide_profiles p ON p.user_uuid = c.user_id
        ORDER BY c.updated_at DESC, c.id DESC
        LIMIT 100
      `).all();
      return json({ success: true, conversations: result.results || [] });
    }

    const conversationId = Number(body.conversationId);
    if (!Number.isSafeInteger(conversationId) || conversationId < 1) {
      return json({ success: false, error: "INVALID_CONVERSATION_ID" }, 400);
    }

    const conversation = await env.DB.prepare(
      "SELECT id, user_id FROM support_conversations WHERE id = ? LIMIT 1"
    ).bind(conversationId).first();
    if (!conversation) return json({ success: false, error: "CONVERSATION_NOT_FOUND" }, 404);

    if (action === "messages") {
      const result = await env.DB.prepare(`
        SELECT id, sender, message_type, message_text, created_at
        FROM support_messages
        WHERE conversation_id = ?
        ORDER BY id ASC
        LIMIT 300
      `).bind(conversationId).all();
      const messages = result.results || [];
      const lastId = messages.reduce((max, message) => Math.max(max, Number(message.id) || 0), 0);
      await env.DB.prepare(`
        INSERT INTO support_admin_reads(conversation_id, last_read_message_id, updated_at)
        VALUES(?,?,?)
        ON CONFLICT(conversation_id) DO UPDATE SET
          last_read_message_id = MAX(support_admin_reads.last_read_message_id, excluded.last_read_message_id),
          updated_at = excluded.updated_at
      `).bind(conversationId, lastId, Math.floor(Date.now() / 1000)).run();
      return json({ success: true, conversationId, userId: conversation.user_id, messages });
    }

    if (action === "reply") {
      const message = String(body.message || "").trim();
      if (!message || message.length > 2000) {
        return json({ success: false, error: "INVALID_MESSAGE" }, 400);
      }
      const now = Math.floor(Date.now() / 1000);
      await env.DB.prepare(`
        INSERT INTO support_messages(conversation_id, sender, message_type, message_text, created_at)
        VALUES(?, 'admin', 'text', ?, ?)
      `).bind(conversationId, message, now).run();
      await env.DB.prepare(`
        UPDATE support_conversations SET updated_at = ?, status = 'open' WHERE id = ?
      `).bind(now, conversationId).run();
      return json({ success: true, message: "REPLY_SENT" });
    }

    return json({ success: false, error: "INVALID_ACTION" }, 400);
  } catch (error) {
    console.error("Admin support API error:", error);
    return json({ success: false, error: "ADMIN_SUPPORT_FAILED" }, 500);
  }
}
