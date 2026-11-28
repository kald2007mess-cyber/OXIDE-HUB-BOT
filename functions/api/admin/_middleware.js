// OXIDE HUB: notify the owner about successful admin dashboard visits and mutations.
const READ_ACTIONS = new Set([
  "list","get","load","status","stats","analytics","overview","search",
  "history","check","preview","details","permissions","activity","verify",
  "fetch","refresh","count","summary","proof","messages","completed"
]);
const MUTATING_ENDPOINTS = new Set([
  "beta-delivery-upload","beta-delivery","broadcast","downloads","download-conditions",
  "maintenance","news","redeem-codes","redemption-offers","reset-ads",
  "reset-data","reviews","rewards","security","support","tasks",
  "platform-delivery","platform-unlock","platform-visibility"
]);
const LABELS = {
  "beta-delivery-upload":"رفع ملف تسليم تجريبي",
  "downloads":"إدارة التنزيلات والملفات",
  "beta-delivery":"إدارة التسليم التجريبي",
  "broadcast":"إرسال منشور / إذاعة",
  "download-conditions":"تعديل شروط التنزيل",
  "maintenance":"تغيير وضع الصيانة",
  "news":"إدارة الأخبار والمنشورات",
  "redeem-codes":"إدارة أكواد الاسترداد",
  "redemption-offers":"إدارة عروض الاستبدال",
  "reset-ads":"إعادة ضبط الإعلانات",
  "reset-data":"إعادة ضبط البيانات",
  "reviews":"مراجعة الطلبات",
  "rewards":"إدارة المكافآت",
  "security":"تعديل إعدادات الأمان",
  "support":"إدارة الدعم الفني",
  "tasks":"إدارة المهام",
  "platform-delivery":"إدارة ملفات المنصات",
  "platform-unlock":"فتح منصة",
  "platform-visibility":"تغيير ظهور منصة"
};
function readActor(initData) {
  try {
    const p = new URLSearchParams(String(initData || ""));
    const u = JSON.parse(p.get("user") || "{}");
    return {
      id: String(u.id || "غير معروف"),
      name: [u.first_name, u.last_name].filter(Boolean).join(" ") || "مشرف",
      username: u.username ? "@"+u.username : ""
    };
  } catch { return {id:"غير معروف",name:"مشرف",username:""}; }
}
function summarize(body) {
  const fields = [
    ["title","العنوان"],["postId","رقم المنشور"],["taskId","رقم المهمة"],
    ["userId","المستخدم"],["telegramId","Telegram ID"],["code","الكود"],
    ["amount","المبلغ"],["status","الحالة"],["permission","الصلاحية"],
    ["platform","المنصة"],["fileName","الملف"],["offerId","العرض"],
    ["rewardId","المكافأة"],["maintenance","الصيانة"]
  ];
  const parts = [];
  for (const [key,label] of fields) {
    if (body && body[key] !== undefined && body[key] !== null && String(body[key]).length) {
      let value = String(body[key]).slice(0,90);
      if (key === "maintenance") value = body[key] ? "مفعّلة" : "متوقفة";
      parts.push(label+": "+value);
    }
  }
  return parts.slice(0,5);
}
async function sendOwnerNotice(env, text) {
  const token = env.TELEGRAM_BOT_TOKEN;
  const recipient = env.OXIDE_OWNER_TELEGRAM_ID || env.TELEGRAM_ADMIN_ID;
  if (!token || !recipient) return;
  const response = await fetch("https://api.telegram.org/bot"+token+"/sendMessage", {
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body:JSON.stringify({chat_id:String(recipient),text,disable_web_page_preview:true})
  });
  if (!response.ok) throw new Error("OWNER_NOTICE_FAILED_"+response.status);
  const result = await response.json();
  if (!result.ok) throw new Error("OWNER_NOTICE_REJECTED");
}
export async function onRequest(context) {
  const request = context.request;
  const response = await context.next();
  if (request.method !== "POST" || !new URL(request.url).pathname.startsWith("/api/admin/")) return response;
  try {
    const result = await response.clone().json();
    if (!response.ok || result?.success !== true) return response;
    const url = new URL(request.url);
    const endpoint = url.pathname.split("/").filter(Boolean).pop() || "unknown";
    const contentType = request.headers.get("content-type") || "";
    let body = {};
    if (contentType.includes("application/json")) body = await request.clone().json().catch(()=>({}));
    else if (contentType.includes("multipart/form-data")) {
      const form = await request.clone().formData();
      body = Object.fromEntries([...form.entries()].filter(([k,v])=>typeof v === "string"));
    }
    let eventTitle = "";
    if (endpoint === "auth") {
      eventTitle = "🔐 تم فتح لوحة تحكم OXIDE HUB";
    } else {
      const action = String(body.action || "").toLowerCase();
      if (READ_ACTIONS.has(action)) return response;
      if (!action && !MUTATING_ENDPOINTS.has(endpoint)) return response;
      const actionText = action ? " — "+action : "";
      eventTitle = "🛠️ إجراء إداري: "+(LABELS[endpoint] || endpoint)+actionText;
    }
    const actor = readActor(body.initData);
    const details = summarize(body);
    const time = new Date().toLocaleString("en-GB",{timeZone:"Africa/Algiers",hour12:false});
    const lines = [
      eventTitle,
      "👤 المشرف: "+actor.name+(actor.username ? " ("+actor.username+")" : ""),
      "🆔 Telegram ID: "+actor.id,
      "🕒 الوقت: "+time,
      "📍 القسم: "+endpoint,
      ...details.map(x=>"• "+x)
    ];
    const task = sendOwnerNotice(context.env,lines.join("\n")).catch(error=>{
      console.error("[OXIDE_ADMIN_AUDIT_NOTICE]",error?.message || error);
    });
    if (typeof context.waitUntil === "function") context.waitUntil(task);
    else await task;
  } catch (error) {
    console.error("[OXIDE_ADMIN_AUDIT]",error?.message || error);
  }
  return response;
}
