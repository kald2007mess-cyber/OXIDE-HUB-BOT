// OXIDE HUB admin authorization: verified Telegram owner and active deputies.
const encoder = new TextEncoder();

function toHex(bytes) {
  return Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
}

async function hmac(keyBytes, message) {
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(message)));
}

function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function getVerifiedTelegramId(initData, env) {
  if (typeof initData !== "string" || !initData || initData.length > 10000 || !env.TELEGRAM_BOT_TOKEN) return null;
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get("hash");
    const authDate = Number(params.get("auth_date"));
    const userText = params.get("user");
    const now = Math.floor(Date.now() / 1000);
    if (!hash || !/^[a-f0-9]{64}$/i.test(hash) || !authDate || !userText || authDate > now + 60 || now - authDate > 86400) return null;
    const user = JSON.parse(userText);
    const telegramId = String(user?.id || "");
    if (!/^\d{5,20}$/.test(telegramId)) return null;
    params.delete("hash");
    const dataCheck = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k,v]) => `${k}=${v}`).join("\n");
    const secret = await hmac(encoder.encode("WebAppData"), env.TELEGRAM_BOT_TOKEN);
    const calculated = toHex(await hmac(secret, dataCheck));
    return safeEqual(calculated, hash.toLowerCase()) ? telegramId : null;
  } catch { return null; }
}

export async function authorizeAdmin(initData, env, requiredPermission = null) {
  if (!env.DB || !env.TELEGRAM_BOT_TOKEN || !env.OXIDE_OWNER_TELEGRAM_ID) {
    return { ok: false, status: 500, error: "SERVER_CONFIG" };
  }

  const telegramId = await getVerifiedTelegramId(initData, env);
  if (!telegramId) return { ok: false, status: 403, error: "UNAUTHORIZED" };

  if (telegramId === String(env.OXIDE_OWNER_TELEGRAM_ID)) {
    return {
      ok: true,
      owner: true,
      telegramId,
      permissions: ["users","news","tasks","support","android","beta","ios","maintenance","stats","security"]
    };
  }

  const deputy = await env.DB.prepare(
    "SELECT telegram_id FROM oxide_admin_deputies WHERE telegram_id = ? AND active = 1"
  ).bind(telegramId).first();

  if (!deputy) return { ok: false, status: 403, error: "UNAUTHORIZED" };

  const result = await env.DB.prepare(
    "SELECT permission FROM oxide_admin_deputy_permissions WHERE telegram_id = ?"
  ).bind(telegramId).all();

  const permissions = (result.results || []).map(row => String(row.permission));
  if (requiredPermission && !permissions.includes(String(requiredPermission))) {
    return { ok: false, status: 403, error: "PERMISSION_DENIED" };
  }

  return { ok: true, owner: false, telegramId, permissions };
}

export function adminAuthResponse(auth) {
  return new Response(JSON.stringify({ success: false, error: auth?.error || "UNAUTHORIZED" }), {
    status: auth?.status || 403,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
  });
}
