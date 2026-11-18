import { createSessionCookie, json } from "./_lib/session.js";

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

async function telegramUser(initData, botToken) {
  if (typeof initData !== "string" || !initData || initData.length > 10000 || !botToken) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  const authDate = Number(params.get("auth_date"));
  const userText = params.get("user");
  if (!hash || !/^[a-f0-9]{64}$/i.test(hash) || !authDate || !userText) return null;
  const now = Math.floor(Date.now() / 1000);
  if (authDate > now + 60 || now - authDate > 86400) return null;
  let user;
  try { user = JSON.parse(userText); } catch { return null; }
  const telegramId = String(user?.id || "");
  if (!/^\d{5,20}$/.test(telegramId)) return null;
  params.delete("hash");
  const check = [...params.entries()].sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`).join("\n");
  const secret = await hmac(encoder.encode("WebAppData"), botToken);
  const calculated = toHex(await hmac(secret, check));
  return safeEqual(calculated, hash.toLowerCase()) ? { telegramId, user } : null;
}

async function stableUserUuid(telegramId) {
  const digest = new Uint8Array(await crypto.subtle.digest(
    "SHA-256", encoder.encode("OXIDE-HUB-TELEGRAM:" + telegramId)
  ));
  const bytes = digest.slice(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = toHex(bytes);
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}

export async function onRequestPost({ request, env }) {
  try {
    if (!env.DB || !env.SESSION_SECRET || !env.TELEGRAM_BOT_TOKEN) {
      return json({ success: false, error: "SERVER_CONFIGURATION_MISSING" }, 500);
    }
    const body = await request.json().catch(() => ({}));
    const verified = await telegramUser(String(body.initData || ""), env.TELEGRAM_BOT_TOKEN);
    if (!verified) return json({ success: false, error: "INVALID_TELEGRAM_INIT_DATA" }, 403);

    const { telegramId, user } = verified;
    const userUuid = await stableUserUuid(telegramId);
    const now = Math.floor(Date.now() / 1000);
    const publicId = "OX-" + userUuid.replace(/-/g, "").slice(0, 8).toUpperCase();

    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS telegram_identities (
        telegram_user_id TEXT PRIMARY KEY,
        user_uuid TEXT NOT NULL UNIQUE REFERENCES users(user_uuid),
        created_at INTEGER NOT NULL
      )
    `).run();

    const createdUser = await env.DB.prepare(`
      INSERT OR IGNORE INTO users
        (user_uuid, public_id, points, status, created_at, updated_at)
      VALUES (?, ?, 0, 'active', ?, ?)
    `).bind(userUuid, publicId, now, now).run();

    const userRow = await env.DB.prepare(
      "SELECT user_uuid, status FROM users WHERE user_uuid = ? LIMIT 1"
    ).bind(userUuid).first();

    if (!userRow || userRow.status !== "active") {
      return json({ success: false, error: "ACCOUNT_NOT_ACTIVE" }, 403);
    }

    // Keep legacy app modules (referrals, support, progress and mission reviews)
    // attached to the same authenticated Telegram UUID.
    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS visitors (
        user_id TEXT PRIMARY KEY,
        progress INTEGER NOT NULL DEFAULT 0,
        points INTEGER NOT NULL DEFAULT 0,
        cycle_started_at INTEGER,
        created_at INTEGER NOT NULL
      )
    `).run();

    // If this is a migrated legacy visitor, preserve the existing points
    // when creating the new Telegram account instead of resetting the balance.
    if (Number(createdUser.meta?.changes || 0) === 1) {
      await env.DB.prepare(`
        UPDATE users SET points = COALESCE(
          (SELECT points FROM visitors WHERE user_id = ?), 0
        ), updated_at = ?
        WHERE user_uuid = ?
      `).bind(userUuid, now, userUuid).run();
    }

    const account = await env.DB.prepare(
      "SELECT points FROM users WHERE user_uuid = ?"
    ).bind(userUuid).first();

    await env.DB.prepare(`
      INSERT OR IGNORE INTO visitors
        (user_id, progress, points, cycle_started_at, created_at)
      VALUES (?, 0, ?, ?, ?)
    `).bind(userUuid, Number(account?.points || 0), now, now).run();

    await env.DB.prepare(`
      INSERT OR IGNORE INTO telegram_identities (telegram_user_id, user_uuid, created_at)
      VALUES (?, ?, ?)
    `).bind(telegramId, userUuid, now).run();

    const identity = await env.DB.prepare(
      "SELECT user_uuid FROM telegram_identities WHERE telegram_user_id = ? LIMIT 1"
    ).bind(telegramId).first();

    if (!identity || identity.user_uuid !== userUuid) {
      return json({ success: false, error: "TELEGRAM_IDENTITY_CONFLICT" }, 409);
    }

    // Persist the Telegram profile and a stable, collision-free public OX ID.
    const publicId = "OX-" + telegramId;
    await env.DB.prepare("UPDATE users SET public_id = ?, updated_at = ? WHERE user_uuid = ?")
      .bind(publicId, now, userUuid).run();
    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS oxide_profiles (
        telegram_user_id TEXT PRIMARY KEY,
        user_uuid TEXT NOT NULL UNIQUE,
        public_id TEXT NOT NULL UNIQUE,
        username TEXT,
        first_name TEXT,
        last_name TEXT,
        photo_url TEXT,
        telegram_url TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `).run();
    const username = String(user.username || "").replace(/^@/, "").slice(0, 64);
    const photoUrl = typeof user.photo_url === "string" && /^https:\/\//i.test(user.photo_url)
      ? user.photo_url.slice(0, 2048) : null;
    await env.DB.prepare(`
      INSERT INTO oxide_profiles
        (telegram_user_id, user_uuid, public_id, username, first_name, last_name, photo_url, telegram_url, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(telegram_user_id) DO UPDATE SET
        username = excluded.username,
        first_name = excluded.first_name,
        last_name = excluded.last_name,
        photo_url = COALESCE(excluded.photo_url, oxide_profiles.photo_url),
        telegram_url = excluded.telegram_url,
        updated_at = excluded.updated_at
    `).bind(
      telegramId, userUuid, publicId, username,
      String(user.first_name || "").slice(0, 128),
      String(user.last_name || "").slice(0, 128),
      photoUrl, username ? "https://t.me/" + username : "tg://user?id=" + telegramId, now
    ).run();

    const cookie = await createSessionCookie(env, env.DB, userUuid);
    const response = json({
      success: true,
      user: { firstName: String(user.first_name || ""), username: String(user.username || "") }
    });
    const headers = new Headers(response.headers);
    headers.set("Set-Cookie", cookie);
    return new Response(response.body, { status: 200, headers });
  } catch {
    return json({ success: false, error: "TELEGRAM_SESSION_FAILED" }, 500);
  }
}
