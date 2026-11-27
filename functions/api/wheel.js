import { getVisitor, json } from "./_lib/session.js";

const MAX_ADS = 10;
const SECTORS = [0, 10, 20, 10, 5, 30, 10, 50, 20, 100];

async function ensureWheelTables(DB) {
  await DB.prepare("CREATE TABLE IF NOT EXISTS oxide_wheel_ad_progress (user_id TEXT PRIMARY KEY, completed_ads INTEGER NOT NULL DEFAULT 0, used_ads INTEGER NOT NULL DEFAULT 0)").run();
  const cols = await DB.prepare("PRAGMA table_info(oxide_wheel_ad_progress)").all();
  if (!(cols.results || []).some(c => c.name === "used_ads")) {
    await DB.prepare("ALTER TABLE oxide_wheel_ad_progress ADD COLUMN used_ads INTEGER NOT NULL DEFAULT 0").run();
  }
  await DB.prepare("CREATE TABLE IF NOT EXISTS oxide_wheel_state (user_id TEXT PRIMARY KEY, free_next_at INTEGER NOT NULL DEFAULT 0, free_used INTEGER NOT NULL DEFAULT 0)").run();
  await DB.prepare("CREATE TABLE IF NOT EXISTS oxide_wheel_wallet (user_id TEXT PRIMARY KEY,balance INTEGER NOT NULL DEFAULT 0,updated_at INTEGER NOT NULL DEFAULT 0)").run();
  await DB.prepare("CREATE TABLE IF NOT EXISTS oxide_wheel_ledger (id INTEGER PRIMARY KEY AUTOINCREMENT,user_id TEXT NOT NULL,delta INTEGER NOT NULL,reason TEXT NOT NULL,reference_id TEXT NOT NULL,created_at INTEGER NOT NULL)").run();
  const stateCols = await DB.prepare("PRAGMA table_info(oxide_wheel_state)").all();
  if (!(stateCols.results || []).some(c => c.name === "free_used")) await DB.prepare("ALTER TABLE oxide_wheel_state ADD COLUMN free_used INTEGER NOT NULL DEFAULT 0").run();
  await DB.prepare("CREATE TABLE IF NOT EXISTS oxide_wheel_migrations (migration_key TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)").run();
  const reset = await DB.prepare("SELECT migration_key FROM oxide_wheel_migrations WHERE migration_key='wheel_reset_all_users_v2'").first();
  if (!reset) {
    await DB.batch([
      DB.prepare("DELETE FROM oxide_wheel_ad_pending"),
      DB.prepare("DELETE FROM oxide_wheel_ad_progress"),
      DB.prepare("DELETE FROM oxide_wheel_state"),
      DB.prepare("INSERT OR IGNORE INTO oxide_wheel_migrations(migration_key,applied_at) VALUES('wheel_reset_all_users_v2',?)").bind(Math.floor(Date.now()/1000))
    ]);
  }
  await DB.prepare("CREATE TABLE IF NOT EXISTS point_ledger (id INTEGER PRIMARY KEY AUTOINCREMENT,user_uuid TEXT NOT NULL,delta REAL NOT NULL,balance_after REAL NOT NULL,reason TEXT NOT NULL,reference_type TEXT NOT NULL,reference_id TEXT NOT NULL,created_at INTEGER NOT NULL)").run();
}

function weightedPrize(options) {
  const total = options.reduce((sum, item) => sum + item.weight, 0);
  let roll = Math.random() * total;
  for (const item of options) {
    roll -= item.weight;
    if (roll < 0) return item.value;
  }
  return options[options.length - 1].value;
}

function chooseSector(prize) {
  const matches = SECTORS.map((value, index) => value === prize ? index : -1).filter(index => index >= 0);
  return matches[Math.floor(Math.random() * matches.length)];
}

