import { authorizeAdmin, adminAuthResponse } from "../_lib/admin-auth.js";

function json(data,status=200){return new Response(JSON.stringify(data),{status,headers:{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"}});}
async function telegram(token,method,payload){
 const response=await fetch(`https://api.telegram.org/bot${token}/${method}`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)});
 const data=await response.json().catch(()=>({}));
 if(!response.ok||!data.ok)throw new Error(data.description||"TELEGRAM_SEND_FAILED");
 return data.result;
}
async function ensure(DB){
 await DB.prepare(`CREATE TABLE IF NOT EXISTS oxide_broadcast_jobs(
  id INTEGER PRIMARY KEY AUTOINCREMENT,body TEXT NOT NULL,media_type TEXT,media_file_id TEXT,
  status TEXT NOT NULL DEFAULT 'queued',total INTEGER NOT NULL DEFAULT 0,
  sent INTEGER NOT NULL DEFAULT 0,failed INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,finished_at INTEGER
 )`).run();
}
async function sendToUser(token,chatId,body,mediaType,fileId){
 if(mediaType==="photo")return telegram(token,"sendPhoto",{chat_id:chatId,photo:fileId,caption:body||undefined});
 if(mediaType==="video")return telegram(token,"sendVideo",{chat_id:chatId,video:fileId,caption:body||undefined});
 return telegram(token,"sendMessage",{chat_id:chatId,text:body,disable_web_page_preview:false});
}
async function runBroadcast(env,jobId,body,mediaType,fileId){
 const DB=env.DB;
 try{
  await DB.prepare("UPDATE oxide_broadcast_jobs SET status='sending' WHERE id=?").bind(jobId).run();
  const users=await DB.prepare(`SELECT DISTINCT ti.telegram_user_id AS chat_id
   FROM telegram_identities ti INNER JOIN users u ON u.user_uuid=ti.user_uuid
   WHERE u.status='active' ORDER BY ti.telegram_user_id`).all();
  const recipients=users.results||[];
  await DB.prepare("UPDATE oxide_broadcast_jobs SET total=? WHERE id=?").bind(recipients.length,jobId).run();
  let sent=0,failed=0;
  for(const user of recipients){
   try{await sendToUser(env.TELEGRAM_BOT_TOKEN,String(user.chat_id),body,mediaType,fileId);sent++;}
   catch{failed++;}
   if((sent+failed)%10===0){
    await DB.prepare("UPDATE oxide_broadcast_jobs SET sent=?,failed=? WHERE id=?").bind(sent,failed,jobId).run();
   }
   await new Promise(resolve=>setTimeout(resolve,45));
  }
  await DB.prepare("UPDATE oxide_broadcast_jobs SET sent=?,failed=?,status='completed',finished_at=? WHERE id=?")
   .bind(sent,failed,Math.floor(Date.now()/1000),jobId).run();
 }catch(error){
  await DB.prepare("UPDATE oxide_broadcast_jobs SET status='failed',sent=COALESCE(sent,0),finished_at=? WHERE id=?")
   .bind(Math.floor(Date.now()/1000),jobId).run().catch(()=>{});
 }
}
export async function onRequestPost({request,env,waitUntil}){
 try{
  if(!env.DB||!env.TELEGRAM_BOT_TOKEN||!env.TELEGRAM_ADMIN_ID)return json({success:false,error:"SERVER_CONFIGURATION_MISSING"},500);
  const contentType=request.headers.get("Content-Type")||"";
  let initData="",body="",mediaType=null,file=null;
  if(contentType.includes("multipart/form-data")){
   const form=await request.formData();
   initData=String(form.get("initData")||"");
   body=String(form.get("message")||"").trim();
   file=form.get("media");
  }else{
   const data=await request.json().catch(()=>({}));
   initData=String(data.initData||"");body=String(data.message||"").trim();
  }
  const auth=await authorizeAdmin(initData,env,"security");
  if(!auth.ok)return adminAuthResponse(auth);
  if(!auth.owner)return json({success:false,error:"OWNER_ONLY"},403);
  if(body.length>4000)return json({success:false,error:"MESSAGE_TOO_LONG"},400);
  if(!body&&!file)return json({success:false,error:"EMPTY_POST"},400);
  let fileId=null;
  if(file&&typeof file==="object"&&typeof file.arrayBuffer==="function"&&file.size>0){
   if(file.size>50*1024*1024)return json({success:false,error:"MEDIA_TOO_LARGE"},413);
   if(file.type.startsWith("image/"))mediaType="photo";
   else if(file.type.startsWith("video/"))mediaType="video";
   else return json({success:false,error:"UNSUPPORTED_MEDIA"},400);
   const upload=new FormData();upload.append("chat_id",String(env.TELEGRAM_ADMIN_ID));upload.append(mediaType,file,file.name||("oxide-post."+(mediaType==="photo"?"jpg":"mp4")));
   const response=await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${mediaType==="photo"?"sendPhoto":"sendVideo"}`,{method:"POST",body:upload});
   const result=await response.json().catch(()=>({}));
   if(!response.ok||!result.ok)throw new Error(result.description||"MEDIA_UPLOAD_FAILED");
   const sent=result.result;
   fileId=mediaType==="photo"?sent.photo?.[sent.photo.length-1]?.file_id:sent.video?.file_id;
   if(!fileId)throw new Error("MEDIA_FILE_ID_MISSING");
   // Remove the staging message from the administrator chat after obtaining Telegram's reusable file_id.
   await telegram(env.TELEGRAM_BOT_TOKEN,"deleteMessage",{chat_id:env.TELEGRAM_ADMIN_ID,message_id:sent.message_id}).catch(()=>{});
  }
  await ensure(env.DB);
  const now=Math.floor(Date.now()/1000);
  const created=await env.DB.prepare("INSERT INTO oxide_broadcast_jobs(body,media_type,media_file_id,status,created_at) VALUES(?,?,?,'queued',?)")
   .bind(body,mediaType,fileId,now).run();
  const jobId=Number(created.meta?.last_row_id||0);
  if(!jobId)return json({success:false,error:"BROADCAST_JOB_CREATE_FAILED"},500);
  const task=runBroadcast(env,jobId,body,mediaType,fileId);
  if(typeof waitUntil==="function")waitUntil(task);
  else await task;
  const total=await env.DB.prepare("SELECT COUNT(DISTINCT ti.telegram_user_id) AS total FROM telegram_identities ti INNER JOIN users u ON u.user_uuid=ti.user_uuid WHERE u.status='active'").first();
  return json({success:true,jobId,total:Number(total?.total||0),status:"queued"});
 }catch(error){return json({success:false,error:"BROADCAST_FAILED",detail:String(error?.message||"").slice(0,180)},500);}
}
export async function onRequestGet({request,env}){
 try{
  const url=new URL(request.url),initData=url.searchParams.get("initData")||"";
  const auth=await authorizeAdmin(initData,env,"security");
  if(!auth.ok)return adminAuthResponse(auth);
  if(!auth.owner)return json({success:false,error:"OWNER_ONLY"},403);
  await ensure(env.DB);
  const job=await env.DB.prepare("SELECT id,status,total,sent,failed,created_at,finished_at FROM oxide_broadcast_jobs ORDER BY id DESC LIMIT 1").first();
  return json({success:true,job:job||null});
 }catch{return json({success:false,error:"BROADCAST_STATUS_FAILED"},500);}
}
