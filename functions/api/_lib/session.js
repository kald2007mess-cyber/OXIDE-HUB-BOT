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

async function ensureSessionsTable(DB) {
  await DB.prepare(`
    CREATE TABLE IF NOT EXISTS app_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_uuid TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      revoked_at INTEGER
    )
  `).run();
  await DB.prepare(`
    CREATE INDEX IF NOT EXISTS idx_app_sessions_user
    ON app_sessions(user_uuid, expires_at)
  `).run();
}

// The cookie contains a random opaque token. Only its SHA-256 hash is stored in D1.
export async function createSessionCookie(env, DB, userUuid) {
  if (!env.SESSION_SECRET || !DB || !userUuid) throw new Error("SESSION_CONFIGURATION_MISSING");
  await ensureSessionsTable(DB);
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
  await ensureSessionsTable(env.DB);
  const cookie = request.headers.get("Cookie") || "";
  const match = cookie.match(/(?:^|;\s*)oxide_visitor=([a-f0-9]{64})(?:;|$)/i);
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


// Restricted sessions are accepted only by the support endpoints.
async function ensureSupportSessionsTable(DB) {
  await DB.prepare(`
    CREATE TABLE IF NOT EXISTS oxide_support_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_uuid TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      revoked_at INTEGER
    )
  `).run();
  await DB.prepare(`
    CREATE INDEX IF NOT EXISTS idx_oxide_support_sessions_user
    ON oxide_support_sessions(user_uuid, expires_at)
  `).run();
}

export async function createSupportSessionCookie(env, DB, userUuid) {
  if (!env.SESSION_SECRET || !DB || !userUuid) throw new Error("SESSION_CONFIGURATION_MISSING");
  await ensureSupportSessionsTable(DB);
  const token = toHex(crypto.getRandomValues(new Uint8Array(32)));
  const tokenHash = toHex(await sha256(token));
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + 60 * 60 * 24 * 30;
  await DB.prepare(`
    INSERT INTO oxide_support_sessions (user_uuid, token_hash, expires_at, created_at)
    VALUES (?, ?, ?, ?)
  `).bind(userUuid, tokenHash, expiresAt, now).run();
  return `oxide_support=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`;
}

export async function getSupportVisitor(request, env) {
  const normalUser = await getVisitor(request, env);
  if (normalUser) return normalUser;
  if (!env.DB || !env.SESSION_SECRET) return null;
  await ensureSupportSessionsTable(env.DB);
  const cookie = request.headers.get("Cookie") || "";
  const match = cookie.match(/(?:^|;\\s*)oxide_support=([a-f0-9]{64})(?:;|$)/i);
  if (!match) return null;
  const tokenHash = toHex(await sha256(match[1]));
  const now = Math.floor(Date.now() / 1000);
  const row = await env.DB.prepare(`
    SELECT s.user_uuid
    FROM oxide_support_sessions s
    INNER JOIN users u ON u.user_uuid = s.user_uuid
    WHERE s.token_hash = ? AND s.revoked_at IS NULL
      AND s.expires_at > ? AND u.status = 'banned'
    LIMIT 1
  `).bind(tokenHash, now).first();
  return row?.user_uuid || null;
}

export async function revokeUserSessions(DB, userUuid, now = Math.floor(Date.now() / 1000)) {
  await DB.prepare(`
    CREATE TABLE IF NOT EXISTS app_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_uuid TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      revoked_at INTEGER
    )
  `).run();
  await DB.prepare(`
    UPDATE app_sessions SET revoked_at = ?
    WHERE user_uuid = ? AND revoked_at IS NULL
  `).bind(now, userUuid).run();
}
