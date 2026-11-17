import { ensureSupportTables } from "./_lib/support.js";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
  });
}

async function telegramCall(token, method, payload) {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const data = await response.json();
  if (!response.ok || !data.ok) throw new Error("TELEGRAM_API_ERROR");
  return data.result;
}

export async function onRequestPost({ request, env }) {
  try {
    if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_WEBAPP_URL || !env.TELEGRAM_WEBHOOK_SECRET || !env.TELEGRAM_ADMIN_ID) {
      return json({ ok: false, error: "SERVER_CONFIGURATION_MISSING" }, 500);
    }
    if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.TELEGRAM_WEBHOOK_SECRET) {
      return json({ ok: false }, 403);
    }
    const update = await request.json();
    const message = update.message;
    if (!message?.chat?.id || !message?.from?.id || typeof message.text !== "string") return json({ ok: true });

    // An administrator can reply directly to the support notification in Telegram.
    // The reply is stored in the same conversation and appears in the user's support tab.
    if (message.reply_to_message &&
        String(message.chat.id) === String(env.TELEGRAM_ADMIN_ID) &&
        env.DB) {
      await ensureSupportTables(env.DB);
      const original = await env.DB.prepare(`
        SELECT id, conversation_id
        FROM support_messages
        WHERE telegram_chat_id = ? AND telegram_message_id = ? AND sender = 'user'
        LIMIT 1
      `).bind(String(message.chat.id), Number(message.reply_to_message.message_id)).first();

      if (original) {
        const now = Math.floor(Date.now() / 1000);
        const replyText = String(message.text || "").trim().slice(0, 2000);
        if (replyText) {
          await env.DB.prepare(`
            INSERT INTO support_messages
              (conversation_id, sender, message_type, message_text, created_at)
            VALUES (?, 'admin', 'text', ?, ?)
          `).bind(original.conversation_id, replyText, now).run();
          await env.DB.prepare(`
            UPDATE support_conversations
            SET updated_at = ?, status = 'open'
            WHERE id = ?
          `).bind(now, original.conversation_id).run();
        }
        return json({ ok: true, supportReplySaved: Boolean(replyText) });
      }
    }

    if (!/^\/start(?:\s|$)/.test(message.text.trim())) return json({ ok: true });

    const isOwner = String(message.from.id) === String(env.TELEGRAM_ADMIN_ID);
    await telegramCall(env.TELEGRAM_BOT_TOKEN, "sendMessage", {
      chat_id: message.chat.id,
      text: "مرحبًا بك في OXIDE HUB 🚀",
      reply_markup: { remove_keyboard: true }
    });
    if (isOwner) {
      const base = env.TELEGRAM_WEBAPP_URL.replace(/\/$/, "");
      await telegramCall(env.TELEGRAM_BOT_TOKEN, "sendMessage", {
        chat_id: message.chat.id,
        text: "إدارة التطبيق",
        reply_markup: {
          inline_keyboard: [[{
            text: "🔐 لوحة التحكم",
            web_app: { url: base + "/admin.html" }
          }]]
        }
      });
    }
    return json({ ok: true });
  } catch {
    return json({ ok: false, error: "BOT_WEBHOOK_FAILED" }, 500);
  }
}