async function readWheelState(DB, userId, now) {
  await DB.prepare("INSERT OR IGNORE INTO oxide_wheel_state(user_id,free_next_at,free_used) VALUES(?,0,0)").bind(userId).run();
  await DB.prepare("INSERT OR IGNORE INTO oxide_wheel_ad_progress(user_id,completed_ads,used_ads) VALUES(?,0,0)").bind(userId).run();
  await DB.prepare("INSERT OR IGNORE INTO oxide_wheel_wallet(user_id,balance,updated_at) VALUES(?,0,?)").bind(userId, now).run();
  const [state, ads, wallet] = await Promise.all([
    DB.prepare("SELECT free_next_at,free_used FROM oxide_wheel_state WHERE user_id=?").bind(userId).first(),
    DB.prepare("SELECT completed_ads,used_ads FROM oxide_wheel_ad_progress WHERE user_id=?").bind(userId).first(),
    DB.prepare("SELECT balance FROM oxide_wheel_wallet WHERE user_id=?").bind(userId).first()
  ]);
  const completedAds = Math.min(MAX_ADS, Math.max(0, Number(ads?.completed_ads || 0)));
  const usedAds = Math.min(completedAds, Math.max(0, Number(ads?.used_ads || 0)));
  return {
    freeNextAt: Math.max(0, Number(state?.free_next_at || 0)),
    freeAvailable: Number(state?.free_next_at || 0) <= now,
    wheelBalance: Math.max(0, Number(wallet?.balance || 0)),
    wheelAds: completedAds,
    adSpinsAvailable: Math.max(0, completedAds - usedAds),
    serverTime: now
  };
}

async function notifyAdminSpin(env, DB, userId, details, now) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_ADMIN_ID) return;
  try {
    const profile = await DB.prepare(`
      SELECT p.telegram_user_id,p.username,p.first_name,p.last_name,p.public_id,u.points,w.balance AS wheel_balance
      FROM users u LEFT JOIN oxide_profiles p ON p.user_uuid=u.user_uuid
      LEFT JOIN oxide_wheel_wallet w ON w.user_id=u.user_uuid
      WHERE u.user_uuid=? LIMIT 1
    `).bind(userId).first();
    const ads = await DB.prepare("SELECT completed_ads FROM oxide_wheel_ad_progress WHERE user_id=?").bind(userId).first();
    const time = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Africa/Algiers", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false
    }).format(new Date(now * 1000));
    const name = [profile?.first_name, profile?.last_name].filter(Boolean).join(" ") || "بدون اسم";
    const message = [
      "🎡 تدويرة جديدة — OXIDE HUB",
      "",
      "👤 الاسم: " + name,
      "🔗 المستخدم: " + (profile?.username ? "@" + profile.username : "غير محدد"),
      "🪪 OX: " + String(profile?.public_id || userId),
      "🆔 Telegram ID: " + String(profile?.telegram_user_id || "غير متوفر"),
      "📺 إعلانات العجلة المشاهدة: " + Number(ads?.completed_ads || 0) + "/" + MAX_ADS,
      "🎟️ نوع المحاولة: " + (details.mode === "free" ? "مجانية" : "من إعلان"),
      "🎁 الجائزة: +" + details.prize + " نقطة",
      "🪙 رصيد العجلة بعد الإضافة: " + Number(profile?.wheel_balance || 0),
      "🕒 الوقت: " + time
    ].join("\n");
    const response = await fetch("https://api.telegram.org/bot" + env.TELEGRAM_BOT_TOKEN + "/sendMessage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: env.TELEGRAM_ADMIN_ID, text: message, disable_web_page_preview: true })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) console.error("OXIDE wheel spin notification failed:", data.description || response.status);
  } catch (error) {
    console.error("OXIDE wheel spin notification failed:", error);
  }
}

export async function onRequestGet({ request, env }) {
  try {
    if (!env.DB || !env.SESSION_SECRET) return json({ success: false, error: "SERVER_CONFIGURATION_MISSING" }, 500);
    const userId = await getVisitor(request, env);
    if (!userId) return json({ success: false, error: "NO_TELEGRAM_SESSION" }, 401);
    await ensureWheelTables(env.DB);
    const now = Math.floor(Date.now() / 1000);
    return json({ success: true, ...(await readWheelState(env.DB, userId, now)) });
  } catch (error) {
    console.error("OXIDE wheel state failed:", error);
    return json({ success: false, error: "WHEEL_STATE_FAILED" }, 500);
  }
}

