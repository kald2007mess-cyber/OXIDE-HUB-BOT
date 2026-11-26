import { getVisitor } from "../_lib/session.js";
import { authorizeAdmin, adminAuthResponse } from "../_lib/admin-auth.js";

const OFFERS = new Set(["beta", "android", "ios"]);
const MAX_FILES = 3;
const MAX_SIZE = 50 * 1024 * 1024;
function out(data,status=200){return new Response(JSON.stringify(data),{status,headers:{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"}});}
async function ensure(DB){
 await DB.prepare("CREATE TABLE IF NOT EXISTS platform_delivery_config (offer TEXT PRIMARY KEY, message TEXT NOT NULL DEFAULT '', files_json TEXT NOT NULL DEFAULT '[]', updated_at INTEGER NOT NULL DEFAULT 0)").run();
 await DB.prepare("CREATE TABLE IF NOT EXISTS platform_delivery_claims (user_uuid TEXT NOT NULL, offer TEXT NOT NULL, last_sent_at INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(user_uuid,offer))").run();
 await DB.prepare("CREATE TABLE IF NOT EXISTS beta_delivery_config (id INTEGER PRIMARY KEY CHECK(id=1), message TEXT NOT NULL DEFAULT '', files_json TEXT NOT NULL DEFAULT '[]', updated_at INTEGER NOT NULL DEFAULT 0)").run();
 await DB.prepare("INSERT OR IGNORE INTO platform_delivery_config(offer,message,files_json,updated_at) SELECT 'beta',message,files_json,updated_at FROM beta_delivery_config WHERE id=1").run();
 for(const offer of OFFERS)await DB.prepare("INSERT OR IGNORE INTO platform_delivery_config(offer,message,files_json,updated_at) VALUES(?, '', '[]', 0)").bind(offer).run();
}
function validOffer(v){const x=String(v||"beta").toLowerCase();return OFFERS.has(x)?x:null;}
function filesFrom(value){try{const x=JSON.parse(String(value||"[]"));return Array.isArray(x)?x.filter(f=>f&&typeof f.name==="string"&&(typeof f.key==="string"||typeof f.file_id==="string")).slice(0,MAX_FILES):[];}catch{return [];}}
async function config(DB,offer){const row=await DB.prepare("SELECT message,files_json FROM platform_delivery_config WHERE offer=?").bind(offer).first();return{message:String(row?.message||""),files:filesFrom(row?.files_json)};}
async function tg(token,method,payload){const r=await fetch("https://api.telegram.org/bot"+token+"/"+method,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)});const d=await r.json().catch(()=>({}));if(!r.ok||!d.ok)throw new Error(d.description||"TELEGRAM_SEND_FAILED");return d.result;}
async function storeFile(env,file){if(!file||typeof file.arrayBuffer!=="function"||!file.size)throw new Error("INVALID_FILE");if(file.size>MAX_SIZE)throw new Error("FILE_TOO_LARGE");const form=new FormData();form.append("chat_id",String(env.TELEGRAM_ADMIN_ID));form.append("document",file,file.name||"platform-file");const r=await fetch("https://api.telegram.org/bot"+env.TELEGRAM_BOT_TOKEN+"/sendDocument",{method:"POST",body:form});const d=await r.json().catch(()=>({}));if(!r.ok||!d.ok)throw new Error(d.description||"TELEGRAM_FILE_UPLOAD_FAILED");const m=d.result,id=m.document?.file_id;if(!id)throw new Error("TELEGRAM_FILE_ID_MISSING");await tg(env.TELEGRAM_BOT_TOKEN,"deleteMessage",{chat_id:env.TELEGRAM_ADMIN_ID,message_id:m.message_id}).catch(()=>{});return{file_id:id,name:String(file.name||m.document.file_name||"file").slice(0,180),size:Number(file.size||0)};}
export async function onRequestPost({request,env}){
 try{
  if(!env.DB||!env.SESSION_SECRET||!env.TELEGRAM_BOT_TOKEN||!env.TELEGRAM_ADMIN_ID)return out({success:false,error:"SERVER_CONFIGURATION_MISSING"},500);
  await ensure(env.DB);
  if((request.headers.get("Content-Type")||"").includes("multipart/form-data")){
   const form=await request.formData(),offer=validOffer(form.get("offer")),auth=await authorizeAdmin(String(form.get("initData")||""),env,"platform_files");
   if(!auth.ok)return adminAuthResponse(auth);if(!offer)return out({success:false,error:"INVALID_OFFER"},400);
   const message=String(form.get("message")||"").trim();if(message.length>4000)return out({success:false,error:"MESSAGE_TOO_LONG"},400);
   const incoming=form.getAll("files").filter(f=>f&&typeof f.arrayBuffer==="function"&&f.size>0);if(incoming.length>MAX_FILES)return out({success:false,error:"TOO_MANY_FILES",message:"Maximum 3 files per platform offer"},400);
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
  const col={beta:"beta_ads",android:"android_ads",ios:"ios_ads"}[offer];
  const p=await env.DB.prepare("SELECT "+col+" AS completed,cycle_started_at FROM platform_ad_progress WHERE user_id=?").bind(user).first();
  const now=Math.floor(Date.now()/1000);
  if(!p||now-Number(p.cycle_started_at||now)>=18000||Number(p.completed||0)<10)return out({success:false,error:"OFFER_NOT_COMPLETE"},403);
  const last=await env.DB.prepare("SELECT last_sent_at FROM platform_delivery_claims WHERE user_uuid=? AND offer=?").bind(user,offer).first();
  if(now-Number(last?.last_sent_at||0)<30)return out({success:false,error:"PLEASE_WAIT"},429);
  const c=await config(env.DB,offer);if(!c.message&&!c.files.length)return out({success:false,error:"OFFER_CONTENT_NOT_CONFIGURED"},404);
  const chat=String(identity.telegram_user_id);
  if(!c.files.length)await tg(env.TELEGRAM_BOT_TOKEN,"sendMessage",{chat_id:chat,text:c.message});
  else if(c.files.length===1){if(c.message.length<=1024)await tg(env.TELEGRAM_BOT_TOKEN,"sendDocument",{chat_id:chat,document:c.files[0].file_id,caption:c.message||undefined});else{await tg(env.TELEGRAM_BOT_TOKEN,"sendMessage",{chat_id:chat,text:c.message});await tg(env.TELEGRAM_BOT_TOKEN,"sendDocument",{chat_id:chat,document:c.files[0].file_id});}}
  else{if(c.message.length>1024)await tg(env.TELEGRAM_BOT_TOKEN,"sendMessage",{chat_id:chat,text:c.message});const media=c.files.map((f,i)=>({type:"document",media:f.file_id,...(i===0&&c.message.length<=1024&&c.message?{caption:c.message}:{})}));await tg(env.TELEGRAM_BOT_TOKEN,"sendMediaGroup",{chat_id:chat,media});}
  await env.DB.prepare("INSERT INTO platform_delivery_claims(user_uuid,offer,last_sent_at) VALUES(?,?,?) ON CONFLICT(user_uuid,offer) DO UPDATE SET last_sent_at=excluded.last_sent_at").bind(user,offer,now).run();
  return out({success:true,offer,sentFiles:c.files.length});
 }catch(e){console.error("Platform delivery failed",e);return out({success:false,error:String(e?.message||"DELIVERY_FAILED").slice(0,180)},500);}
}
