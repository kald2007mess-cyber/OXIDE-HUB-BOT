import { onRequestPost as createTelegramSession } from "./telegram-session.js";
import { json } from "./_lib/session.js";

const encoder = new TextEncoder();

function toHex(bytes) {
  return Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
}

async function hmac(keyBytes, message) {
  const key = await crypto.subtle.importKey(
    "raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(message)));
}

function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function onRequestPost({ request, env }) {
  try {
    if (!env.DB || !env.SESSION_SECRET || !env.TELEGRAM_BOT_TOKEN) {
      return json({ success: false, error: "SERVER_CONFIGURATION_MISSING" }, 500);
    }

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return json({ success: false, error: "INVALID_LOGIN_DATA" }, 400);
    }

    const allowed = new Set(["id", "first_name", "last_name", "username", "photo_url", "auth_date"]);
    const fields = {};
    for (const [key, value] of Object.entries(body)) {
      if (key === "hash") continue;
      if (!allowed.has(key) || !["string", "number"].includes(typeof value)) {
        return json({ success: false, error: "INVALID_LOGIN_DATA" }, 400);
      }
      fields[key] = String(value);
    }

    const hash = String(body.hash || "").toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(hash) || !/^\d{5,20}$/.test(fields.id || "") ||
        !/^\d+$/.test(fields.auth_date || "")) {
      return json({ success: false, error: "INVALID_LOGIN_DATA" }, 400);
    }

    const authDate = Number(fields.auth_date);
    const now = Math.floor(Date.now() / 1000);
    if (!Number.isSafeInteger(authDate) || authDate > now + 60 || now - authDate > 86400) {
      return json({ success: false, error: "LOGIN_DATA_EXPIRED" }, 403);
    }

    const dataCheckString = Object.keys(fields).sort()
      .map(key => key + "=" + fields[key]).join("\n");
    const widgetSecret = new Uint8Array(await crypto.subtle.digest(
      "SHA-256", encoder.encode(env.TELEGRAM_BOT_TOKEN)
    ));
    const expectedHash = toHex(await hmac(widgetSecret, dataCheckString));
    if (!safeEqual(expectedHash, hash)) {
      return json({ success: false, error: "INVALID_TELEGRAM_SIGNATURE" }, 403);
    }

    // Convert the verified Login Widget identity into a server-generated,
    // valid Web App initData payload so the existing account/session flow
    // remains the single source of truth for users, referrals and rewards.
    const user = {
      id: Number(fields.id),
      first_name: fields.first_name || "",
      last_name: fields.last_name || "",
      username: fields.username || "",
      photo_url: fields.photo_url || ""
    };
    const initParams = new URLSearchParams();
    initParams.set("auth_date", fields.auth_date);
    initParams.set("user", JSON.stringify(user));
    const webAppSecret = await hmac(encoder.encode("WebAppData"), env.TELEGRAM_BOT_TOKEN);
    const webAppCheck = [...initParams.entries()].sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => key + "=" + value).join("\n");
    initParams.set("hash", toHex(await hmac(webAppSecret, webAppCheck)));

    const headers = new Headers({ "Content-Type": "application/json" });
    const clientIp = request.headers.get("CF-Connecting-IP");
    if (clientIp) headers.set("CF-Connecting-IP", clientIp);
    const internalRequest = new Request(new URL("/api/telegram-session", request.url), {
      method: "POST",
      headers,
      body: JSON.stringify({ initData: initParams.toString() })
    });
    return await createTelegramSession({ request: internalRequest, env });
  } catch (error) {
    console.error("OXIDE browser login failure:", error);
    return json({ success: false, error: "BROWSER_LOGIN_FAILED" }, 500);
  }
}