export async function onRequestPost({ request, env }) {
  try {
    if (!env.DB || !env.SESSION_SECRET) return json({ success: false, error: "SERVER_CONFIGURATION_MISSING" }, 500);
    const userId = await getVisitor(request, env);
    if (!userId) return json({ success: false, error: "NO_TELEGRAM_SESSION" }, 401);
    await ensureWheelTables(env.DB);
    const now = Math.floor(Date.now() / 1000);
    const body = await request.json().catch(() => ({}));
    const current = await readWheelState(env.DB, userId, now);

    if (body.action === "withdraw") {
      const amount = body.max === true ? current.wheelBalance : Math.floor(Number(body.amount) || 0);
      if (amount < 500) return json({ success: false, error: "MINIMUM_WITHDRAWAL", minimum: 500, ...current }, 400);
      if (amount > current.wheelBalance) return json({ success: false, error: "INSUFFICIENT_WHEEL_BALANCE", ...current }, 400);
      const reference = crypto.randomUUID();
      const results = await env.DB.batch([
        env.DB.prepare("UPDATE oxide_wheel_wallet SET balance=balance-?,updated_at=? WHERE user_id=? AND balance=? AND balance>=? AND EXISTS (SELECT 1 FROM users WHERE user_uuid=? AND status='active')").bind(amount, now, userId, current.wheelBalance, amount, userId),
        env.DB.prepare("UPDATE users SET points=points+?,updated_at=? WHERE user_uuid=? AND status='active' AND changes()=1").bind(amount, now, userId),
        env.DB.prepare("INSERT INTO point_ledger(user_uuid,delta,balance_after,reason,reference_type,reference_id,created_at) SELECT user_uuid,?,points,'wheel_withdrawal','wheel_withdrawal',?,? FROM users WHERE user_uuid=? AND changes()=1").bind(amount, reference, now, userId)
      ]);
      if (Number(results?.[0]?.meta?.changes || 0) !== 1 || Number(results?.[1]?.meta?.changes || 0) !== 1 || Number(results?.[2]?.meta?.changes || 0) !== 1) {
        return json({ success: false, error: "WITHDRAW_CONFLICT" }, 409);
      }
      const balance = await env.DB.prepare("SELECT points FROM users WHERE user_uuid=?").bind(userId).first();
      await env.DB.prepare("UPDATE visitors SET points=? WHERE user_id=?").bind(Number(balance?.points || 0), userId).run();
      const state = await readWheelState(env.DB, userId, now);
      return json({ success: true, withdrawn: amount, points: Number(balance?.points || 0), ...state });
    }

    const mode = current.freeAvailable ? "free" : "ad";
    if (mode === "ad" && current.adSpinsAvailable <= 0) {
      return json({ success: false, error: "NO_SPINS_AVAILABLE", ...current }, 409);
    }

    const options = mode === "free"
      ? [{ value: 0, weight: 20 }, { value: 5, weight: 15 }, { value: 10, weight: 45 }, { value: 20, weight: 20 }]
      : [{ value: 0, weight: 18 }, { value: 5, weight: 12 }, { value: 10, weight: 40 }, { value: 20, weight: 22 }, { value: 30, weight: 8 }];
    const prize = weightedPrize(options);
    const sector = chooseSector(prize);
    const reference = crypto.randomUUID();
    const claim = mode === "free"
      ? env.DB.prepare("UPDATE oxide_wheel_state SET free_next_at=?,free_used=0 WHERE user_id=? AND free_next_at<=?").bind(now+86400, userId, now)
      : env.DB.prepare("UPDATE oxide_wheel_ad_progress SET used_ads=used_ads+1 WHERE user_id=? AND completed_ads>used_ads").bind(userId);
    const results = await env.DB.batch([
      claim,
      env.DB.prepare("UPDATE oxide_wheel_wallet SET balance=balance+?,updated_at=? WHERE user_id=? AND changes()=1").bind(prize, now, userId),
      env.DB.prepare("INSERT INTO oxide_wheel_ledger(user_id,delta,reason,reference_id,created_at) SELECT user_id,?,'wheel_spin_reward',?,? FROM oxide_wheel_wallet WHERE user_id=? AND changes()=1").bind(prize, reference, now, userId)
    ]);
    if (Number(results?.[0]?.meta?.changes || 0) !== 1 ||
        Number(results?.[1]?.meta?.changes || 0) !== 1 ||
        Number(results?.[2]?.meta?.changes || 0) !== 1) {
      return json({ success: false, error: "SPIN_CONFLICT" }, 409);
    }
    const balance = await env.DB.prepare("SELECT points FROM users WHERE user_uuid=?").bind(userId).first();
    const state = await readWheelState(env.DB, userId, now);
    const details = { mode, prize, sector, wheelBalance: state.wheelBalance };
    await notifyAdminSpin(env, env.DB, userId, details, now);
    return json({ success: true, ...details, points: Number(balance?.points || 0), ...state });
  } catch (error) {
    console.error("OXIDE wheel spin failed:", error);
    return json({ success: false, error: "WHEEL_SPIN_FAILED" }, 500);
  }
}
