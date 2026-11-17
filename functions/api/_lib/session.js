const encoder = new TextEncoder();

function toHex(bytes) {
  return Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
}

async function sha256(value) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}

export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}

// The cookie contains a random opaque token. Only its SHA-256 hash is stored in D1.
export async function createSessionCookie(env, DB, userUuid) {
  if (!env.SESSION_SECRET || !DB || !userUuid) throw new Error("SESSION_CONFIGURATION_MISSING");
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const token = toHex(bytes);
  const tokenHash = toHex(await sha256(token));
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + 60 * 60 * 24 * 30;

  await DB.prepare(`
    INSERT INTO app_sessions (user_uuid, token_hash, expires_at, created_at)
    VALUES (?, ?, ?, ?)
  `).bind(userUuid, tokenHash, expiresAt, now).run();

  return `oxide_visitor=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`;
}

export async function getVisitor(request, env) {
  if (!env.DB || !env.SESSION_SECRET) return null;
  const cookie = request.headers.get("Cookie") || "";
  const match = cookie.match(/(?:^|;\\s*)oxide_visitor=([a-f0-9]{64})(?:;|$)/i);
  if (!match) return null;

  const tokenHash = toHex(await sha256(match[1]));
  const now = Math.floor(Date.now() / 1000);
  const row = await env.DB.prepare(`
    SELECT user_uuid
    FROM app_sessions
    WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?
    LIMIT 1
  `).bind(tokenHash, now).first();

  return row?.user_uuid || null;
}

// Legacy exports retained temporarily so older endpoints do not fail to import.
// New authenticated sessions must be created with createSessionCookie().
export async function createVisitorCookie() {
  throw new Error("TELEGRAM_SESSION_REQUIRED");
}

export async function createVisitorCookieForId() {
  throw new Error("TELEGRAM_SESSION_REQUIRED");
}
