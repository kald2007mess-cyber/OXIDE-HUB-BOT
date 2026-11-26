import { authorizeAdmin, adminAuthResponse } from "../_lib/admin-auth.js";

function json(data,status=200){return new Response(JSON.stringify(data),{status,headers:{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"}});}

export async function onRequestPost({request,env}){
 try{
  if(!env.DB)return json({success:false,error:"DATABASE_NOT_CONFIGURED"},500);
  const body=await request.json().catch(()=>({}));
  const auth=await authorizeAdmin(String(body.initData||""),env,"security");
  if(!auth.ok)return adminAuthResponse(auth);
  if(!auth.owner)return json({success:false,error:"OWNER_ONLY"},403);
  const code=String(body.code||"").trim().toUpperCase();
  const giftCount=Number(body.giftCount);
  const coins=Number(body.coins);
  const benefitType=String(body.benefitType||"coins")==="go_free"?"go_free":"coins";
  if(!/^[A-Z0-9_-]{4,32}$/.test(code))return json({success:false,error:"INVALID_CODE"},400);
  if(!Number.isSafeInteger(giftCount)||giftCount<1||giftCount>1000000)return json({success:false,error:"INVALID_GIFT_COUNT"},400);
  if(benefitType==="coins"&&(!Number.isSafeInteger(coins)||coins<1||coins>100000000))return json({success:false,error:"INVALID_COINS"},400);
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS oxide_redeem_codes(
   id INTEGER PRIMARY KEY AUTOINCREMENT,code TEXT NOT NULL UNIQUE,
   gift_count INTEGER NOT NULL,coins INTEGER NOT NULL,benefit_type TEXT NOT NULL DEFAULT 'coins',used_count INTEGER NOT NULL DEFAULT 0,
   active INTEGER NOT NULL DEFAULT 1,created_at INTEGER NOT NULL,expires_at INTEGER
  )`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS oxide_redeem_claims(
   id INTEGER PRIMARY KEY AUTOINCREMENT,code_id INTEGER NOT NULL,user_uuid TEXT NOT NULL,
   claim_token TEXT NOT NULL UNIQUE,claimed_at INTEGER NOT NULL,
   UNIQUE(code_id,user_uuid)
  )`).run();
  try{await env.DB.prepare("ALTER TABLE oxide_redeem_codes ADD COLUMN expires_at INTEGER").run();}catch(error){if(!/duplicate column/i.test(String(error?.message||"")))throw error;}
  try{await env.DB.prepare("ALTER TABLE oxide_redeem_codes ADD COLUMN benefit_type TEXT NOT NULL DEFAULT 'coins'").run();}catch(error){if(!/duplicate column/i.test(String(error?.message||"")))throw error;}
  const expiryHours=Number(body.expiryHours);
  if(!Number.isSafeInteger(expiryHours)||expiryHours<1||expiryHours>8760)return json({success:false,error:"INVALID_EXPIRY_HOURS"},400);
  const now=Math.floor(Date.now()/1000),expiresAt=now+expiryHours*3600;
  await env.DB.prepare("INSERT INTO oxide_redeem_codes(code,gift_count,coins,benefit_type,created_at,expires_at) VALUES(?,?,?,?,?,?)")
   .bind(code,giftCount,benefitType==="go_free"?0:coins,benefitType,now,expiresAt).run();
  return json({success:true,code,giftCount,coins:benefitType==="go_free"?0:coins,benefitType,expiryHours,expiresAt});
 }catch(error){
  const message=String(error?.message||"");
  if(/UNIQUE constraint failed.*code/i.test(message))return json({success:false,error:"CODE_ALREADY_EXISTS"},409);
  return json({success:false,error:"CREATE_REDEEM_CODE_FAILED"},500);
 }
}


export async function onRequestGet({request,env}){
 try{
  if(!env.DB)return json({success:false,error:"DATABASE_NOT_CONFIGURED"},500);
  const url=new URL(request.url);
  const auth=await authorizeAdmin(url.searchParams.get("initData")||"",env,"security");
  if(!auth.ok)return adminAuthResponse(auth);
  if(!auth.owner)return json({success:false,error:"OWNER_ONLY"},403);
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS oxide_redeem_codes(
   id INTEGER PRIMARY KEY AUTOINCREMENT,code TEXT NOT NULL UNIQUE,
   gift_count INTEGER NOT NULL,coins INTEGER NOT NULL,benefit_type TEXT NOT NULL DEFAULT 'coins',used_count INTEGER NOT NULL DEFAULT 0,
   active INTEGER NOT NULL DEFAULT 1,created_at INTEGER NOT NULL,expires_at INTEGER
  )`).run();
  try{await env.DB.prepare("ALTER TABLE oxide_redeem_codes ADD COLUMN benefit_type TEXT NOT NULL DEFAULT 'coins'").run();}catch(error){if(!/duplicate column/i.test(String(error?.message||"")))throw error;}
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS oxide_redeem_claims(
   id INTEGER PRIMARY KEY AUTOINCREMENT,code_id INTEGER NOT NULL,user_uuid TEXT NOT NULL,
   claim_token TEXT NOT NULL UNIQUE,claimed_at INTEGER NOT NULL,
   UNIQUE(code_id,user_uuid)
  )`).run();
  try{await env.DB.prepare("ALTER TABLE oxide_redeem_codes ADD COLUMN expires_at INTEGER").run();}catch(error){if(!/duplicate column/i.test(String(error?.message||"")))throw error;}
  const codeId=Number(url.searchParams.get("codeId")||0);
  if(codeId>0){
   const code=await env.DB.prepare("SELECT id,code,gift_count AS giftCount,coins,benefit_type AS benefitType,used_count AS usedCount,active,created_at AS createdAt,expires_at AS expiresAt FROM oxide_redeem_codes WHERE id=?").bind(codeId).first();
   if(!code)return json({success:false,error:"CODE_NOT_FOUND"},404);
   const users=await env.DB.prepare(`SELECT u.public_id AS id,u.user_uuid AS userUuid,u.points,
     p.first_name AS firstName,p.last_name AS lastName,p.username,p.photo_url AS photoUrl
     FROM oxide_redeem_claims c
     JOIN users u ON u.user_uuid=c.user_uuid
     LEFT JOIN oxide_profiles p ON p.user_uuid=u.user_uuid
     WHERE c.code_id=? ORDER BY c.claimed_at DESC`).bind(codeId).all();
   return json({success:true,code,users:users.results||[]});
  }
  const rows=await env.DB.prepare(`SELECT id,code,gift_count AS giftCount,coins,benefit_type AS benefitType,
    used_count AS usedCount,active,created_at AS createdAt,expires_at AS expiresAt
    FROM oxide_redeem_codes ORDER BY created_at DESC,id DESC LIMIT 200`).all();
  return json({success:true,codes:rows.results||[],now:Math.floor(Date.now()/1000)});
 }catch(error){
  console.error("Admin redeem codes list error:",error);
  return json({success:false,error:"LOAD_REDEEM_CODES_FAILED"},500);
 }
}
