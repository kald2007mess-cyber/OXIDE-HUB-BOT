import { authorizeAdmin, adminAuthResponse } from "../_lib/admin-auth.js";
import { json } from "../_lib/session.js";

export async function onRequestPost({request,env}) {
  try {
    if (!env.DB) return json({success:false,error:"DATABASE_NOT_CONFIGURED"},500);
    const body = await request.json().catch(()=>({}));
    const auth = await authorizeAdmin(String(body.initData||""),env);
    if (!auth.ok) return adminAuthResponse(auth);
    await env.DB.prepare("CREATE TABLE IF NOT EXISTS adsgram_ad_analytics (id INTEGER PRIMARY KEY AUTOINCREMENT,user_id TEXT NOT NULL,offer TEXT NOT NULL DEFAULT 'island',event_type TEXT NOT NULL,created_at INTEGER NOT NULL)").run();

    // AdsGram earnings estimate uses completed, server-verified reward events only.
    // All reporting periods use Africa/Algiers local calendar dates (UTC+1).
    const now = Math.floor(Date.now()/1000);
    const shifted = new Date((now+3600)*1000);
    const todayKey = shifted.toISOString().slice(0,10);
    const monthKey = todayKey.slice(0,7);
    const todayStart = Math.floor(Date.parse(todayKey+"T00:00:00Z")/1000)-3600;
    const weekStart = todayStart-6*86400;
    const monthStart = Math.floor(Date.parse(monthKey+"-01T00:00:00Z")/1000)-3600;
    const totals = await env.DB.prepare(`
      SELECT
        SUM(CASE WHEN event_type='impression' THEN 1 ELSE 0 END) AS impressions,
        SUM(CASE WHEN event_type='completion' THEN 1 ELSE 0 END) AS completions,
        SUM(CASE WHEN event_type='completion' AND created_at>=? THEN 1 ELSE 0 END) AS todayCompletions,
        SUM(CASE WHEN event_type='completion' AND created_at>=? THEN 1 ELSE 0 END) AS weekCompletions,
        SUM(CASE WHEN event_type='completion' AND created_at>=? THEN 1 ELSE 0 END) AS monthCompletions
      FROM adsgram_ad_analytics
    `).bind(todayStart,weekStart,monthStart).first();
    const dailyRows = await env.DB.prepare(`
      SELECT date(created_at+3600,'unixepoch') AS day, COUNT(*) AS completions
      FROM adsgram_ad_analytics
      WHERE event_type='completion' AND created_at>=?
      GROUP BY date(created_at+3600,'unixepoch')
      ORDER BY day ASC
    `).bind(weekStart).all();
    const dailyMap = Object.fromEntries((dailyRows.results||[]).map(row=>[row.day,Number(row.completions||0)]));
    const daily = [];
    for(let i=0;i<7;i++){
      const day = new Date((todayStart+3600+i*86400)*1000).toISOString().slice(0,10);
      daily.push({day,completions:dailyMap[day]||0});
    }
    return json({
      success:true,
      impressions:Number(totals?.impressions||0),
      completions:Number(totals?.completions||0),
      todayCompletions:Number(totals?.todayCompletions||0),
      weekCompletions:Number(totals?.weekCompletions||0),
      monthCompletions:Number(totals?.monthCompletions||0),
      daily,
      internalClicks:null,
      ratePerAd:0.006,
      currency:"USD₮",
      timezone:"Africa/Algiers"
    });
  } catch(error) {
    console.error("Admin AdsGram analytics failed:",error);
    return json({success:false,error:"ADMIN_AD_ANALYTICS_FAILED"},500);
  }
}
