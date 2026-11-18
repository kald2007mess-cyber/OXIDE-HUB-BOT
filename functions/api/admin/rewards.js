import { authorizeAdmin, adminAuthResponse } from "../_lib/admin-auth.js";

function json(data,status=200){return new Response(JSON.stringify(data),{status,headers:{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"}});}
async function ensureTable(DB){
 await DB.prepare(`CREATE TABLE IF NOT EXISTS oxide_notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,user_id TEXT NOT NULL,type TEXT NOT NULL,
  title TEXT NOT NULL,body TEXT NOT NULL DEFAULT '',reward_points INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,read_at INTEGER,claimed_at INTEGER,claim_token TEXT
 )`).run();
 await DB.prepare(`CREATE INDEX IF NOT EXISTS idx_oxide_notifications_user ON oxide_notifications(user_id, created_at DESC)`).run();
}
function normalizePublicId(value){return String(value||"").trim().toUpperCase();}
async function findRewardUser(DB,target){
 const exact=await DB.prepare(`
  SELECT v.user_id FROM visitors v
  INNER JOIN users u ON u.user_uuid = v.user_id
  WHERE UPPER(u.public_id) = ?
  LIMIT 2
 `).bind(target).all();
 if(exact.results?.length===1)return exact.results[0].user_id;
 if(exact.results?.length>1)return null;
 const legacy=target.match(/^OX-([A-F0-9]{8})$/);
 if(!legacy)return undefined;
 const matches=await DB.prepare(`
  SELECT user_id FROM visitors
  WHERE UPPER(SUBSTR(REPLACE(user_id,'-',''),1,8)) = ?
  LIMIT 2
 `).bind(legacy[1]).all();
 if(matches.results?.length===1)return matches.results[0].user_id;
 return matches.results?.length>1?null:undefined;
}
export async function onRequestPost({request,env}){
 try{
  if(!env.DB)return json({success:false,error:"DATABASE_NOT_CONFIGURED"},500);
  const body=await request.json();
  const auth=await authorizeAdmin(String(body.initData||""),env,"security");
  if(!auth.ok)return adminAuthResponse(auth);
  await ensureTable(env.DB);
  const points=Number(body.points);
  const title=String(body.title||"🎁 مكافأة جديدة").trim().slice(0,120);
  const message=String(body.message||"لديك مكافأة جديدة جاهزة للاستلام.").trim().slice(0,500);
  const target=String(body.target||"all").trim();
  if(!Number.isSafeInteger(points)||points<1||points>1000000)return json({success:false,error:"INVALID_REWARD_POINTS"},400);
  if(!title)return json({success:false,error:"INVALID_TITLE"},400);
  const now=Math.floor(Date.now()/1000);
  if(target==="all"){
   const result=await env.DB.prepare(`
    INSERT INTO oxide_notifications(user_id,type,title,body,reward_points,created_at)
    SELECT user_id,'reward',?,?,?,? FROM visitors
   `).bind(title,message,points,now).run();
   return json({success:true,sent:Number(result.meta?.changes||0),target:"all"});
  }
  const normalizedTarget=normalizePublicId(target);
  if(!/^OX-(?:\d{5,20}|[A-F0-9]{8})$/.test(normalizedTarget))return json({success:false,error:"INVALID_USER_ID"},400);
  const userId=await findRewardUser(env.DB,normalizedTarget);
  if(userId===null)return json({success:false,error:"USER_ID_AMBIGUOUS"},404);
  if(!userId)return json({success:false,error:"USER_NOT_FOUND"},404);
  await env.DB.prepare(`
   INSERT INTO oxide_notifications(user_id,type,title,body,reward_points,created_at)
   VALUES(?,'reward',?,?,?,?)
  `).bind(userId,title,message,points,now).run();
  return json({success:true,sent:1,target:"user"});
 }catch(error){return json({success:false,error:"ADMIN_REWARD_SEND_FAILED"},500);}
}
