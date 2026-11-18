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

    // Clear every Telegram bot-command menu scope and restore the default chat menu.
    // This removes the four-square command list without disabling /start or /admin handlers.
    for (const scope of [
      undefined,
      { type: "all_private_chats" },
      { type: "all_group_chats" },
      { type: "all_chat_administrators" }
    ]) {
      await telegramCall(env.TELEGRAM_BOT_TOKEN, "deleteMyCommands", scope ? { scope } : {});
    }
    await telegramCall(env.TELEGRAM_BOT_TOKEN, "setChatMenuButton", {
      menu_button: { type: "default" }
    });
    // Also clear any menu-button override saved specifically for this private chat.
    await telegramCall(env.TELEGRAM_BOT_TOKEN, "setChatMenuButton", {
      chat_id: message.chat.id,
      menu_button: { type: "default" }
    });

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

    // Private owner-only admin command. It is intentionally not registered in the public command menu.
    const adminMatch = message.text.trim().match(/^\/admin(?:@\w+)?$/);
    if (adminMatch) {
      if (String(message.from.id) === String(env.TELEGRAM_ADMIN_ID) &&
          String(message.chat.id) === String(env.TELEGRAM_ADMIN_ID)) {
        const adminUrl = env.TELEGRAM_WEBAPP_URL.replace(/\/$/, "") + "/admin.html";
        await telegramCall(env.TELEGRAM_BOT_TOKEN, "sendMessage", {
          chat_id: message.chat.id,
          text: "🔐 لوحة إدارة OXIDE HUB: افتح صفحة الإدارة من رابط الموقع."
        });
      }
      return json({ ok: true });
    }

    const startMatch = message.text.trim().match(/^\/start(?:@\w+)?(?:\s+([A-Za-z0-9_-]{1,64}))?$/);
    if (!startMatch) return json({ ok: true });

    // Telegram deep-link referrals are stored until the invited user opens the Mini App.
    const startPayload = String(startMatch[1] || "");
    const referralMatch = startPayload.match(/^ref_(\d{5,20})$/);
    if (referralMatch && env.DB) {
      const referrerTelegramId = referralMatch[1];
      const invitedTelegramId = String(message.from.id);
      if (referrerTelegramId !== invitedTelegramId) {
        await env.DB.prepare(`
          CREATE TABLE IF NOT EXISTS oxide_pending_referrals (
            referred_telegram_id TEXT PRIMARY KEY,
            referrer_telegram_id TEXT NOT NULL,
            created_at INTEGER NOT NULL
          )
        `).run();
        const referrer = await env.DB.prepare(
          "SELECT user_uuid FROM telegram_identities WHERE telegram_user_id = ? LIMIT 1"
        ).bind(referrerTelegramId).first();
        const invitedAlreadyRegistered = await env.DB.prepare(
          "SELECT user_uuid FROM telegram_identities WHERE telegram_user_id = ? LIMIT 1"
        ).bind(invitedTelegramId).first();
        if (referrer && !invitedAlreadyRegistered) {
          await env.DB.prepare(`
            INSERT OR IGNORE INTO oxide_pending_referrals
              (referred_telegram_id, referrer_telegram_id, created_at)
            VALUES (?, ?, ?)
          `).bind(invitedTelegramId, referrerTelegramId, Math.floor(Date.now() / 1000)).run();
        }
      }
    }

    // Remove bot command-menu entries and reset the chat menu button.
    // /start and /admin continue to work when typed manually.
    await telegramCall(env.TELEGRAM_BOT_TOKEN, "setMyCommands", { commands: [] });
    await telegramCall(env.TELEGRAM_BOT_TOKEN, "setMyCommands", {
      commands: [],
      scope: { type: "all_private_chats" }
    });
    await telegramCall(env.TELEGRAM_BOT_TOKEN, "setChatMenuButton", {
      menu_button: { type: "default" }
    });

    // Send the welcome message without any inline keyboard buttons.
    await telegramCall(env.TELEGRAM_BOT_TOKEN, "sendMessage", {
      chat_id: message.chat.id,
      text: "مرحبًا بك في OXIDE HUB 🚀\\nاكتب /start في أي وقت لعرض رسالة الترحيب."
    });
    return json({ ok: true });
  } catch {
    return json({ ok: false, error: "BOT_WEBHOOK_FAILED" }, 500);
  }
}
