import { json } from "../_lib/session.js";
import { authorizeAdmin, adminAuthResponse } from "../_lib/admin-auth.js";

async function ensureSettings(DB) {
  await DB.prepare(`CREATE TABLE IF NOT EXISTS site_settings (
    setting_key TEXT PRIMARY KEY,
    setting_value TEXT NOT NULL DEFAULT '',
    updated_at INTEGER NOT NULL DEFAULT 0
  )`).run();
}

export async function onRequestPost({request,env}) {
  try {
    if (!env.DB) return json({success:false,error:"DATABASE_ERROR"},500);
    const body=await request.json().catch(()=>({}));
    const auth=await authorizeAdmin(String(body.initData||""),env,"maintenance");
    if(!auth.ok) return adminAuthResponse(auth);
    await ensureSettings(env.DB);
    const now=Math.floor(Date.now()/1000);
    if(body.action==="get"){
      const rows=await env.DB.prepare(
        "SELECT setting_key,setting_value FROM site_settings WHERE setting_key IN ('launch_active','launch_started_at','launch_ends_at')"
      ).all();
      const values=Object.fromEntries((rows.results||[]).map(x=>[x.setting_key,x.setting_value]));
      const active=values.launch_active==="1";
      return json({success:true,active,startedAt:Number(values.launch_started_at||0),endsAt:Number(values.launch_ends_at||0),remainingSeconds:active?Number(values.launch_ends_at)-now:0});
    }
    if(body.action==="start"){
      const endsAt=now+22*60*60;
      await env.DB.batch([
        env.DB.prepare("INSERT INTO site_settings(setting_key,setting_value,updated_at) VALUES('launch_active','1',?) ON CONFLICT(setting_key) DO UPDATE SET setting_value='1',updated_at=excluded.updated_at").bind(now),
        env.DB.prepare("INSERT INTO site_settings(setting_key,setting_value,updated_at) VALUES('launch_started_at',?,?) ON CONFLICT(setting_key) DO UPDATE SET setting_value=excluded.setting_value,updated_at=excluded.updated_at").bind(String(now),now),
        env.DB.prepare("INSERT INTO site_settings(setting_key,setting_value,updated_at) VALUES('launch_ends_at',?,?) ON CONFLICT(setting_key) DO UPDATE SET setting_value=excluded.setting_value,updated_at=excluded.updated_at").bind(String(endsAt),now)
      ]);
      return json({success:true,active:true,startedAt:now,endsAt,remainingSeconds:22*60*60});
    }
    if(body.action==="stop"){
      await env.DB.prepare("INSERT INTO site_settings(setting_key,setting_value,updated_at) VALUES('launch_active','0',?) ON CONFLICT(setting_key) DO UPDATE SET setting_value='0',updated_at=excluded.updated_at").bind(now).run();
      return json({success:true,active:false,startedAt:0,endsAt:0,remainingSeconds:0});
    }
    return json({success:false,error:"INVALID_ACTION"},400);
  } catch(error) {
    console.error("Admin launch error:",error);
    return json({success:false,error:"LAUNCH_ADMIN_FAILED"},500);
  }
}
