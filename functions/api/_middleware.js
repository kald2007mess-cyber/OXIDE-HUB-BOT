// Notify the OXIDE HUB owner when an admin changes platform visibility.
function actorFrom(initData) {
  try {
    const params = new URLSearchParams(String(initData || ""));
    const user = JSON.parse(params.get("user") || "{}");
    return {id:String(user.id || "غير معروف"),name:[user.first_name,user.last_name].filter(Boolean).join(" ") || "مشرف",username:user.username ? "@"+user.username : ""};
  } catch { return {id:"غير معروف",name:"مشرف",username:""}; }
}
export async function onRequest(context) {
  const request=context.request;
  const response=await context.next();
  const url=new URL(request.url);
  if(request.method!=="POST" || url.pathname!=="/api/platform-visibility") return response;
  try {
    const result=await response.clone().json();
    if(!response.ok || result?.success!==true) return response;
    const body=await request.clone().json().catch(()=>({}));
    const actor=actorFrom(body.initData);
    const recipient=context.env.OXIDE_OWNER_TELEGRAM_ID || context.env.TELEGRAM_ADMIN_ID;
    const token=context.env.TELEGRAM_BOT_TOKEN;
    if(!recipient || !token) return response;
    const time=new Date().toLocaleString("en-GB",{timeZone:"Africa/Algiers",hour12:false});
    const message=[
      "🛠️ إجراء إداري: تغيير ظهور منصة",
      "👤 المشرف: "+actor.name+(actor.username ? " ("+actor.username+")" : ""),
      "🆔 Telegram ID: "+actor.id,
      "📍 المنصة: "+String(result.platform || body.platform || "غير محددة"),
      "⚙️ الحالة: "+(result.enabled ? "مفعّلة" : "متوقفة"),
      "🕒 الوقت: "+time
    ].join("\n");
    const task=fetch("https://api.telegram.org/bot"+token+"/sendMessage",{
      method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({chat_id:String(recipient),text:message,disable_web_page_preview:true})
    }).then(async r=>{if(!r.ok)throw new Error("OWNER_NOTICE_FAILED_"+r.status);const j=await r.json();if(!j.ok)throw new Error("OWNER_NOTICE_REJECTED");})
      .catch(e=>console.error("[OXIDE_PLATFORM_ADMIN_NOTICE]",e?.message||e));
    if(typeof context.waitUntil==="function") context.waitUntil(task); else await task;
  } catch(e) { console.error("[OXIDE_PLATFORM_ADMIN_AUDIT]",e?.message||e); }
  return response;
}
