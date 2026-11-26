import { getVisitor, json } from "./_lib/session.js";

async function ensureTable(DB) {
  await DB.prepare("CREATE TABLE IF NOT EXISTS adsgram_ad_analytics (id INTEGER PRIMARY KEY AUTOINCREMENT,user_id TEXT NOT NULL,offer TEXT NOT NULL DEFAULT 'island',event_type TEXT NOT NULL,created_at INTEGER NOT NULL)").run();
}

export async function onRequestPost({request,env}) {
  try {
    if (!env.DB || !env.SESSION_SECRET) return json({success:false,error:"SERVER_CONFIGURATION_MISSING"},500);
    await ensureTable(env.DB);
    const userId = await getVisitor(request,env);
    if (!userId) return json({success:false,error:"NO_TELEGRAM_SESSION"},401);
    const body = await request.json().catch(()=>({}));
    if (String(body.action||"") !== "impression") return json({success:false,error:"INVALID_ACTION"},400);
    const offer = ["island","beta","android","ios"].includes(String(body.offer)) ? String(body.offer) : "island";
    await env.DB.prepare("INSERT INTO adsgram_ad_analytics(user_id,offer,event_type,created_at) VALUES(?,?,?,?)").bind(userId,offer,"impression",Math.floor(Date.now()/1000)).run();
    return json({success:true});
  } catch(error) {
    console.error("AdsGram impression analytics failed:",error);
    return json({success:false,error:"AD_ANALYTICS_FAILED"},500);
  }
}
