import { createSessionCookie, createSupportSessionCookie, json } from "./_lib/session.js";

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
  let diagnosticStage = "START";
  try {
    if (!env.DB || !env.SESSION_SECRET || !env.TELEGRAM_BOT_TOKEN) {
      return json({ success: false, error: "SERVER_CONFIGURATION_MISSING" }, 500);
    }
    diagnosticStage = "READ_TELEGRAM_DATA";
    const body = await request.json().catch(() => ({}));
    const verified = await telegramUser(String(body.initData || ""), env.TELEGRAM_BOT_TOKEN);
    if (!verified) return json({ success: false, error: "INVALID_TELEGRAM_INIT_DATA" }, 403);

    const { telegramId, user } = verified;
    const userUuid = await stableUserUuid(telegramId);
    const now = Math.floor(Date.now() / 1000);
    const initialPublicId = "OX-" + userUuid.replace(/-/g, "").slice(0, 8).toUpperCase();

    diagnosticStage = "CREATE_TELEGRAM_IDENTITIES";
    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS telegram_identities (
        telegram_user_id TEXT PRIMARY KEY,
        user_uuid TEXT NOT NULL UNIQUE REFERENCES users(user_uuid),
        created_at INTEGER NOT NULL
      )
    `).run();

    diagnosticStage = "CREATE_USER";
    const createdUser = await env.DB.prepare(`
      INSERT OR IGNORE INTO users
        (user_uuid, public_id, points, status, created_at, updated_at)
      VALUES (?, ?, 0, 'active', ?, ?)
    `).bind(userUuid, initialPublicId, now, now).run();

    diagnosticStage = "READ_USER";
    const userRow = await env.DB.prepare(
      "SELECT user_uuid, status FROM users WHERE user_uuid = ? LIMIT 1"
    ).bind(userUuid).first();

    // Keep legacy app modules (referrals, support, progress and mission reviews)
    // attached to the same authenticated Telegram UUID.
    diagnosticStage = "CREATE_VISITOR_TABLE";
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
    diagnosticStage = "MIGRATE_POINTS";
    if (Number(createdUser.meta?.changes || 0) === 1) {
      await env.DB.prepare(`
        UPDATE users SET points = COALESCE(
          (SELECT points FROM visitors WHERE user_id = ?), 0
        ), updated_at = ?
        WHERE user_uuid = ?
      `).bind(userUuid, now, userUuid).run();
    }

    diagnosticStage = "READ_ACCOUNT_POINTS";
    const account = await env.DB.prepare(
      "SELECT points FROM users WHERE user_uuid = ?"
    ).bind(userUuid).first();

    diagnosticStage = "CREATE_VISITOR";
    await env.DB.prepare(`
      INSERT OR IGNORE INTO visitors
        (user_id, progress, points, cycle_started_at, created_at)
      VALUES (?, 0, ?, ?, ?)
    `).bind(userUuid, Number(account?.points || 0), now, now).run();

    diagnosticStage = "LINK_TELEGRAM_IDENTITY";
    await env.DB.prepare(`
      INSERT OR IGNORE INTO telegram_identities (telegram_user_id, user_uuid, created_at)
      VALUES (?, ?, ?)
    `).bind(telegramId, userUuid, now).run();

    diagnosticStage = "VERIFY_TELEGRAM_IDENTITY";
    const identity = await env.DB.prepare(
      "SELECT user_uuid FROM telegram_identities WHERE telegram_user_id = ? LIMIT 1"
    ).bind(telegramId).first();

    if (!identity || identity.user_uuid !== userUuid) {
      return json({ success: false, error: "TELEGRAM_IDENTITY_CONFLICT" }, 409);
    }

    // Record a privacy-preserving risk signal; raw IP addresses are never stored.
    const clientIp = request.headers.get("CF-Connecting-IP") || "";
    const ipDigest = clientIp
      ? toHex(new Uint8Array(await crypto.subtle.digest(
          "SHA-256", encoder.encode(env.SESSION_SECRET + ":" + clientIp)
        )))
      : "";
    diagnosticStage = "CREATE_SECURITY_SIGNALS";
    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS oxide_security_signals (
        user_uuid TEXT PRIMARY KEY,
        ip_hash TEXT NOT NULL DEFAULT '',
        updated_at INTEGER NOT NULL
      )
    `).run();
    if (ipDigest) {
      diagnosticStage = "SAVE_SECURITY_SIGNAL";
    await env.DB.prepare(`
        INSERT INTO oxide_security_signals(user_uuid,ip_hash,updated_at)
        VALUES(?,?,?)
        ON CONFLICT(user_uuid) DO UPDATE SET
          ip_hash=excluded.ip_hash, updated_at=excluded.updated_at
      `).bind(userUuid, ipDigest, now).run();
    }

    // Enforce the configured rule: the third distinct Telegram account on one IP
    // bans every account associated with that IP. Only a keyed digest is stored.
    diagnosticStage = "CREATE_IP_ACCOUNT_TABLE";
    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS oxide_ip_accounts (
        ip_hash TEXT NOT NULL,
        user_uuid TEXT NOT NULL,
        telegram_user_id TEXT NOT NULL,
        first_seen_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        PRIMARY KEY (ip_hash, user_uuid)
      )
    `).run();
    await env.DB.prepare(`
      CREATE INDEX IF NOT EXISTS idx_oxide_ip_accounts_hash
      ON oxide_ip_accounts(ip_hash)
    `).run();
    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS oxide_ip_bans (
        ip_hash TEXT PRIMARY KEY,
        reason TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )
    `).run();

    if (ipDigest) {
      diagnosticStage = "SAVE_IP_ACCOUNT";
      await env.DB.prepare(`
        INSERT INTO oxide_ip_accounts
          (ip_hash, user_uuid, telegram_user_id, first_seen_at, last_seen_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(ip_hash, user_uuid) DO UPDATE SET
          telegram_user_id = excluded.telegram_user_id,
          last_seen_at = excluded.last_seen_at
      `).bind(ipDigest, userUuid, telegramId, now, now).run();
    }

    // A shared IP is only a risk signal, never proof that accounts are fraudulent.
    // Recover accounts previously auto-banned by the old three-accounts-per-IP rule.
    diagnosticStage = "RECOVER_SHARED_IP_FALSE_POSITIVE";
    const recoveredAccount = await env.DB.prepare(`
      UPDATE users SET status = 'active', updated_at = ?
      WHERE user_uuid = ? AND status = 'banned'
        AND EXISTS (
          SELECT 1
          FROM oxide_ip_accounts a
          INNER JOIN oxide_ip_bans b ON b.ip_hash = a.ip_hash
          WHERE a.user_uuid = users.user_uuid
            AND b.reason = 'three_accounts_same_ip'
        )
    `).bind(now, userUuid).run();
    if (Number(recoveredAccount.meta?.changes || 0) === 1) {
      userRow.status = "active";
    }

    if (userRow?.status === "banned") {
      diagnosticStage = "CREATE_SUPPORT_COOKIE";
    const supportCookie = await createSupportSessionCookie(env, env.DB, userUuid);
      const blocked = json({
        success: false,
        blocked: true,
        error: "IP_BANNED",
        reason: "تم حظر الحساب بسبب تسجيل ثلاثة حسابات مختلفة من عنوان IP نفسه. يمكنك التواصل مع الدعم الفني للاعتراض."
      }, 403);
      const headers = new Headers(blocked.headers);
      headers.append("Set-Cookie", supportCookie);
      return new Response(blocked.body, { status: 403, headers });
    }

    if (!userRow || userRow.status !== "active") {
      return json({ success: false, error: "ACCOUNT_NOT_ACTIVE" }, 403);
    }

    // A Telegram deep-link attribution is recorded first; rewards wait for a genuinely
    // approved mission. Shared IPs are a review signal, not proof of fraud.
    diagnosticStage = "CREATE_PENDING_REFERRALS";
    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS oxide_pending_referrals (
        referred_telegram_id TEXT PRIMARY KEY,
        referrer_telegram_id TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )
    `).run();
    diagnosticStage = "CREATE_REFERRALS_TABLE";
    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS referrals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        referrer_id TEXT NOT NULL,
        referred_id TEXT NOT NULL UNIQUE,
        points_awarded INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        risk_score INTEGER NOT NULL DEFAULT 0,
        risk_reason TEXT NOT NULL DEFAULT ''
      )
    `).run();
    diagnosticStage = "CHECK_REFERRAL_COLUMNS";
    const referralColumns = await env.DB.prepare("PRAGMA table_info(referrals)").all();
    const knownReferralColumns = new Set((referralColumns.results || []).map(column => column.name));
    // Migrate the legacy UUID column names without dropping or rebuilding referral data.
    if (!knownReferralColumns.has("referrer_id")) {
      await env.DB.prepare("ALTER TABLE referrals ADD COLUMN referrer_id TEXT").run();
      knownReferralColumns.add("referrer_id");
    }
    if (!knownReferralColumns.has("referred_id")) {
      await env.DB.prepare("ALTER TABLE referrals ADD COLUMN referred_id TEXT").run();
      knownReferralColumns.add("referred_id");
    }
    if (!knownReferralColumns.has("status")) {
      await env.DB.prepare("ALTER TABLE referrals ADD COLUMN status TEXT NOT NULL DEFAULT 'pending'").run();
    }
    if (!knownReferralColumns.has("risk_score")) {
      await env.DB.prepare("ALTER TABLE referrals ADD COLUMN risk_score INTEGER NOT NULL DEFAULT 0").run();
    }
    if (!knownReferralColumns.has("risk_reason")) {
      await env.DB.prepare("ALTER TABLE referrals ADD COLUMN risk_reason TEXT NOT NULL DEFAULT ''").run();
    }
    if (knownReferralColumns.has("referrer_uuid")) {
      await env.DB.prepare("UPDATE referrals SET referrer_id = referrer_uuid WHERE referrer_id IS NULL OR referrer_id = ''").run();
    }
    if (knownReferralColumns.has("referred_uuid")) {
      await env.DB.prepare("UPDATE referrals SET referred_id = referred_uuid WHERE referred_id IS NULL OR referred_id = ''").run();
    }
    await env.DB.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_referrals_referred_id ON referrals(referred_id)").run();
    await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_referrals_referrer_id ON referrals(referrer_id)").run();
    // Existing referrals with an awarded balance were already paid by the legacy flow.
    diagnosticStage = "MIGRATE_REFERRAL_STATUS";
    await env.DB.prepare(`
      UPDATE referrals SET status = 'rewarded'
      WHERE points_awarded > 0 AND status = 'pending'
    `).run();

    diagnosticStage = "READ_PENDING_REFERRAL";
    const pendingReferral = await env.DB.prepare(
      "SELECT referrer_telegram_id FROM oxide_pending_referrals WHERE referred_telegram_id = ? LIMIT 1"
    ).bind(telegramId).first();
    if (pendingReferral) {
      diagnosticStage = "READ_REFERRER";
    const referrerIdentity = await env.DB.prepare(
        "SELECT user_uuid FROM telegram_identities WHERE telegram_user_id = ? LIMIT 1"
      ).bind(String(pendingReferral.referrer_telegram_id)).first();
      if (referrerIdentity && referrerIdentity.user_uuid !== userUuid) {
        diagnosticStage = "CHECK_EXISTING_REFERRAL";
    const existingReferral = await env.DB.prepare(
          "SELECT id FROM referrals WHERE referred_id = ? LIMIT 1"
        ).bind(userUuid).first();
        if (!existingReferral) {
          let riskScore = 0;
          const reasons = [];
          if (ipDigest) {
            diagnosticStage = "READ_REFERRER_SIGNAL";
    const referrerSignal = await env.DB.prepare(
              "SELECT ip_hash FROM oxide_security_signals WHERE user_uuid = ? LIMIT 1"
            ).bind(referrerIdentity.user_uuid).first();
            if (referrerSignal?.ip_hash && referrerSignal.ip_hash === ipDigest) {
              riskScore += 70;
              reasons.push("same_ip_as_referrer");
            }
            diagnosticStage = "COUNT_REFERRAL_IP_ACCOUNTS";
    const sameIpAccounts = await env.DB.prepare(`
              SELECT COUNT(*) AS total FROM oxide_security_signals
              WHERE ip_hash = ? AND updated_at >= ?
            `).bind(ipDigest, now - 30 * 86400).first();
            if (Number(sameIpAccounts?.total || 0) >= 3) {
              riskScore += 30;
              reasons.push("multiple_accounts_same_ip");
            }
          }
          const riskStatus = riskScore >= 70 ? "review" : "pending";
          diagnosticStage = "SAVE_REFERRAL";
    const referralInsertColumns = ["referrer_id", "referred_id", "points_awarded", "created_at", "status", "risk_score", "risk_reason"];
          const referralInsertValues = [referrerIdentity.user_uuid, userUuid, 0, now, riskStatus, riskScore, reasons.join(",")];
          // Legacy tables retain NOT NULL UUID columns, so populate both naming schemes when present.
          if (knownReferralColumns.has("referrer_uuid")) {
            referralInsertColumns.push("referrer_uuid");
            referralInsertValues.push(referrerIdentity.user_uuid);
          }
          if (knownReferralColumns.has("referred_uuid")) {
            referralInsertColumns.push("referred_uuid");
            referralInsertValues.push(userUuid);
          }
          const referralPlaceholders = referralInsertColumns.map(() => "?").join(",");
          await env.DB.prepare(`
            INSERT OR IGNORE INTO referrals (${referralInsertColumns.join(",")})
            VALUES(${referralPlaceholders})
          `).bind(...referralInsertValues).run();
        }
      }
      diagnosticStage = "DELETE_PENDING_REFERRAL";
    await env.DB.prepare(
        "DELETE FROM oxide_pending_referrals WHERE referred_telegram_id = ?"
      ).bind(telegramId).run();
    }

    // Persist the Telegram profile and a stable, collision-free public OX ID.
    const publicId = "OX-" + telegramId;
    diagnosticStage = "UPDATE_PUBLIC_ID";
    await env.DB.prepare("UPDATE users SET public_id = ?, updated_at = ? WHERE user_uuid = ?")
      .bind(publicId, now, userUuid).run();
    diagnosticStage = "CREATE_PROFILE_TABLE";
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
    diagnosticStage = "SAVE_PROFILE";
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

    diagnosticStage = "RECORD_USER_ACTIVITY";
    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS oxide_user_activity (
        user_uuid TEXT PRIMARY KEY,
        telegram_user_id TEXT NOT NULL,
        first_seen_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        visit_count INTEGER NOT NULL DEFAULT 1
      )
    `).run();
    await env.DB.prepare(`
      INSERT INTO oxide_user_activity
        (user_uuid, telegram_user_id, first_seen_at, last_seen_at, visit_count)
      VALUES (?, ?, ?, ?, 1)
      ON CONFLICT(user_uuid) DO UPDATE SET
        telegram_user_id = excluded.telegram_user_id,
        last_seen_at = excluded.last_seen_at,
        visit_count = oxide_user_activity.visit_count + 1
    `).bind(userUuid, telegramId, now, now).run();

    // Notify the owner on every successful Mini App entry, for both new and returning users.
    // Notification failures must never prevent the user's session from being created.
    diagnosticStage = "NOTIFY_ADMIN_OF_USER_ENTRY";
    try {
      const [latestAccount, visitorProgress] = await Promise.all([
        env.DB.prepare(
          "SELECT points, public_id FROM users WHERE user_uuid = ? LIMIT 1"
        ).bind(userUuid).first(),
        env.DB.prepare(
          "SELECT progress FROM visitors WHERE user_id = ? LIMIT 1"
        ).bind(userUuid).first()
      ]);
      const isNewUser = Number(createdUser.meta?.changes || 0) === 1;
      const displayName = [user.first_name, user.last_name]
        .filter(Boolean).join(" ").slice(0, 180) || "بدون اسم";
      const displayUsername = username ? "@" + username : "غير محدد";
      const taskProgress = Math.max(0, Math.min(3, Number(visitorProgress?.progress || 0)));
      const entryTime = new Intl.DateTimeFormat("en-GB", {
        timeZone: "Africa/Algiers",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false
      }).format(new Date());
      if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_ADMIN_ID) {
        await fetch(
          `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              chat_id: env.TELEGRAM_ADMIN_ID,
              text: [
                isNewUser ? "🆕 مستخدم جديد دخل OXIDE HUB" : "🔁 مستخدم عاد إلى OXIDE HUB",
                "",
                "👤 الاسم: " + displayName,
                "🔗 المستخدم: " + displayUsername,
                "🆔 Telegram ID: " + telegramId,
                "🪪 OX: " + String(latestAccount?.public_id || publicId),
                "⭐ النقاط: " + Number(latestAccount?.points || 0),
                "📋 المهام: " + taskProgress + "/3",
                "🕒 وقت الدخول: " + entryTime
              ].join("\n"),
              disable_web_page_preview: true
            })
          }
        );
      }
    } catch (notificationError) {
      console.error("OXIDE admin entry notification failed:", notificationError);
    }

    diagnosticStage = "CREATE_SESSION_COOKIE";
    const cookie = await createSessionCookie(env, env.DB, userUuid);
    const response = json({
      success: true,
      user: { firstName: String(user.first_name || ""), username: String(user.username || "") }
    });
    const headers = new Headers(response.headers);
    headers.set("Set-Cookie", cookie);
    return new Response(response.body, { status: 200, headers });
  } catch (error) {
    console.error("OXIDE telegram session failure:", error);
    const diagnostic = `${diagnosticStage}: ${String(error?.message || error || "UNKNOWN_ERROR").slice(0, 180)}`;
    return json({ success: false, error: "TELEGRAM_SESSION_FAILED", diagnostic }, 500);
  }
}
