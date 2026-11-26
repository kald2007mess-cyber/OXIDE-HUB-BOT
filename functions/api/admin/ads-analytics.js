import { authorizeAdmin, adminAuthResponse } from "../_lib/admin-auth.js";
import { json } from "../_lib/session.js";

export async function onRequestPost({request,env}) {
  try {
    if (!env.DB) return json({success:false,error:"DATABASE_NOT_CONFIGURED"},500);
    const body = await request.json().catch(()=>({}));
    const auth = await authorizeAdmin(String(body.initData||""),env);
    if (!auth.ok) return adminAuthResponse(auth);
    await env.DB.prepare("CREATE TABLE IF NOT EXISTS adsgram_ad_analytics (id INTEGER PRIMARY KEY AUTOINCREMENT,user_id TEXT NOT NULL,offer TEXT NOT NULL DEFAULT 'island',event_type TEXT NOT NULL,created_at INTEGER NOT NULL)").run();
    const row = await env.DB.prepare("SELECT SUM(CASE WHEN event_type='impression' THEN 1 ELSE 0 END) AS impressions,SUM(CASE WHEN event_type='completion' THEN 1 ELSE 0 END) AS completions FROM adsgram_ad_analytics").first();
    return json({success:true,impressions:Number(row?.impressions||0),completions:Number(row?.completions||0),internalClicks:null});
  } catch(error) {
    console.error("Admin AdsGram analytics failed:",error);
    return json({success:false,error:"ADMIN_AD_ANALYTICS_FAILED"},500);
  }
}
