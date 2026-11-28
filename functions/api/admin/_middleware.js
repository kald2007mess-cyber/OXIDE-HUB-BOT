// OXIDE HUB: notify the owner about successful admin dashboard visits and mutations.
const READ_ACTIONS = new Set([
  "list","get","load","status","stats","analytics","overview","search",
  "history","check","preview","details","activity","verify",
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
async function readSecurityState(env, telegramId) {
  if (!env.DB || !/^\\d{5,20}$/.test(String(telegramId || ""))) return null;
  const deputy = await env.DB.prepare(
    "SELECT telegram_id, active, added_by, created_at FROM oxide_admin_deputies WHERE telegram_id = ?"
  ).bind(String(telegramId)).first();
  if (!deputy) return null;
  const rows = await env.DB.prepare(
    "SELECT permission FROM oxide_admin_deputy_permissions WHERE telegram_id = ? ORDER BY permission"
  ).bind(String(telegramId)).all();
  return {...deputy, permissions:(rows.results || []).map(x=>x.permission)};
}
const PERMISSION_NAMES = {
  users:"إدارة المستخدمين",news:"إدارة الأخبار",tasks:"إدارة المهام",
  support:"الدعم الفني",android:"منصة Android",beta:"صلاحية Beta القديمة",
  ios:"منصة iOS",platform_files:"ملفات المنصات",maintenance:"وضع الصيانة",stats:"الإحصائيات"
};
function securityDiff(action, target, before, after) {
  const lines = ["🛡️ تفاصيل التغيير الأمني","👥 Telegram ID للنائب: "+target];
  if (action === "add") {
    lines.push("الإجراء: إضافة مشرف فرعي");
    lines.push("النتيجة: "+(after ? "تمت الإضافة بنجاح" : "تعذّر العثور على سجل بعد الإضافة"));
    if (after) lines.push("الحالة: "+(after.active ? "مفعّل" : "معطّل"),"الصلاحيات: "+(after.permissions.map(p=>PERMISSION_NAMES[p]||p).join("، ")||"لا توجد صلاحيات"));
  } else if (action === "delete") {
    lines.push("الإجراء: حذف مشرف فرعي");
    lines.push("الحالة السابقة: "+(before ? (before.active ? "مفعّل" : "معطّل") : "غير موجود"));
    lines.push("الصلاحيات التي حُذفت: "+(before?.permissions?.map(p=>PERMISSION_NAMES[p]||p).join("، ")||"لا توجد"));
    lines.push("النتيجة: "+(!after ? "تم الحذف" : "ما زال السجل موجوداً"));
  } else if (action === "toggle") {
    lines.push("الإجراء: تغيير حالة المشرف الفرعي");
    lines.push("قبل: "+(before ? (before.active ? "مفعّل" : "معطّل") : "غير موجود"));
    lines.push("بعد: "+(after ? (after.active ? "مفعّل" : "معطّل") : "غير موجود"));
  } else if (action === "permissions") {
    const oldSet = new Set(before?.permissions || []);
    const newSet = new Set(after?.permissions || []);
    const added = [...newSet].filter(p=>!oldSet.has(p));
    const removed = [...oldSet].filter(p=>!newSet.has(p));
    lines.push("الإجراء: تعديل صلاحيات المشرف الفرعي");
    lines.push("الصلاحيات السابقة: "+([...oldSet].map(p=>PERMISSION_NAMES[p]||p).join("، ")||"لا توجد"));
    lines.push("الصلاحيات الجديدة: "+([...newSet].map(p=>PERMISSION_NAMES[p]||p).join("، ")||"لا توجد"));
    lines.push("تمت إضافتها: "+(added.map(p=>PERMISSION_NAMES[p]||p).join("، ")||"لا شيء"));
    lines.push("تم حذفها: "+(removed.map(p=>PERMISSION_NAMES[p]||p).join("، ")||"لا شيء"));
  }
  return lines;
}
export async function onRequest(context) {
  const request = context.request;
  const url = new URL(request.url);
  let auditBody = {};
  let securityBefore = null;
  const isSecurityChange = request.method === "POST" && url.pathname.endsWith("/api/admin/security");
  if (isSecurityChange) {
    auditBody = await request.clone().json().catch(()=>({}));
    if (["add","delete","toggle","permissions"].includes(String(auditBody.action||""))) {
      try { securityBefore = await readSecurityState(context.env, auditBody.telegram_id); }
      catch (error) { console.error("[OXIDE_SECURITY_AUDIT_BEFORE]",error?.message||error); }
    }
  }
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
    let securityDetails = [];
    if (endpoint === "security" && ["add","delete","toggle","permissions"].includes(String(body.action||""))) {
      try {
        const after = await readSecurityState(context.env, body.telegram_id);
        securityDetails = securityDiff(String(body.action),String(body.telegram_id||"غير معروف"),securityBefore,after);
      } catch (error) {
        securityDetails = ["تعذّر جلب مقارنة القيم قبل/بعد؛ "+String(error?.message||error).slice(0,120)];
      }
    }
    const lines = [
      eventTitle,
      "👤 المشرف: "+actor.name+(actor.username ? " ("+actor.username+")" : ""),
      "🆔 Telegram ID: "+actor.id,
      "🕒 الوقت: "+time,
      "📍 القسم: "+endpoint,
      ...securityDetails,
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
