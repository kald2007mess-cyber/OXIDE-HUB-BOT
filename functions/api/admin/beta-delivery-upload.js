import { authorizeAdmin, adminAuthResponse } from "../_lib/admin-auth.js";

const OFFERS = new Set(["beta","android","ios"]);
const MAX_SIZE = 3 * 1024 * 1024 * 1024;
const PART_SIZE = 16 * 1024 * 1024;


function out(data,status=200){return new Response(JSON.stringify(data),{status,headers:{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"}});}
function safeName(value){const raw=String(value||"file");return [...raw].filter(ch=>ch.charCodeAt(0)>=32&&ch!=="/"&&ch!==String.fromCharCode(92)).join("").slice(0,160)||"file";}
async function ensure(DB){
 await DB.prepare("CREATE TABLE IF NOT EXISTS platform_delivery_config (offer TEXT PRIMARY KEY, message TEXT NOT NULL DEFAULT '', files_json TEXT NOT NULL DEFAULT '[]', updated_at INTEGER NOT NULL DEFAULT 0)").run();
 const cols=await DB.prepare("PRAGMA table_info(platform_delivery_config)").all();if(!(cols.results||[]).some(c=>c.name==="published"))await DB.prepare("ALTER TABLE platform_delivery_config ADD COLUMN published INTEGER NOT NULL DEFAULT 1").run();
 await DB.prepare("CREATE TABLE IF NOT EXISTS platform_delivery_uploads (upload_id TEXT PRIMARY KEY, r2_key TEXT NOT NULL UNIQUE, offer TEXT NOT NULL, file_name TEXT NOT NULL, file_size INTEGER NOT NULL, content_type TEXT NOT NULL, parts_json TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'uploading', created_at INTEGER NOT NULL, completed_at INTEGER NOT NULL DEFAULT 0)").run();
 for(const offer of OFFERS) await DB.prepare("INSERT OR IGNORE INTO platform_delivery_config(offer,message,files_json,updated_at) VALUES(?, '', '[]', 0)").bind(offer).run();
}
async function auth(request,env,body){const initData=String(body?.initData||request.headers.get("X-Telegram-Init-Data")||"");return authorizeAdmin(initData,env,"platform_files");}
function validOffer(v){const offer=String(v||"").toLowerCase();return OFFERS.has(offer)?offer:null;}
function expectedPartSize(size,partNumber){const offset=(partNumber-1)*PART_SIZE;return Math.min(PART_SIZE,size-offset);}
export async function onRequestPost({request,env}){
 try{
  if(!env.DB||!env.PLATFORM_MEDIA||!env.SESSION_SECRET)return out({success:false,error:"R2_OR_DATABASE_BINDING_MISSING"},500);
  const body=await request.json().catch(()=>({}));const permission=await auth(request,env,body);if(!permission.ok)return adminAuthResponse(permission);
  await ensure(env.DB);
  const offer=validOffer(body.offer);if(!offer)return out({success:false,error:"INVALID_OFFER"},400);
  if(body.action==="init"){
   const size=Number(body.size),name=safeName(body.name),contentType=String(body.contentType||"application/octet-stream").slice(0,120);
   if(!Number.isSafeInteger(size)||size<1||size>MAX_SIZE)return out({success:false,error:"FILE_SIZE_LIMIT",maxBytes:MAX_SIZE},400);
   const existing=await env.DB.prepare("SELECT COUNT(*) AS total FROM platform_delivery_uploads WHERE offer=? AND status='completed' AND created_at>?").bind(offer,Math.floor(Date.now()/1000)-86400).first();
   const key="platform-delivery/"+offer+"/"+crypto.randomUUID()+"/"+name;
   const mpu=await env.PLATFORM_MEDIA.createMultipartUpload(key,{httpMetadata:{contentType}});
   const now=Math.floor(Date.now()/1000);
   await env.DB.prepare("INSERT INTO platform_delivery_uploads(upload_id,r2_key,offer,file_name,file_size,content_type,parts_json,status,created_at) VALUES(?,?,?,?,?,?, '[]','uploading',?)").bind(mpu.uploadId,key,offer,name,size,contentType,now).run();
   return out({success:true,uploadId:mpu.uploadId,key,partSize:PART_SIZE,totalParts:Math.ceil(size/PART_SIZE)});
  }
  if(body.action==="status"){
   const uploadId=String(body.uploadId||"");
   const row=await env.DB.prepare("SELECT * FROM platform_delivery_uploads WHERE upload_id=? AND offer=?").bind(uploadId,offer).first();
   if(!row)return out({success:false,error:"UPLOAD_NOT_FOUND"},404);
   const parts=JSON.parse(row.parts_json||"[]");
   if(row.status==="completed")return out({success:true,status:"completed",file:{key:row.r2_key,name:row.file_name,size:Number(row.file_size),contentType:row.content_type},parts});
   if(row.status!=="uploading")return out({success:false,error:"UPLOAD_NOT_ACTIVE"},409);
   return out({success:true,status:"uploading",uploadId:row.upload_id,key:row.r2_key,name:row.file_name,size:Number(row.file_size),contentType:row.content_type,parts,partSize:PART_SIZE,totalParts:Math.ceil(Number(row.file_size)/PART_SIZE)});
  }
  if(body.action==="complete"){
   const uploadId=String(body.uploadId||"");const row=await env.DB.prepare("SELECT * FROM platform_delivery_uploads WHERE upload_id=? AND offer=?").bind(uploadId,offer).first();
   if(!row)return out({success:false,error:"UPLOAD_NOT_FOUND"},404);
   if(row.status==="completed")return out({success:true,file:{key:row.r2_key,name:row.file_name,size:row.file_size,contentType:row.content_type}});
   const saved=JSON.parse(row.parts_json||"[]").sort((a,b)=>a.partNumber-b.partNumber);
   const supplied=Array.isArray(body.parts)?body.parts.slice().sort((a,b)=>a.partNumber-b.partNumber):[];
   const totalParts=Math.ceil(Number(row.file_size)/PART_SIZE);
   if(saved.length!==totalParts||supplied.length!==totalParts||saved.some((p,i)=>Number(p.partNumber)!==i+1||p.etag!==supplied[i]?.etag||Number(supplied[i]?.partNumber)!==i+1))return out({success:false,error:"UPLOAD_PARTS_INCOMPLETE"},400);
   const mpu=env.PLATFORM_MEDIA.resumeMultipartUpload(row.r2_key,uploadId);
   const object=await mpu.complete(saved);
   await env.DB.prepare("UPDATE platform_delivery_uploads SET status='completed',completed_at=? WHERE upload_id=?").bind(Math.floor(Date.now()/1000),uploadId).run();
   return out({success:true,file:{key:row.r2_key,name:row.file_name,size:Number(row.file_size),contentType:row.content_type,etag:object.httpEtag}});
  }
  if(body.action==="save"){
   const message=String(body.message||"").trim();if(message.length>4000)return out({success:false,error:"MESSAGE_TOO_LONG"},400);
   const keys=Array.isArray(body.fileKeys)?body.fileKeys.map(String):[];
   let files;
   if(keys.length){
    const rows=[];
    for(const key of keys){
     const row=await env.DB.prepare("SELECT r2_key,file_name,file_size,content_type,status FROM platform_delivery_uploads WHERE r2_key=? AND offer=?").bind(key,offer).first();
     if(!row||row.status!=="completed")return out({success:false,error:"UPLOAD_NOT_COMPLETE"},400);
     rows.push({key:row.r2_key,name:row.file_name,size:Number(row.file_size),contentType:row.content_type});
    }
    files=rows;
   }else{
    const old=await env.DB.prepare("SELECT files_json FROM platform_delivery_config WHERE offer=?").bind(offer).first();
    try{files=JSON.parse(old?.files_json||"[]");}catch{files=[];}
   }
   const requestedName=String(body.fileName||"").trim().replace(/[\\/\r\n\u0000-\u001f]/g,"").slice(0,160);
   if(requestedName&&files.length===1){
    const original=String(files[0].name||"file");
    const extension=(original.match(/(\\.[^.]+)$/)||[])[1]||"";
    const finalName=/\\.[^.]+$/.test(requestedName)?requestedName:requestedName+extension;
    files[0]={...files[0],name:finalName};
   }
   const now=Math.floor(Date.now()/1000);
   const previous=await env.DB.prepare("SELECT files_json FROM platform_delivery_config WHERE offer=?").bind(offer).first();
   let oldFiles=[];try{oldFiles=JSON.parse(previous?.files_json||"[]");}catch{}
   await env.DB.prepare("UPDATE platform_delivery_config SET message=?,files_json=?,published=1,updated_at=? WHERE offer=?").bind(message,JSON.stringify(files),now,offer).run();
   if(keys.length){const keep=new Set(keys);for(const oldFile of oldFiles){if(oldFile?.key&&!keep.has(oldFile.key))await env.PLATFORM_MEDIA.delete(oldFile.key).catch(()=>{});}}
   return out({success:true,offer,message,files});
  }
  if(body.action==="publish"){
   await env.DB.prepare("UPDATE platform_delivery_config SET published=1,updated_at=? WHERE offer=?").bind(Math.floor(Date.now()/1000),offer).run();
   return out({success:true,offer,published:true});
  }
  if(body.action==="abort"){
   const uploadId=String(body.uploadId||"");const row=await env.DB.prepare("SELECT r2_key,status FROM platform_delivery_uploads WHERE upload_id=? AND offer=?").bind(uploadId,offer).first();
   if(row&&row.status==="uploading"){await env.PLATFORM_MEDIA.resumeMultipartUpload(row.r2_key,uploadId).abort();await env.DB.prepare("UPDATE platform_delivery_uploads SET status='aborted' WHERE upload_id=?").bind(uploadId).run();}
   return out({success:true});
  }
  return out({success:false,error:"UNKNOWN_ACTION"},400);
 }catch(error){console.error("R2 platform upload POST failed",error);return out({success:false,error:String(error?.message||"UPLOAD_FAILED").slice(0,180)},500);}
}
export async function onRequestPut({request,env}){
 try{
  if(!env.DB||!env.PLATFORM_MEDIA||!env.SESSION_SECRET)return out({success:false,error:"R2_OR_DATABASE_BINDING_MISSING"},500);
  const url=new URL(request.url),offer=validOffer(url.searchParams.get("offer")),uploadId=String(url.searchParams.get("uploadId")||""),partNumber=Number(url.searchParams.get("partNumber"));
  const permission=await authorizeAdmin(String(request.headers.get("X-Telegram-Init-Data")||""),env,"platform_files");if(!permission.ok)return adminAuthResponse(permission);
  if(!offer||!uploadId||!Number.isInteger(partNumber)||partNumber<1||!request.body)return out({success:false,error:"INVALID_PART"},400);
  await ensure(env.DB);
  const row=await env.DB.prepare("SELECT * FROM platform_delivery_uploads WHERE upload_id=? AND offer=? AND status='uploading'").bind(uploadId,offer).first();
  if(!row)return out({success:false,error:"UPLOAD_NOT_FOUND"},404);
  const totalParts=Math.ceil(Number(row.file_size)/PART_SIZE);if(partNumber>totalParts)return out({success:false,error:"INVALID_PART_NUMBER"},400);
  const bytes=await request.arrayBuffer(),expected=expectedPartSize(Number(row.file_size),partNumber);
  if(bytes.byteLength!==expected)return out({success:false,error:"INVALID_PART_SIZE",expected,received:bytes.byteLength},400);
  const mpu=env.PLATFORM_MEDIA.resumeMultipartUpload(row.r2_key,uploadId);
  const part=await mpu.uploadPart(partNumber,bytes);
  const parts=JSON.parse(row.parts_json||"[]").filter(p=>Number(p.partNumber)!==partNumber);parts.push(part);
  await env.DB.prepare("UPDATE platform_delivery_uploads SET parts_json=? WHERE upload_id=?").bind(JSON.stringify(parts),uploadId).run();
  return out({success:true,part});
 }catch(error){console.error("R2 platform upload PUT failed",error);return out({success:false,error:String(error?.message||"PART_UPLOAD_FAILED").slice(0,180)},500);}
}
