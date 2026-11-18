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

export async function onRequestPost({ request, env }) {
  try {
    if (!env.DB || !env.SESSION_SECRET || !env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_ADMIN_ID)
      return json({success:false,error:"SERVER_CONFIGURATION_MISSING"},500);
    const userId = await getVisitor(request,env);
    if (!userId) return json({success:false,error:"NO_VISITOR_SESSION"},401);
    const form = await request.formData();
    const missionId = Number(form.get("missionId"));
    const proof = form.get("proof");
    if (!Number.isSafeInteger(missionId) || missionId < 1)
      return json({success:false,error:"INVALID_MISSION_ID"},400);
    if (!proof || typeof proof.stream !== "function" || !String(proof.type||"").startsWith("image/") || proof.size <= 0 || proof.size > 8*1024*1024)
      return json({success:false,error:"INVALID_IMAGE"},400);
    await ensureTables(env.DB);
    const mission = await env.DB.prepare("SELECT id,title FROM oxide_admin_missions WHERE id = ? AND COALESCE(enabled,1)=1").bind(missionId).first();
    if (!mission) return json({success:false,error:"MISSION_NOT_AVAILABLE"},404);
    const previous = await env.DB.prepare("SELECT status FROM mission_submissions WHERE user_id=? AND mission_id=? ORDER BY id DESC LIMIT 1").bind(userId,missionId).first();
    if (previous?.status === "approved") return json({success:false,error:"MISSION_ALREADY_COMPLETED"},409);
    if (previous?.status === "pending") return json({success:false,error:"ALREADY_PENDING"},409);

    const photo = new FormData();
    photo.set("chat_id",String(env.TELEGRAM_ADMIN_ID));
    photo.set("photo",proof,proof.name||"mission-proof.jpg");
    photo.set("caption",`📥 OXIDE HUB — Mission proof\nUser: OX-${userId.replace(/-/g,"").slice(0,8).toUpperCase()}\nMission: #${missionId} — ${mission.title}`);
    const tgResponse = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendPhoto`,{method:"POST",body:photo});
    const tg = await tgResponse.json();
    if(!tgResponse.ok || !tg.ok) return json({success:false,error:"TELEGRAM_DELIVERY_FAILED"},502);
    const photos = tg.result?.photo || [];
    const fileId = photos[photos.length-1]?.file_id;
    if(!fileId) return json({success:false,error:"TELEGRAM_DELIVERY_FAILED"},502);
    const now = Math.floor(Date.now()/1000);
    await env.DB.prepare("INSERT INTO mission_submissions(user_id,mission_id,proof_file_id,status,created_at) VALUES(?,?,?,'pending',?)")
      .bind(userId,missionId,fileId,now).run();
    return json({success:true});
  } catch (error) {
    return json({success:false,error:"MISSION_SUBMISSION_FAILED"},500);
  }
}