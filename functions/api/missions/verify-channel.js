import { getVisitor, json } from "../_lib/session.js";

const CHANNEL = "@OxideHubOfficial";
const CHANNEL_URL = "https://t.me/OxideHubOfficial";

async function ensureTables(DB) {
  await DB.prepare(`
    CREATE TABLE IF NOT EXISTS oxide_admin_missions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      platform TEXT NOT NULL DEFAULT 'general',
      target_url TEXT NOT NULL DEFAULT '',
      reward_points INTEGER NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL DEFAULT 0
    )
  `).run();
  await DB.prepare(`
    CREATE TABLE IF NOT EXISTS mission_submissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      mission_id INTEGER NOT NULL,
      proof_file_id TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL,
      reviewed_at INTEGER
    )
  `).run();
  await DB.prepare(`
    CREATE TABLE IF NOT EXISTS telegram_channel_claims (
      user_id TEXT NOT NULL,
      mission_id INTEGER NOT NULL,
      claimed_at INTEGER NOT NULL,
      PRIMARY KEY(user_id, mission_id)
    )
  `).run();
  await DB.prepare(`
    CREATE TABLE IF NOT EXISTS point_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_uuid TEXT NOT NULL,
      delta INTEGER NOT NULL,
      balance_after INTEGER NOT NULL,
      reason TEXT NOT NULL,
      reference_type TEXT NOT NULL,
      reference_id TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `).run();
}

async function telegramCall(token, method, payload) {
  const response = await fetch("https://api.telegram.org/bot" + token + "/" + method, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) {
    const description = String(data.description || "");
    const error = new Error(description || "TELEGRAM_API_ERROR");
    error.telegramDescription = description;
    throw error;
  }
  return data.result;
}

export async function onRequestPost({ request, env }) {
  let stage = "START";
  try {
    if (!env.DB || !env.SESSION_SECRET || !env.TELEGRAM_BOT_TOKEN) {
      return json({ success:false, error:"SERVER_CONFIGURATION_MISSING" },500);
    }

    stage = "READ_SESSION";
    const userId = await getVisitor(request, env);
    if (!userId) return json({ success:false, error:"NO_VISITOR_SESSION" },401);

    stage = "ENSURE_TABLES";
    await ensureTables(env.DB);

    stage = "READ_USER";
    const user = await env.DB.prepare(`
      SELECT u.user_uuid, u.points, t.telegram_user_id
      FROM users u
      JOIN telegram_identities t ON t.user_uuid = u.user_uuid
      WHERE u.user_uuid = ? AND u.status = 'active'
      LIMIT 1
    `).bind(userId).first();
    if (!user?.telegram_user_id) {
      return json({ success:false, error:"TELEGRAM_IDENTITY_NOT_FOUND" },404);
    }

    stage = "READ_MISSION";
    const mission = await env.DB.prepare(`
      SELECT id, reward_points FROM oxide_admin_missions
      WHERE platform='telegram_join' AND target_url=? AND enabled=1
      ORDER BY id ASC LIMIT 1
    `).bind(CHANNEL_URL).first();
    if (!mission) return json({ success:false, error:"MISSION_NOT_AVAILABLE" },404);
    const reward = Math.max(0, Math.floor(Number(mission.reward_points) || 0));
    if (reward <= 0) {
      return json({ success:false, error:"MISSION_REWARD_NOT_CONFIGURED" },409);
    }

    stage = "CHECK_EXISTING_CLAIM";
    const existing = await env.DB.prepare(`
      SELECT 1 FROM telegram_channel_claims WHERE user_id=? AND mission_id=? LIMIT 1
    `).bind(userId, mission.id).first();
    if (existing) {
      return json({ success:true, alreadyCompleted:true, points:Number(user.points||0), rewardPoints:reward });
    }

    stage = "VERIFY_TELEGRAM_MEMBERSHIP";
    let member;
    try {
      member = await telegramCall(env.TELEGRAM_BOT_TOKEN,"getChatMember",{
        chat_id:CHANNEL,
        user_id:Number(user.telegram_user_id)
      });
    } catch (error) {
      const description = String(error.telegramDescription || "");
      if (/chat not found|not enough rights|administrator rights/i.test(description)) {
        return json({success:false,error:"BOT_NOT_ADMIN_OR_CHANNEL_UNAVAILABLE"},403);
      }
      console.error("Telegram membership check failed:",description || error);
      return json({success:false,error:"TELEGRAM_CHECK_FAILED"},502);
    }

    const status = String(member?.status || "");
    const isMember = status === "creator" || status === "administrator" ||
      status === "member" || (status === "restricted" && member?.is_member === true);
    if (!isMember) {
      return json({success:false,error:"CHANNEL_NOT_JOINED"},403);
    }

    stage = "CLAIM_REWARD";
    const now = Math.floor(Date.now()/1000);

    // telegram_channel_claims is the authoritative record for this Telegram join reward.
    // Do not write mission_submissions here: its mission_id references the separate missions table,
    // while this mission is stored in oxide_admin_missions.


    const claimResults = await env.DB.batch([
      env.DB.prepare(`
        INSERT OR IGNORE INTO telegram_channel_claims(user_id,mission_id,claimed_at)
        VALUES(?,?,?)
      `).bind(userId,mission.id,now),
      env.DB.prepare(`
        UPDATE users SET points=points+?, updated_at=?
        WHERE user_uuid=? AND status='active' AND changes()=1
      `).bind(reward,now,userId),
      env.DB.prepare(`
        INSERT INTO point_ledger
          (user_uuid,delta,balance_after,reason,reference_type,reference_id,created_at)
        SELECT user_uuid,?,points,'telegram_channel_join','telegram_channel',?,?
        FROM users WHERE user_uuid=? AND changes()=1
      `).bind(reward,String(mission.id),now,userId),
      env.DB.prepare(`
        UPDATE visitors SET points=(SELECT points FROM users WHERE user_uuid=?)
        WHERE user_id=? AND EXISTS (
          SELECT 1 FROM telegram_channel_claims WHERE user_id=? AND mission_id=?
        )
      `).bind(userId,userId,userId,mission.id)
    ]);

    const claimed = Number(claimResults[0]?.meta?.changes || 0) === 1;
    const credited = Number(claimResults[1]?.meta?.changes || 0) === 1;
    if (!claimed) {
      const latest = await env.DB.prepare("SELECT points FROM users WHERE user_uuid=?").bind(userId).first();
      return json({success:true,alreadyCompleted:true,points:Number(latest?.points||0),rewardPoints:reward});
    }
    if (!credited) {
      await env.DB.prepare("DELETE FROM telegram_channel_claims WHERE user_id=? AND mission_id=?")
        .bind(userId,mission.id).run();
      return json({success:false,error:"REWARD_CREDIT_FAILED"},500);
    }

    const updated = await env.DB.prepare("SELECT points FROM users WHERE user_uuid=?").bind(userId).first();
    return json({
      success:true,
      alreadyCompleted:false,
      rewardPoints:reward,
      points:Number(updated?.points||0)
    });
  } catch (error) {
    console.error("Telegram channel mission error:",stage,error);
    const detail = String(error?.message || error || "UNKNOWN_ERROR").slice(0, 220);
    return json({success:false,error:"CHANNEL_MISSION_FAILED",diagnostic:stage + ": " + detail},500);
  }
}
