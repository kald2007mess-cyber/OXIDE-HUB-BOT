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
}

export async function onRequestGet({ request, env }) {
  try {
    if (!env.DB || !env.SESSION_SECRET) return json({ success:false, error:"SERVER_CONFIGURATION_MISSING" },500);
    const userId = await getVisitor(request, env);
    if (!userId) return json({ success:false, error:"NO_VISITOR_SESSION" },401);
    await ensureTables(env.DB);
    const user = await env.DB.prepare("SELECT points FROM users WHERE user_uuid = ? AND status = 'active'").bind(userId).first();
    const result = await env.DB.prepare(`
      SELECT m.id, m.title, m.description, m.platform, m.target_url,
             m.reward_points,
             COALESCE(s.status, 'not_submitted') AS status
      FROM oxide_admin_missions m
      LEFT JOIN mission_submissions s
        ON s.mission_id = m.id AND s.user_id = ?
        AND s.id = (SELECT MAX(s2.id) FROM mission_submissions s2
                    WHERE s2.mission_id = m.id AND s2.user_id = ?)
      WHERE COALESCE(m.enabled, 1) = 1
      ORDER BY m.id ASC
    `).bind(userId,userId).all();
    return json({success:true,points:Number(user?.points ?? 0),missions:(result.results||[]).map(m=>({
      id:Number(m.id),title:m.title,description:m.description,platform:m.platform,
      targetUrl:m.target_url,rewardPoints:Number(m.reward_points||0),status:m.status
    }))});
  } catch (error) {
    console.error("Mission status API error:", error);
    return json({success:false,error:"MISSION_STATUS_FAILED"},500);
  }
}