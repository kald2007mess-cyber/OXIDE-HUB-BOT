import { getVisitor } from "../_lib/session.js";
import { authorizeAdmin, adminAuthResponse } from "../_lib/admin-auth.js";

const OFFERS = new Set(["beta", "android", "ios"]);
const MAX_SIZE = 3 * 1024 * 1024 * 1024;
function out(data,status=200){return new Response(JSON.stringify(data),{status,headers:{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"}});}
async function ensure(DB){
 await DB.prepare("CREATE TABLE IF NOT EXISTS platform_delivery_config (offer TEXT PRIMARY KEY, message TEXT NOT NULL DEFAULT '', files_json TEXT NOT NULL DEFAULT '[]', updated_at INTEGER NOT NULL DEFAULT 0)").run();
 const cols=await DB.prepare("PRAGMA table_info(platform_delivery_config)").all();if(!(cols.results||[]).some(c=>c.name==="published"))await DB.prepare("ALTER TABLE platform_delivery_config ADD COLUMN published INTEGER NOT NULL DEFAULT 1").run();
 await DB.prepare("CREATE TABLE IF NOT EXISTS platform_delivery_claims (user_uuid TEXT NOT NULL, offer TEXT NOT NULL, last_sent_at INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(user_uuid,offer))").run();
 await DB.prepare("CREATE TABLE IF NOT EXISTS beta_delivery_config (id INTEGER PRIMARY KEY CHECK(id=1), message TEXT NOT NULL DEFAULT '', files_json TEXT NOT NULL DEFAULT '[]', updated_at INTEGER NOT NULL DEFAULT 0)").run();
 await DB.prepare("INSERT OR IGNORE INTO platform_delivery_config(offer,message,files_json,updated_at) SELECT 'beta',message,files_json,updated_at FROM beta_delivery_config WHERE id=1").run();
 for(const offer of OFFERS)await DB.prepare("INSERT OR IGNORE INTO platform_delivery_config(offer,message,files_json,updated_at) VALUES(?, '', '[]', 0)").bind(offer).run();
}
function validOffer(v){const x=String(v||"beta").toLowerCase();return OFFERS.has(x)?x:null;}
function filesFrom(value){try{const x=JSON.parse(String(value||"[]"));return Array.isArray(x)?x.filter(f=>f&&typeof f.name==="string"&&(typeof f.key==="string"||typeof f.file_id==="string")).slice():[];}catch{return [];}}
async function config(DB,offer){const row=await DB.prepare("SELECT message,files_json,published FROM platform_delivery_config WHERE offer=?").bind(offer).first();return{message:String(row?.message||""),files:filesFrom(row?.files_json),published:Number(row?.published??1)===1};}
async function channelMembership(userId,env){
 const response=await fetch("https://api.telegram.org/bot"+env.TELEGRAM_BOT_TOKEN+"/getChatMember",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({chat_id:"@OxideHubOfficial",user_id:Number(userId)})});
 const data=await response.json().catch(()=>null);
 if(!response.ok||!data?.ok||!data.result)return{error:"CHANNEL_CHECK_UNAVAILABLE"};
 const member=data.result,status=String(member.status||"");
 return{joined:["creator","administrator","member"].includes(status)||(status==="restricted"&&member.is_member===true)};
}
async function tg(token,method,payload){const r=await fetch("https://api.telegram.org/bot"+token+"/"+method,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)});const d=await r.json().catch(()=>({}));if(!r.ok||!d.ok)throw new Error(d.description||"TELEGRAM_SEND_FAILED");return d.result;}
async function sendStoredDocument(env,chat,file,caption){
 if(file?.file_id)return tg(env.TELEGRAM_BOT_TOKEN,"sendDocument",{chat_id:chat,document:file.file_id,...(caption?{caption}:{})});
 if(!file?.key||!env.PLATFORM_MEDIA)throw new Error("DELIVERY_FILE_REFERENCE_MISSING");
 const object=await env.PLATFORM_MEDIA.get(file.key);
 if(!object)throw new Error("DELIVERY_FILE_NOT_FOUND_IN_STORAGE");
 const size=Number(file.size||object.size||0);
 if(size>50*1024*1024)throw new Error("TELEGRAM_FILE_TOO_LARGE_MAX_50MB");
 const bytes=await object.arrayBuffer();
 if(!bytes.byteLength)throw new Error("DELIVERY_FILE_EMPTY");
 const form=new FormData();
 form.append("chat_id",String(chat));
 if(caption)form.append("caption",caption);
 const blob=new Blob([bytes],{type:String(file.contentType||"application/octet-stream")});
 form.append("document",blob,String(file.name||"platform-file").replace(/[\\r\\n]/g,"_"));
 const response=await fetch("https://api.telegram.org/bot"+env.TELEGRAM_BOT_TOKEN+"/sendDocument",{method:"POST",body:form});
 const data=await response.json().catch(()=>({}));
 if(!response.ok||!data?.ok)throw new Error(data.description||"TELEGRAM_FILE_SEND_FAILED");
 return data.result;
}
async function storeFile(env,file){if(!file||typeof file.arrayBuffer!=="function"||!file.size)throw new Error("INVALID_FILE");if(file.size>MAX_SIZE)throw new Error("FILE_TOO_LARGE");const form=new FormData();form.append("chat_id",String(env.TELEGRAM_ADMIN_ID));form.append("document",file,file.name||"platform-file");const r=await fetch("https://api.telegram.org/bot"+env.TELEGRAM_BOT_TOKEN+"/sendDocument",{method:"POST",body:form});const d=await r.json().catch(()=>({}));if(!r.ok||!d.ok)throw new Error(d.description||"TELEGRAM_FILE_UPLOAD_FAILED");const m=d.result,id=m.document?.file_id;if(!id)throw new Error("TELEGRAM_FILE_ID_MISSING");await tg(env.TELEGRAM_BOT_TOKEN,"deleteMessage",{chat_id:env.TELEGRAM_ADMIN_ID,message_id:m.message_id}).catch(()=>{});return{file_id:id,name:String(file.name||m.document.file_name||"file").slice(0,180),size:Number(file.size||0)};}
export async function onRequestPost({request,env}){
 try{
  if(!env.DB||!env.SESSION_SECRET||!env.TELEGRAM_BOT_TOKEN||!env.TELEGRAM_ADMIN_ID)return out({success:false,error:"SERVER_CONFIGURATION_MISSING"},500);
  await ensure(env.DB);
  if((request.headers.get("Content-Type")||"").includes("multipart/form-data")){
   const form=await request.formData(),offer=validOffer(form.get("offer")),auth=await authorizeAdmin(String(form.get("initData")||""),env,"platform_files");
   if(!auth.ok)return adminAuthResponse(auth);if(!offer)return out({success:false,error:"INVALID_OFFER"},400);
   const message=String(form.get("message")||"").trim();if(message.length>4000)return out({success:false,error:"MESSAGE_TOO_LONG"},400);
   const incoming=form.getAll("files").filter(f=>f&&typeof f.arrayBuffer==="function"&&f.size>0);
   const uploaded=[];for(const f of incoming)uploaded.push(await storeFile(env,f));
   const previous=await config(env.DB,offer),files=uploaded.length?uploaded:previous.files,now=Math.floor(Date.now()/1000);
   await env.DB.prepare("UPDATE platform_delivery_config SET message=?,files_json=?,updated_at=? WHERE offer=?").bind(message,JSON.stringify(files),now,offer).run();
   return out({success:true,offer,message,files});
  }
  const body=await request.json().catch(()=>({})),offer=validOffer(body.offer);
  if(!offer)return out({success:false,error:"INVALID_OFFER"},400);
  if(body.action==="get"){
   const auth=await authorizeAdmin(String(body.initData||""),env,"platform_files");if(!auth.ok)return adminAuthResponse(auth);
   return out({success:true,offer,...await config(env.DB,offer)});
  }
  if(body.action==="rename_file"){
   const auth=await authorizeAdmin(String(body.initData||""),env,"platform_files");if(!auth.ok)return adminAuthResponse(auth);
   const index=Number(body.index),name=String(body.name||"").trim();
   if(!Number.isInteger(index)||index<0||!name||name.length>180)return out({success:false,error:"INVALID_FILE_DETAILS"},400);
   const current=await config(env.DB,offer);if(index>=current.files.length)return out({success:false,error:"FILE_NOT_FOUND"},404);
   const original=String(current.files[index].name||"file"),extension=(original.match(/(\.[^.]+)$/)||[])[1]||"";
   const finalName=/\.[^.]+$/.test(name)?name:name+extension;
   const files=current.files.map((file,i)=>i===index?{...file,name:finalName}:file);
   await env.DB.prepare("UPDATE platform_delivery_config SET files_json=?,updated_at=? WHERE offer=?").bind(JSON.stringify(files),Math.floor(Date.now()/1000),offer).run();
   return out({success:true,offer,...await config(env.DB,offer)});
  }
  if(body.action==="remove_file"){
   const auth=await authorizeAdmin(String(body.initData||""),env,"platform_files");if(!auth.ok)return adminAuthResponse(auth);
   const index=Number(body.index);
   if(!Number.isInteger(index)||index<0)return out({success:false,error:"INVALID_FILE_INDEX"},400);
   const current=await config(env.DB,offer);
   if(index>=current.files.length)return out({success:false,error:"FILE_NOT_FOUND"},404);
   const removed=current.files[index];
   const files=current.files.filter((_,i)=>i!==index);
   await env.DB.prepare("UPDATE platform_delivery_config SET files_json=?,updated_at=? WHERE offer=?").bind(JSON.stringify(files),Math.floor(Date.now()/1000),offer).run();
   if(removed?.key&&env.PLATFORM_MEDIA)await env.PLATFORM_MEDIA.delete(removed.key).catch(()=>{});
   return out({success:true,offer,...await config(env.DB,offer)});
  }
  const user=await getVisitor(request,env);if(!user)return out({success:false,error:"NO_TELEGRAM_SESSION"},401);
  const identity=await env.DB.prepare("SELECT telegram_user_id FROM telegram_identities WHERE user_uuid=? LIMIT 1").bind(user).first();
  if(!identity?.telegram_user_id)return out({success:false,error:"TELEGRAM_ID_NOT_LINKED"},403);
  const membership=await channelMembership(identity.telegram_user_id,env);
  if(membership.error)return out({success:false,error:membership.error},503);
  if(!membership.joined)return out({success:false,subscriptionRequired:true,error:"CHANNEL_SUBSCRIPTION_REQUIRED"},403);
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS oxide_go_access(user_uuid TEXT PRIMARY KEY,source_code TEXT NOT NULL,granted_at INTEGER NOT NULL)").run();
  const goPass=await env.DB.prepare("SELECT 1 AS allowed FROM oxide_go_access WHERE user_uuid=?").bind(user).first();
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS platform_paid_unlocks(user_uuid TEXT NOT NULL,offer TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(user_uuid,offer))").run();
  const paidPass=await env.DB.prepare("SELECT 1 AS allowed FROM platform_paid_unlocks WHERE user_uuid=? AND offer=?").bind(user,offer).first();
  const now=Math.floor(Date.now()/1000);
  if(!goPass&&!paidPass){
   const col={beta:"beta_ads",android:"android_ads",ios:"ios_ads"}[offer];
   const p=await env.DB.prepare("SELECT "+col+" AS completed,cycle_started_at FROM platform_ad_progress WHERE user_id=?").bind(user).first();
   if(!p||now-Number(p.cycle_started_at||now)>=18000||Number(p.completed||0)<10)return out({success:false,error:"OFFER_NOT_COMPLETE"},403);
  }
  const last=await env.DB.prepare("SELECT last_sent_at FROM platform_delivery_claims WHERE user_uuid=? AND offer=?").bind(user,offer).first();
  if(now-Number(last?.last_sent_at||0)<30)return out({success:false,error:"PLEASE_WAIT"},429);
  const c=await config(env.DB,offer);if(!c.published)return out({success:false,error:"CONTENT_NOT_PUBLISHED"},404);if(!c.message&&!c.files.length)return out({success:false,error:"OFFER_CONTENT_NOT_CONFIGURED"},404);
  const chat=String(identity.telegram_user_id);
  if(!c.files.length)await tg(env.TELEGRAM_BOT_TOKEN,"sendMessage",{chat_id:chat,text:c.message});
  else{
   if(c.message.length>1024)await tg(env.TELEGRAM_BOT_TOKEN,"sendMessage",{chat_id:chat,text:c.message});
   for(let i=0;i<c.files.length;i++)await sendStoredDocument(env,chat,c.files[i],i===0&&c.message.length<=1024?c.message:"");
  }
  await tg(env.TELEGRAM_BOT_TOKEN,"sendMessage",{chat_id:chat,text:"✅ تم إرسال الملف بنجاح. يمكنك الآن تنزيله من هذه المحادثة."});
  await env.DB.prepare("INSERT INTO platform_delivery_claims(user_uuid,offer,last_sent_at) VALUES(?,?,?) ON CONFLICT(user_uuid,offer) DO UPDATE SET last_sent_at=excluded.last_sent_at").bind(user,offer,now).run();
  return out({success:true,offer,sentFiles:c.files.length});
 }catch(e){console.error("Platform delivery failed",e);return out({success:false,error:String(e?.message||"DELIVERY_FAILED").slice(0,180)},500);}
}
