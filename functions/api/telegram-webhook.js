import { ensureSupportTables } from "./_lib/support.js";

function getBotLanguage(languageCode) {
  const code = String(languageCode || "").toLowerCase();
  if (code.startsWith("ru")) return "ru";
  if (code.startsWith("en")) return "en";
  return "ar";
}

const botTexts = {
  ar: {
    adminTitle: "🔐 لوحة إدارة OXIDE HUB",
    adminBody: "اضغط على الزر لفتح لوحة التحكم داخل تيليجرام.",
    adminButton: "فتح لوحة الإدارة 🔐",
    adminCommand: "لوحة الإدارة",
    welcome: "🚀 مرحبًا بك في OXIDE HUB!\n💎 أنجز المهام، اجمع العملات، وادعُ أصدقاءك لتربح المزيد!\n🔥 رحلتك نحو المكافآت تبدأ الآن!",
    open: "فتح OXIDE HUB"
  },
  en: {
    adminTitle: "🔐 OXIDE HUB Admin Panel",
    adminBody: "Tap the button to open the control panel inside Telegram.",
    adminButton: "Open Admin Panel 🔐",
    adminCommand: "Admin panel",
    welcome: "🚀 Welcome to OXIDE HUB!\n💎 Complete tasks, collect coins, and invite friends to earn more!\n🔥 Your rewards journey starts now!",
    open: "Open OXIDE HUB"
  },
  ru: {
    adminTitle: "🔐 Панель администратора OXIDE HUB",
    adminBody: "Нажмите кнопку, чтобы открыть панель управления в Telegram.",
    adminButton: "Открыть панель 🔐",
    adminCommand: "Панель администратора",
    welcome: "🚀 Добро пожаловать в OXIDE HUB!\n💎 Выполняйте задания, собирайте монеты и приглашайте друзей, чтобы зарабатывать больше!\n🔥 Ваш путь к наградам начинается сейчас!",
    open: "Открыть OXIDE HUB"
  }
};

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
    if (!message?.chat?.id || !message?.from?.id) return json({ ok: true });
    const messageText = typeof message.text === "string" ? message.text.trim() : "";
    const messageCaption = typeof message.caption === "string" ? message.caption.trim() : "";

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

    const isOwnerPrivateChat = String(message.from.id) === String(env.TELEGRAM_ADMIN_ID) &&
      String(message.chat.type) === "private" &&
      String(message.chat.id) === String(env.TELEGRAM_ADMIN_ID);

    // Owner-only channel publishing wizard: /post, then send a photo/video with caption.
    if (isOwnerPrivateChat && (/^\\/post(?:@\\w+)?$/.test(messageText) || messageText === "ارسل منشور" || messageText === "أرسل منشور")) {
      if (!env.DB) {
        await telegramCall(env.TELEGRAM_BOT_TOKEN, "sendMessage", { chat_id: message.chat.id, text: "تعذر بدء النشر: قاعدة البيانات غير متاحة حالياً." });
        return json({ ok: true });
      }
      await env.DB.prepare(`CREATE TABLE IF NOT EXISTS oxide_channel_post_drafts (
        owner_telegram_id TEXT PRIMARY KEY,
        requested_at INTEGER NOT NULL
      )`).run();
      await env.DB.prepare("INSERT OR REPLACE INTO oxide_channel_post_drafts(owner_telegram_id,requested_at) VALUES(?,?)")
        .bind(String(message.from.id), Math.floor(Date.now() / 1000)).run();
      await telegramCall(env.TELEGRAM_BOT_TOKEN, "sendMessage", {
        chat_id: message.chat.id,
        text: "📢 أرسل الآن صورة أو فيديو مع النص المرافق له (Caption)، وسيُنشر تلقائياً في قناة @OxideHubOfficial.\n\nأرسل /cancel لإلغاء العملية."
      });
      return json({ ok: true });
    }

    if (isOwnerPrivateChat && /^\\/cancel(?:@\\w+)?$/.test(messageText)) {
      if (env.DB) await env.DB.prepare("DELETE FROM oxide_channel_post_drafts WHERE owner_telegram_id=?")
        .bind(String(message.from.id)).run().catch(() => {});
      await telegramCall(env.TELEGRAM_BOT_TOKEN, "sendMessage", {
        chat_id: message.chat.id,
        text: "تم إلغاء تجهيز المنشور."
      });
      return json({ ok: true });
    }

    if (isOwnerPrivateChat && env.DB) {
      await env.DB.prepare(`CREATE TABLE IF NOT EXISTS oxide_channel_post_drafts (
        owner_telegram_id TEXT PRIMARY KEY,
        requested_at INTEGER NOT NULL
      )`).run();
      const draft = await env.DB.prepare("SELECT requested_at FROM oxide_channel_post_drafts WHERE owner_telegram_id=?")
        .bind(String(message.from.id)).first();
      if (draft) {
        const age = Math.floor(Date.now() / 1000) - Number(draft.requested_at || 0);
        if (age > 600) {
          await env.DB.prepare("DELETE FROM oxide_channel_post_drafts WHERE owner_telegram_id=?")
            .bind(String(message.from.id)).run();
          await telegramCall(env.TELEGRAM_BOT_TOKEN, "sendMessage", {
            chat_id: message.chat.id,
            text: "انتهت مهلة تجهيز المنشور. أرسل /post للبدء من جديد."
          });
          return json({ ok: true });
        }
        const photo = Array.isArray(message.photo) && message.photo.length ? message.photo[message.photo.length - 1] : null;
        const video = message.video || null;
        const caption = messageCaption.slice(0, 1024);
        if (photo || video) {
          const mediaType = photo ? "sendPhoto" : "sendVideo";
          const media = photo ? photo.file_id : video.file_id;
          await telegramCall(env.TELEGRAM_BOT_TOKEN, mediaType, {
            chat_id: "@OxideHubOfficial",
            [photo ? "photo" : "video"]: media,
            caption: caption || undefined
          });
          await env.DB.prepare("DELETE FROM oxide_channel_post_drafts WHERE owner_telegram_id=?")
            .bind(String(message.from.id)).run();
          await telegramCall(env.TELEGRAM_BOT_TOKEN, "sendMessage", {
            chat_id: message.chat.id,
            text: "✅ تم نشر المنشور بنجاح في قناة @OxideHubOfficial."
          });
          return json({ ok: true, channelPostPublished: true });
        }
        await telegramCall(env.TELEGRAM_BOT_TOKEN, "sendMessage", {
          chat_id: message.chat.id,
          text: "أرسل صورة أو فيديو مع كتابة النص في خانة الوصف (Caption). أو أرسل /cancel للإلغاء."
        });
        return json({ ok: true });
      }
    }

    const language = getBotLanguage(message.from.language_code);
    const words = botTexts[language];

    // Private owner-only admin command. Open the admin panel inside Telegram's Web App.
    const adminMatch = messageText.match(/^\/admin(?:@\w+)?$/);
    if (adminMatch) {
      if (String(message.from.id) === String(env.TELEGRAM_ADMIN_ID) &&
          String(message.chat.id) === String(env.TELEGRAM_ADMIN_ID)) {
        const adminUrl = env.TELEGRAM_WEBAPP_URL.replace(/\/$/, "") + "/admin.html";
        await telegramCall(env.TELEGRAM_BOT_TOKEN, "sendMessage", {
          chat_id: message.chat.id,
          text: words.adminTitle + "\n" + words.adminBody,
          reply_markup: {
            inline_keyboard: [[{
              text: words.adminButton,
              web_app: { url: adminUrl }
            }]]
          }
        });
      }
      return json({ ok: true });
    }

    // Owner-only command to publish the official OXIDE HUB explainer post to the channel.
    const publishMatch = messageText.match(/^\/publish_oxide(?:@\w+)?$/);
    if (publishMatch) {
      if (String(message.from.id) === String(env.TELEGRAM_ADMIN_ID) &&
          String(message.chat.type) === "private" &&
          String(message.chat.id) === String(env.TELEGRAM_ADMIN_ID)) {
        const postText = [
          "🌌 كيف تعمل منصة OXIDE HUB؟",
          "",
          "منصة OXIDE HUB تمنح المستخدمين فرصة جمع النقاط من خلال أنشطة ومهام متنوعة.",
          "",
          "⭐ داخل المنصة ستجد:",
          "",
          "- المهام والأنشطة.",
          "- نظام الإحالات.",
          "- محفظة النقاط.",
          "- مكافآت اختيارية مقابل مشاهدة الإعلانات.",
          "",
          "💜 هدفنا تقديم تجربة واضحة وشفافة، مع توضيح شروط المكافآت والسحب للمستخدمين.",
          "",
          "📢 تابعوا قناتنا لمعرفة آخر التحديثات.",
          "",
          "🔗https://t.me/OxideHubOfficial",
          "",
          "OXIDE HUB TEAM 🚀"
        ].join("\n");
        await telegramCall(env.TELEGRAM_BOT_TOKEN, "sendMessage", {
          chat_id: "@OxideHubOfficial",
          text: postText,
          reply_markup: {
            inline_keyboard: [[{
              text: "🚀 Open OXIDE HUB",
              url: "https://t.me/OxideHub_bot"
            }]]
          },
          disable_web_page_preview: true
        });
        await telegramCall(env.TELEGRAM_BOT_TOKEN, "sendMessage", {
          chat_id: message.chat.id,
          text: "✅ تم إرسال المنشور إلى قناة @OxideHubOfficial مع زر فتح البوت."
        });
      }
      return json({ ok: true });
    }

    const startMatch = messageText.match(/^\/start(?:@\w+)?(?:\s+([A-Za-z0-9_-]{1,64}))?$/);
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

    // Show the admin command in Telegram; access remains restricted to the owner.
    const botCommands = [{ command: "admin", description: words.adminCommand }];
    await telegramCall(env.TELEGRAM_BOT_TOKEN, "setMyCommands", { commands: botCommands });
    await telegramCall(env.TELEGRAM_BOT_TOKEN, "setMyCommands", {
      commands: botCommands,
      scope: { type: "all_private_chats" }
    });
    await telegramCall(env.TELEGRAM_BOT_TOKEN, "setChatMenuButton", {
      menu_button: { type: "default" }
    });

    // Send the OXIDE HUB welcome message without inline keyboard buttons.
    await telegramCall(env.TELEGRAM_BOT_TOKEN, "sendMessage", {
      chat_id: message.chat.id,
      text: words.welcome,
      reply_markup: {
        inline_keyboard: [[{
          text: words.open,
          web_app: { url: env.TELEGRAM_WEBAPP_URL }
        }]]
      }
    });
    return json({ ok: true });
  } catch {
    return json({ ok: false, error: "BOT_WEBHOOK_FAILED" }, 500);
  }
}
