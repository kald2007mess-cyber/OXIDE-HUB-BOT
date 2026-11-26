import { getVisitor, json } from "./_lib/session.js";

async function ensureTables(DB){
 await DB.prepare(`CREATE TABLE IF NOT EXISTS oxide_redeem_codes(
  id INTEGER PRIMARY KEY AUTOINCREMENT,code TEXT NOT NULL UNIQUE,
  gift_count INTEGER NOT NULL,coins INTEGER NOT NULL,used_count INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,created_at INTEGER NOT NULL,expires_at INTEGER,benefit_type TEXT NOT NULL DEFAULT 'coins'
 )`).run();
 try{await DB.prepare("ALTER TABLE oxide_redeem_codes ADD COLUMN benefit_type TEXT NOT NULL DEFAULT 'coins'").run();}catch(error){if(!/duplicate column/i.test(String(error?.message||"")))throw error;}
 try{await DB.prepare("ALTER TABLE oxide_redeem_codes ADD COLUMN expires_at INTEGER").run();}catch(error){if(!/duplicate column/i.test(String(error?.message||"")))throw error;}
 await DB.prepare(`CREATE TABLE IF NOT EXISTS oxide_redeem_claims(
  id INTEGER PRIMARY KEY AUTOINCREMENT,code_id INTEGER NOT NULL,user_uuid TEXT NOT NULL,
  claim_token TEXT NOT NULL UNIQUE,claimed_at INTEGER NOT NULL,
  UNIQUE(code_id,user_uuid)
 )`).run();
 await DB.prepare(`CREATE TABLE IF NOT EXISTS oxide_notifications(
  id INTEGER PRIMARY KEY AUTOINCREMENT,user_id TEXT NOT NULL,type TEXT NOT NULL,
  title TEXT NOT NULL,body TEXT NOT NULL DEFAULT '',reward_points INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,read_at INTEGER,claimed_at INTEGER,claim_token TEXT
 )`).run();
 await DB.prepare(`CREATE TABLE IF NOT EXISTS oxide_go_access(user_uuid TEXT PRIMARY KEY,source_code TEXT NOT NULL,granted_at INTEGER NOT NULL)`).run();
 await DB.prepare(`CREATE TABLE IF NOT EXISTS point_ledger(
  id INTEGER PRIMARY KEY AUTOINCREMENT,user_uuid TEXT NOT NULL,delta INTEGER NOT NULL,
  balance_after INTEGER NOT NULL,reason TEXT NOT NULL,reference_type TEXT NOT NULL,
  reference_id TEXT NOT NULL,created_at INTEGER NOT NULL
 )`).run();
}

export async function onRequestPost({request,env}){
 try{
  if(!env.DB||!env.SESSION_SECRET)return json({success:false,error:"SERVER_CONFIGURATION_MISSING"},500);
  const userUuid=await getVisitor(request,env);
  if(!userUuid)return json({success:false,error:"NO_TELEGRAM_SESSION"},401);
  const user=await env.DB.prepare("SELECT user_uuid FROM users WHERE user_uuid=? AND status='active'").bind(userUuid).first();
  if(!user)return json({success:false,error:"USER_NOT_FOUND"},404);
  const body=await request.json().catch(()=>({}));
  const code=String(body.code||"").trim().toUpperCase();
  if(!/^[A-Z0-9_-]{4,32}$/.test(code))return json({success:false,error:"INVALID_CODE"},400);
  await ensureTables(env.DB);
  const now=Math.floor(Date.now()/1000),token=crypto.randomUUID();
  const result=await env.DB.batch([
   env.DB.prepare(`INSERT OR IGNORE INTO oxide_redeem_claims(code_id,user_uuid,claim_token,claimed_at)
    SELECT id,?,?,? FROM oxide_redeem_codes
    WHERE code=? AND active=1 AND used_count<gift_count
      AND (expires_at IS NULL OR expires_at>?)
      AND NOT EXISTS(SELECT 1 FROM oxide_redeem_claims c WHERE c.code_id=oxide_redeem_codes.id AND c.user_uuid=?)
   `).bind(userUuid,token,now,code,now,userUuid),
   env.DB.prepare(`UPDATE oxide_redeem_codes SET used_count=used_count+1
    WHERE EXISTS(SELECT 1 FROM oxide_redeem_claims WHERE claim_token=?)
   `).bind(token),
   env.DB.prepare(`INSERT OR IGNORE INTO oxide_go_access(user_uuid,source_code,granted_at) SELECT r.user_uuid,c.code,? FROM oxide_redeem_claims r JOIN oxide_redeem_codes c ON c.id=r.code_id WHERE r.claim_token=? AND c.benefit_type='go_free'`).bind(now,token),
   env.DB.prepare(`INSERT INTO oxide_notifications(user_id,type,title,body,reward_points,created_at)
    SELECT r.user_uuid,'redeem_code','🎁 مكافأة رمز استرداد',
      'تم استرداد الرمز '||c.code||' بنجاح.'||CASE WHEN c.benefit_type='go_free' THEN ' تم فتح GO دون إعلانات.' ELSE ' اضغط زر استلام لإضافة المكافأة إلى رصيدك.' END,
      c.coins,?
    FROM oxide_redeem_claims r JOIN oxide_redeem_codes c ON c.id=r.code_id
    WHERE r.claim_token=?
   `).bind(now,token)
  ]);
  const inserted=Number(result?.[0]?.meta?.changes||0);
  if(!inserted){
   const existing=await env.DB.prepare(`SELECT c.gift_count,c.used_count,c.expires_at,
    EXISTS(SELECT 1 FROM oxide_redeem_claims r WHERE r.code_id=c.id AND r.user_uuid=?) AS claimed
    FROM oxide_redeem_codes c WHERE c.code=? AND c.active=1
   `).bind(userUuid,code).first();
   if(!existing)return json({success:false,error:"CODE_NOT_FOUND"},404);
   if(Number(existing.claimed))return json({success:false,error:"CODE_ALREADY_REDEEMED"},409);
   if(existing.expires_at!==null&&existing.expires_at!==undefined&&Number(existing.expires_at)<=now)return json({success:false,error:"CODE_EXPIRED"},410);
   if(Number(existing.used_count)>=Number(existing.gift_count))return json({success:false,error:"CODE_EXHAUSTED"},409);
   return json({success:false,error:"CODE_NOT_AVAILABLE"},409);
  }
  const reward=await env.DB.prepare("SELECT coins,benefit_type FROM oxide_redeem_codes WHERE code=?").bind(code).first();
  return json({success:true,coins:Number(reward?.coins||0),benefitType:String(reward?.benefit_type||"coins"),goAccess:reward?.benefit_type==="go_free",notificationCreated:true});
 }catch(error){return json({success:false,error:"REDEEM_CODE_FAILED"},500);}
}
