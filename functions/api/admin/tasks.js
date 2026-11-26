import { authorizeAdmin, adminAuthResponse } from "../_lib/admin-auth.js";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
  });
}

async function ensureTables(DB) {
  await DB.prepare(`CREATE TABLE IF NOT EXISTS oxide_admin_missions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    platform TEXT NOT NULL DEFAULT 'general',
    target_url TEXT NOT NULL DEFAULT '',
    reward_points INTEGER NOT NULL DEFAULT 0,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL DEFAULT 0,
    sort_order INTEGER NOT NULL DEFAULT 0
  )`).run();
  let columns = await DB.prepare("PRAGMA table_info(oxide_admin_missions)").all();
  if (!(columns.results || []).some(c => c.name === "sort_order")) {
    await DB.prepare("ALTER TABLE oxide_admin_missions ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0").run();
  }
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

async function listTasks(DB) {
  const result = await DB.prepare(`
    SELECT m.id,m.title,m.description,m.platform,m.target_url,m.reward_points,
           m.enabled,m.created_at,m.sort_order,
           (SELECT COUNT(*) FROM mission_submissions s WHERE s.mission_id=m.id AND s.status='approved') AS completed_count,
           (SELECT COUNT(*) FROM mission_submissions s WHERE s.mission_id=m.id AND s.status='pending') AS pending_count,
           (SELECT COUNT(*) FROM mission_submissions s WHERE s.mission_id=m.id AND s.status='rejected') AS rejected_count
    FROM oxide_admin_missions m
    ORDER BY m.sort_order ASC,m.id ASC
  `).all();
  return result.results || [];
}

export async function onRequestPost({ request, env }) {
  try {
    if (!env.DB) return json({ success:false,error:"DATABASE_NOT_CONFIGURED" },500);
    const body = await request.json().catch(() => ({}));
    const auth = await authorizeAdmin(String(body.initData || ""), env, "tasks");
    if (!auth.ok) return adminAuthResponse(auth);
    await ensureTables(env.DB);
    const action = String(body.action || "");

    if (action === "list") return json({ success:true,tasks:await listTasks(env.DB) });

    if (action === "save") {
      const id = Number(body.id || 0);
      const title = String(body.title || "").trim().slice(0,160);
      const description = String(body.description || "").trim().slice(0,2000);
      const platform = ["tiktok","telegram","bots","referrals","general","telegram_join"].includes(String(body.platform)) ? String(body.platform) : "general";
      const targetUrl = String(body.target_url || "").trim().slice(0,1000);
      const reward = Number(body.reward_points);
      const sort = Number(body.sort_order);
      const enabled = Number(body.enabled) === 1 ? 1 : 0;
      if (!title || !Number.isSafeInteger(reward) || reward < 0 || reward > 100000 ||
          !Number.isSafeInteger(sort) || sort < 0 ||
          (targetUrl && !/^https:\/\//i.test(targetUrl))) {
        return json({ success:false,error:"INVALID_TASK_DATA" },400);
      }
      const now = Math.floor(Date.now()/1000);
      if (id > 0) {
        const result = await env.DB.prepare(`
          UPDATE oxide_admin_missions
          SET title=?,description=?,platform=?,target_url=?,reward_points=?,sort_order=?,enabled=?
          WHERE id=?
        `).bind(title,description,platform,targetUrl,reward,sort,enabled,id).run();
        if (Number(result.meta?.changes || 0) !== 1) return json({success:false,error:"TASK_NOT_FOUND"},404);
      } else {
        await env.DB.prepare(`
          INSERT INTO oxide_admin_missions(title,description,platform,target_url,reward_points,enabled,created_at,sort_order)
          VALUES(?,?,?,?,?,?,?,?)
        `).bind(title,description,platform,targetUrl,reward,enabled,now,sort).run();
      }
      return json({success:true,tasks:await listTasks(env.DB)});
    }

    const id = Number(action === "completed" ? body.missionId : body.id);
    if (!Number.isSafeInteger(id) || id < 1) return json({success:false,error:action === "completed" ? "INVALID_MISSION_ID" : "INVALID_TASK_ID"},400);

    if (action === "toggle") {
      const enabled = Number(body.enabled) === 1 ? 1 : 0;
      const result = await env.DB.prepare("UPDATE oxide_admin_missions SET enabled=? WHERE id=?").bind(enabled,id).run();
      if (Number(result.meta?.changes || 0) !== 1) return json({success:false,error:"TASK_NOT_FOUND"},404);
      return json({success:true});
    }

    if (action === "delete") {
      const count = await env.DB.prepare("SELECT COUNT(*) AS total FROM mission_submissions WHERE mission_id=?").bind(id).first();
      if (Number(count?.total || 0) > 0) return json({success:false,error:"TASK_HAS_SUBMISSIONS"},409);
      const result = await env.DB.prepare("DELETE FROM oxide_admin_missions WHERE id=?").bind(id).run();
      if (Number(result.meta?.changes || 0) !== 1) return json({success:false,error:"TASK_NOT_FOUND"},404);
      return json({success:true});
    }

    if (action === "completed") {
      const missionId = Number(body.missionId);
      if (!Number.isSafeInteger(missionId) || missionId < 1) return json({success:false,error:"INVALID_MISSION_ID"},400);
      const totalRow = await env.DB.prepare("SELECT COUNT(DISTINCT user_id) AS total FROM mission_submissions WHERE mission_id=? AND status='approved'").bind(missionId).first();
      const result = await env.DB.prepare(`
        SELECT s.user_id,COALESCE(u.points,v.points,0) AS points
        FROM mission_submissions s
        LEFT JOIN users u ON u.user_uuid=s.user_id
        LEFT JOIN visitors v ON v.user_id=s.user_id
        WHERE s.mission_id=? AND s.status='approved'
        GROUP BY s.user_id
        ORDER BY MAX(s.reviewed_at) DESC
        LIMIT 100
      `).bind(missionId).all();
      return json({success:true,total:Number(totalRow?.total || 0),users:result.results || []});
    }

    return json({success:false,error:"INVALID_ACTION"},400);
  } catch (error) {
    console.error("Admin tasks API error:",error);
    return json({success:false,error:"ADMIN_TASKS_FAILED"},500);
  }
}
