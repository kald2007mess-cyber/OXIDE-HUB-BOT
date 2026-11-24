import { json } from "./_lib/session.js";

async function ensureSettings(DB) {
  await DB.prepare(`CREATE TABLE IF NOT EXISTS site_settings (
    setting_key TEXT PRIMARY KEY,
    setting_value TEXT NOT NULL DEFAULT '',
    updated_at INTEGER NOT NULL DEFAULT 0
  )`).run();
}

export async function onRequestGet({ env }) {
  try {
    if (!env.DB) return json({ success:false, error:"DATABASE_ERROR" },500);
    await ensureSettings(env.DB);
    const rows = await env.DB.prepare(
      "SELECT setting_key, setting_value FROM site_settings WHERE setting_key IN ('launch_active','launch_started_at','launch_ends_at')"
    ).all();
    const values = Object.fromEntries((rows.results||[]).map(x=>[x.setting_key,x.setting_value]));
    const now = Math.floor(Date.now()/1000);
    const active = values.launch_active === "1" && Number(values.launch_ends_at||0) > now;
    return json({
      success:true, active,
      startedAt:Number(values.launch_started_at||0),
      endsAt:Number(values.launch_ends_at||0),
      remainingSeconds:active ? Math.max(0,Number(values.launch_ends_at)-now) : 0
    });
  } catch (error) {
    console.error("Launch status error:",error);
    return json({success:false,error:"LAUNCH_STATUS_FAILED"},500);
  }
}
