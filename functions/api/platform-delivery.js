import { getVisitor } from "./_lib/session.js";

const OFFERS={beta:"beta_ads",android:"android_ads",ios:"ios_ads"};
function out(data,status=200){return new Response(JSON.stringify(data),{status,headers:{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"}});}
async function ensure(DB){await DB.prepare("CREATE TABLE IF NOT EXISTS platform_delivery_config (offer TEXT PRIMARY KEY, message TEXT NOT NULL DEFAULT '', files_json TEXT NOT NULL DEFAULT '[]', updated_at INTEGER NOT NULL DEFAULT 0)").run();}
async function authorizedUser(request,env,offer){
 const user=await getVisitor(request,env);if(!user)return{error:out({success:false,error:"NO_TELEGRAM_SESSION"},401)};
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
   const file=files[index];if(!file?.key||!String(file.key).startsWith("platform-delivery/"+offer+"/"))return out({success:false,error:"FILE_NOT_FOUND"},404);
   const object=await env.PLATFORM_MEDIA.get(file.key);if(!object)return out({success:false,error:"FILE_NOT_FOUND"},404);
   const headers=new Headers();object.writeHttpMetadata(headers);
   const type=String(file.contentType||headers.get("Content-Type")||"application/octet-stream");
   headers.set("Content-Type",type);headers.set("Content-Length",String(object.size));headers.set("Cache-Control","private, no-store");
   const safe=String(file.name||"download").replace(/[\r\n"]/g,"_");
   headers.set("Content-Disposition",(type.startsWith("image/")||type.startsWith("video/"))?"inline; filename*=UTF-8''"+encodeURIComponent(safe):"attachment; filename*=UTF-8''"+encodeURIComponent(safe));
   return new Response(object.body,{status:200,headers});
  }
  return out({success:true,offer,message:String(row?.message||""),files:files.map(f=>({name:f.name,size:Number(f.size||0),contentType:f.contentType||"application/octet-stream"}))});
 }catch(error){console.error("Platform delivery fetch failed",error);return out({success:false,error:String(error?.message||"DELIVERY_FAILED").slice(0,180)},500);}
}
