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
  if(!/^[A-Z0-9_-]{4,32}$/.test(code))return json({success:false,error:"INVALID_CODE"},400);
  if(!Number.isSafeInteger(giftCount)||giftCount<1||giftCount>1000000)return json({success:false,error:"INVALID_GIFT_COUNT"},400);
  if(!Number.isSafeInteger(coins)||coins<1||coins>100000000)return json({success:false,error:"INVALID_COINS"},400);
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS oxide_redeem_codes(
   id INTEGER PRIMARY KEY AUTOINCREMENT,code TEXT NOT NULL UNIQUE,
   gift_count INTEGER NOT NULL,coins INTEGER NOT NULL,used_count INTEGER NOT NULL DEFAULT 0,
   active INTEGER NOT NULL DEFAULT 1,created_at INTEGER NOT NULL,expires_at INTEGER
  )`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS oxide_redeem_claims(
   id INTEGER PRIMARY KEY AUTOINCREMENT,code_id INTEGER NOT NULL,user_uuid TEXT NOT NULL,
   claim_token TEXT NOT NULL UNIQUE,claimed_at INTEGER NOT NULL,
   UNIQUE(code_id,user_uuid)
  )`).run();
  try{await env.DB.prepare("ALTER TABLE oxide_redeem_codes ADD COLUMN expires_at INTEGER").run();}catch(error){if(!/duplicate column/i.test(String(error?.message||"")))throw error;}
  const expiryHours=Number(body.expiryHours);
  if(!Number.isSafeInteger(expiryHours)||expiryHours<1||expiryHours>8760)return json({success:false,error:"INVALID_EXPIRY_HOURS"},400);
  const now=Math.floor(Date.now()/1000),expiresAt=now+expiryHours*3600;
  await env.DB.prepare("INSERT INTO oxide_redeem_codes(code,gift_count,coins,created_at,expires_at) VALUES(?,?,?,?,?)")
   .bind(code,giftCount,coins,now,expiresAt).run();
  return json({success:true,code,giftCount,coins,expiryHours,expiresAt});
 }catch(error){
  const message=String(error?.message||"");
  if(/UNIQUE constraint failed.*code/i.test(message))return json({success:false,error:"CODE_ALREADY_EXISTS"},409);
  return json({success:false,error:"CREATE_REDEEM_CODE_FAILED"},500);
 }
}
