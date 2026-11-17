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
    if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_WEBAPP_URL || !env.TELEGRAM_WEBHOOK_SECRET) {
      return json({ ok: false, error: "SERVER_CONFIGURATION_MISSING" }, 500);
    }
    if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.TELEGRAM_WEBHOOK_SECRET) {
      return json({ ok: false }, 403);
    }
    const update = await request.json();
    const message = update.message;
    if (!message?.chat?.id || !message?.from?.id || typeof message.text !== "string") {
      return json({ ok: true });
    }
    if (!/^\/start(?:\s|$)/.test(message.text.trim())) return json({ ok: true });
    const telegramId = String(message.from.id);
    const ownerId = String(env.TELEGRAM_ADMIN_ID || "6052062846");
    let isAdmin = telegramId === ownerId;
    if (!isAdmin && env.DB) {
      const deputy = await env.DB.prepare(
        "SELECT active FROM oxide_admin_deputies WHERE telegram_id = ? LIMIT 1"
      ).bind(telegramId).first().catch(() => null);
      isAdmin = Number(deputy?.active) === 1;
    }
    const keyboard = [[{
      text: "🚀 فتح البوت",
      web_app: { url: env.TELEGRAM_WEBAPP_URL }
    }]];
    if (isAdmin) {
      const base = env.TELEGRAM_WEBAPP_URL.replace(/\/$/, "");
      keyboard.push([{
        text: "🔐 لوحة التحكم",
        web_app: { url: base + "/admin.html" }
      }]);
    }
    await telegramCall(env.TELEGRAM_BOT_TOKEN, "sendMessage", {
      chat_id: message.chat.id,
      text: "مرحبًا بك في OXIDE HUB 🚀",
      reply_markup: { keyboard, resize_keyboard: true, is_persistent: true }
    });
    return json({ ok: true });
  } catch {
    return json({ ok: false, error: "BOT_WEBHOOK_FAILED" }, 500);
  }
}
