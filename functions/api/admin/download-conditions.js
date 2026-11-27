import { authorizeAdmin, adminAuthResponse } from "../_lib/admin-auth.js";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
  });
}

async function ensureTable(DB) {
  await DB.prepare(`CREATE TABLE IF NOT EXISTS platform_download_channels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    join_url TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`).run();
  await DB.prepare(`
    INSERT INTO platform_download_channels(title,chat_id,join_url,enabled,created_at,updated_at)
    SELECT 'OXIDE HUB','@OxideHubOfficial','https://t.me/OxideHubOfficial',1,?,?
    WHERE NOT EXISTS (SELECT 1 FROM platform_download_channels)
  `).bind(Math.floor(Date.now()/1000),Math.floor(Date.now()/1000)).run();
}

async function list(DB) {
  const result = await DB.prepare(`
    SELECT id,title,chat_id,join_url,enabled,created_at,updated_at
    FROM platform_download_channels ORDER BY id ASC
  `).all();
  return result.results || [];
}

export async function onRequestPost({ request, env }) {
  try {
    if (!env.DB) return json({ success:false,error:"DATABASE_NOT_CONFIGURED" },500);
    const body = await request.json().catch(() => ({}));
    const auth = await authorizeAdmin(String(body.initData || ""), env);
    if (!auth.ok) return adminAuthResponse(auth);
    if (!auth.owner) return json({ success:false,error:"OWNER_ONLY" },403);
    await ensureTable(env.DB);

    const action = String(body.action || "list");
    if (action === "list") return json({ success:true,channels:await list(env.DB) });

    if (action === "save") {
      const id = Number(body.id || 0);
      const title = String(body.title || "").trim().slice(0,100);
      const chatId = String(body.chat_id || "").trim().slice(0,100);
      const joinUrl = String(body.join_url || "").trim().slice(0,300);
      const enabled = Number(body.enabled) === 0 ? 0 : 1;
      if (!title || !/^(@[A-Za-z0-9_]{5,}|-100\\d{5,})$/.test(chatId) ||
          !/^https:\\/\\/t\\.me\\/[A-Za-z0-9_+/?=-]+$/i.test(joinUrl)) {
        return json({ success:false,error:"INVALID_CHANNEL_DATA" },400);
      }
      const now = Math.floor(Date.now()/1000);
      if (id > 0) {
        const result = await env.DB.prepare(`
          UPDATE platform_download_channels
          SET title=?,chat_id=?,join_url=?,enabled=?,updated_at=?
          WHERE id=?
        `).bind(title,chatId,joinUrl,enabled,now,id).run();
        if (Number(result.meta?.changes || 0) !== 1) return json({success:false,error:"CHANNEL_NOT_FOUND"},404);
      } else {
        await env.DB.prepare(`
          INSERT INTO platform_download_channels(title,chat_id,join_url,enabled,created_at,updated_at)
          VALUES(?,?,?,?,?,?)
        `).bind(title,chatId,joinUrl,enabled,now,now).run();
      }
      return json({success:true,channels:await list(env.DB)});
    }

    if (action === "delete") {
      const id = Number(body.id);
      if (!Number.isSafeInteger(id) || id < 1) return json({success:false,error:"INVALID_CHANNEL_ID"},400);
      const result = await env.DB.prepare("DELETE FROM platform_download_channels WHERE id=?").bind(id).run();
      if (Number(result.meta?.changes || 0) !== 1) return json({success:false,error:"CHANNEL_NOT_FOUND"},404);
      return json({success:true,channels:await list(env.DB)});
    }
    return json({success:false,error:"INVALID_ACTION"},400);
  } catch (error) {
    console.error("Download channel conditions API failed:",error);
    return json({success:false,error:"DOWNLOAD_CONDITIONS_FAILED"},500);
  }
}
