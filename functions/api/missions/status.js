import { getVisitor, json } from "../_lib/session.js";

async function ensureTables(DB) {
  await DB.prepare(`CREATE TABLE IF NOT EXISTS oxide_admin_missions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    platform TEXT NOT NULL DEFAULT 'general',
    target_url TEXT NOT NULL DEFAULT '',
    reward_points INTEGER NOT NULL DEFAULT 0,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL DEFAULT 0
  )`).run();
  await DB.prepare(`CREATE TABLE IF NOT EXISTS mission_submissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    mission_id INTEGER NOT NULL,
    proof_file_id TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at INTEGER NOT NULL,
    reviewed_at INTEGER
  )`).run();

  await DB.prepare(`
    INSERT INTO oxide_admin_missions
      (title,description,platform,target_url,reward_points,enabled,created_at)
    SELECT ?,?,?,?,?,1,?
    WHERE NOT EXISTS (
      SELECT 1 FROM oxide_admin_missions
      WHERE platform='telegram_join' AND target_url=?
    )
  `).bind(
    "Join OXIDE HUB Telegram Channel",
    "Join @OxideHubOfficial and verify your membership to receive 50 OXIDE points.",
    "telegram_join",
    "https://t.me/OxideHubOfficial",
    50,
    Math.floor(Date.now()/1000),
    "https://t.me/OxideHubOfficial"
  ).run();

  await DB.prepare(`
    CREATE TABLE IF NOT EXISTS telegram_channel_claims (
      user_id TEXT NOT NULL,
      mission_id INTEGER NOT NULL,
      claimed_at INTEGER NOT NULL,
      PRIMARY KEY(user_id, mission_id)
    )
  `).run();

  const submissionColumns = await DB.prepare("PRAGMA table_info(mission_submissions)").all();
  const submissionColumnNames = (submissionColumns.results || []).map(column => column.name);
  if (!submissionColumnNames.includes("user_id")) {
    await DB.prepare("ALTER TABLE mission_submissions ADD COLUMN user_id TEXT").run();
    if (submissionColumnNames.includes("user_uuid")) {
      await DB.prepare("UPDATE mission_submissions SET user_id = user_uuid WHERE user_id IS NULL OR user_id = ''").run();
    } else if (submissionColumnNames.includes("visitor_id")) {
      await DB.prepare("UPDATE mission_submissions SET user_id = visitor_id WHERE user_id IS NULL OR user_id = ''").run();
    }
  }
}

export async function onRequestGet({ request, env }) {
  let diagnosticStage = "START";
  try {
    if (!env.DB || !env.SESSION_SECRET) return json({ success:false, error:"SERVER_CONFIGURATION_MISSING" },500);
    diagnosticStage = "READ_SESSION";
    const userId = await getVisitor(request, env);
    if (!userId) return json({ success:false, error:"NO_VISITOR_SESSION" },401);
    diagnosticStage = "ENSURE_MISSION_TABLES";
    await ensureTables(env.DB);
    diagnosticStage = "READ_USER_POINTS";
    const user = await env.DB.prepare("SELECT points FROM users WHERE user_uuid = ? AND status = 'active'").bind(userId).first();
    diagnosticStage = "READ_MISSION_STATUS";
    const result = await env.DB.prepare(`
      SELECT m.id, m.title, m.description, m.platform, m.target_url,
             m.reward_points,
             CASE
               WHEN m.platform='telegram_join' AND tc.user_id IS NOT NULL THEN 'approved'
               ELSE COALESCE(s.status, 'not_submitted')
             END AS status
      FROM oxide_admin_missions m
      LEFT JOIN mission_submissions s
        ON s.mission_id = m.id AND s.user_id = ?
        AND s.id = (SELECT MAX(s2.id) FROM mission_submissions s2
                    WHERE s2.mission_id = m.id AND s2.user_id = ?)
      LEFT JOIN telegram_channel_claims tc
        ON tc.user_id = ? AND tc.mission_id = m.id
      WHERE COALESCE(m.enabled, 1) = 1
      ORDER BY m.id ASC
    `).bind(userId,userId,userId).all();
    return json({success:true,points:Number(user?.points ?? 0),missions:(result.results||[]).map(m=>({
      id:Number(m.id),title:m.title,description:m.description,platform:m.platform,
      targetUrl:m.target_url,rewardPoints:Number(m.reward_points||0),status:m.status === "rejected" ? "not_submitted" : m.status
    })),submissions:(await env.DB.prepare(`
      SELECT * FROM (
        SELECT s.id,s.mission_id AS missionId,s.status,s.created_at AS createdAt,
               s.reviewed_at AS reviewedAt,m.title
        FROM mission_submissions s
        LEFT JOIN oxide_admin_missions m ON m.id=s.mission_id
        WHERE s.user_id=?
        UNION ALL
        SELECT -tc.mission_id AS id,tc.mission_id AS missionId,'approved' AS status,
               tc.claimed_at AS createdAt,tc.claimed_at AS reviewedAt,m.title
        FROM telegram_channel_claims tc
        LEFT JOIN oxide_admin_missions m ON m.id=tc.mission_id
        WHERE tc.user_id=?
      )
      ORDER BY createdAt DESC,id DESC
      LIMIT 30
    `).bind(userId,userId).all()).results || []});
  } catch (error) {
    console.error("Mission status API error:", diagnosticStage, error);
    const diagnostic = `${diagnosticStage}: ${String(error?.message || error || "UNKNOWN_ERROR").slice(0, 180)}`;
    return json({success:false,error:"MISSION_STATUS_FAILED",diagnostic},500);
  }
}