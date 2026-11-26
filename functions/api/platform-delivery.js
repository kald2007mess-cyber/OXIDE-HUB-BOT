import { getVisitor } from "./_lib/session.js";

const OFFERS={beta:"beta_ads",android:"android_ads",ios:"ios_ads"};
function out(data,status=200){return new Response(JSON.stringify(data),{status,headers:{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"}});}
async function ensure(DB){await DB.prepare("CREATE TABLE IF NOT EXISTS platform_delivery_config (offer TEXT PRIMARY KEY, message TEXT NOT NULL DEFAULT '', files_json TEXT NOT NULL DEFAULT '[]', updated_at INTEGER NOT NULL DEFAULT 0)").run();}
function mimeFromName(name){const ext=String(name||"").toLowerCase().split(".").pop();return ({png:"image/png",jpg:"image/jpeg",jpeg:"image/jpeg",webp:"image/webp",gif:"image/gif",mp4:"video/mp4",webm:"video/webm",mov:"video/quicktime",pdf:"application/pdf",zip:"application/zip"})[ext]||"application/octet-stream";}
async function authorizedUser(request,env,offer){
 const user=await getVisitor(request,env);if(!user)return{error:out({success:false,error:"NO_TELEGRAM_SESSION"},401)};
 await env.DB.prepare("CREATE TABLE IF NOT EXISTS oxide_go_access(user_uuid TEXT PRIMARY KEY,source_code TEXT NOT NULL,granted_at INTEGER NOT NULL)").run();
 const pass=await env.DB.prepare("SELECT 1 AS allowed FROM oxide_go_access WHERE user_uuid=?").bind(user).first();
 if(pass)return{user,goAccess:true};
 const progress=await env.DB.prepare("SELECT "+OFFERS[offer]+" AS completed,cycle_started_at FROM platform_ad_progress WHERE user_id=?").bind(user).first();
 const now=Math.floor(Date.now()/1000);
 if(!progress||now-Number(progress.cycle_started_at||now)>=18000||Number(progress.completed||0)<10)return{error:out({success:false,error:"OFFER_NOT_COMPLETE"},403)};
 return{user};
}
export async function onRequestGet({request,env}){
 try{
  if(!env.DB||!env.PLATFORM_MEDIA||!env.SESSION_SECRET)return out({success:false,error:"SERVER_CONFIGURATION_MISSING"},500);
  const url=new URL(request.url),offer=String(url.searchParams.get("offer")||"").toLowerCase();if(!OFFERS[offer])return out({success:false,error:"INVALID_OFFER"},400);
  await ensure(env.DB);
  const auth=await authorizedUser(request,env,offer);if(auth.error)return auth.error;
  const row=await env.DB.prepare("SELECT message,files_json FROM platform_delivery_config WHERE offer=?").bind(offer).first();
  let files=[];try{files=JSON.parse(row?.files_json||"[]");}catch{}
  const fileIndex=url.searchParams.get("file");
  if(fileIndex!==null){
   const index=Number(fileIndex);if(!Number.isInteger(index)||index<0||index>=files.length)return out({success:false,error:"FILE_NOT_FOUND"},404);
   const file=files[index];if(!file)return out({success:false,error:"FILE_NOT_FOUND"},404);
   let body=null,size=Number(file.size||0),type=String(file.contentType||mimeFromName(file.name));
   if(file.key&&String(file.key).startsWith("platform-delivery/"+offer+"/")){
    const object=await env.PLATFORM_MEDIA.get(file.key);if(!object)return out({success:false,error:"FILE_NOT_FOUND"},404);
    const headers=new Headers();object.writeHttpMetadata(headers);body=object.body;size=object.size;type=String(file.contentType||headers.get("Content-Type")||type);
   }else if(file.file_id&&env.TELEGRAM_BOT_TOKEN){
    const metaResponse=await fetch("https://api.telegram.org/bot"+env.TELEGRAM_BOT_TOKEN+"/getFile?file_id="+encodeURIComponent(file.file_id));
    const meta=await metaResponse.json().catch(()=>({}));if(!metaResponse.ok||!meta.ok||!meta.result?.file_path)return out({success:false,error:"LEGACY_FILE_NOT_FOUND"},404);
    const fileResponse=await fetch("https://api.telegram.org/file/bot"+env.TELEGRAM_BOT_TOKEN+"/"+meta.result.file_path);
    if(!fileResponse.ok||!fileResponse.body)return out({success:false,error:"LEGACY_FILE_DOWNLOAD_FAILED"},502);
    body=fileResponse.body;size=Number(meta.result.file_size||size);
   }else return out({success:false,error:"FILE_NOT_FOUND"},404);
   const headers=new Headers();headers.set("Content-Type",type);if(size>0)headers.set("Content-Length",String(size));headers.set("Cache-Control","private, no-store");
   const safe=String(file.name||"download").replace(/[\r\n"]/g,"_");
   headers.set("Content-Disposition",(type.startsWith("image/")||type.startsWith("video/"))?"inline; filename*=UTF-8''"+encodeURIComponent(safe):"attachment; filename*=UTF-8''"+encodeURIComponent(safe));
   return new Response(body,{status:200,headers});
  }
  return out({success:true,offer,message:String(row?.message||""),files:files.map(f=>({name:f.name,size:Number(f.size||0),contentType:f.contentType||mimeFromName(f.name)}))});
 }catch(error){console.error("Platform delivery fetch failed",error);return out({success:false,error:String(error?.message||"DELIVERY_FAILED").slice(0,180)},500);}
}
