import { getVisitor, json } from "./_lib/session.js";

export async function onRequestGet({ request, env }) {
  try {
    if (!env.DB || !env.SESSION_SECRET || !env.TELEGRAM_BOT_TOKEN) {
      return json({ success: false, error: "AVATAR_CONFIGURATION_MISSING" }, 500);
    }
    const userId = await getVisitor(request, env);
    if (!userId) return json({ success: false, error: "NO_TELEGRAM_SESSION" }, 401);
    const profile = await env.DB.prepare(
      "SELECT telegram_user_id FROM oxide_profiles WHERE user_uuid = ? LIMIT 1"
    ).bind(userId).first();
    if (!profile?.telegram_user_id) return new Response("Avatar unavailable", { status: 404 });

    const photosResponse = await fetch(
      "https://api.telegram.org/bot" + env.TELEGRAM_BOT_TOKEN +
      "/getUserProfilePhotos?user_id=" + encodeURIComponent(profile.telegram_user_id) + "&limit=1"
    );
    const photosData = await photosResponse.json();
    const fileId = photosData?.result?.photos?.[0]?.slice(-1)?.[0]?.file_id;
    if (!photosData?.ok || !fileId) return new Response("Avatar unavailable", { status: 404 });

    const fileResponse = await fetch("https://api.telegram.org/bot" + env.TELEGRAM_BOT_TOKEN + "/getFile?file_id=" + encodeURIComponent(fileId));
    const fileData = await fileResponse.json();
    const filePath = fileData?.result?.file_path;
    if (!fileData?.ok || !filePath) return new Response("Avatar unavailable", { status: 404 });

    const imageResponse = await fetch("https://api.telegram.org/file/bot" + env.TELEGRAM_BOT_TOKEN + "/" + filePath);
    if (!imageResponse.ok) return new Response("Avatar unavailable", { status: 404 });
    const headers = new Headers();
    headers.set("Content-Type", imageResponse.headers.get("Content-Type") || "image/jpeg");
    headers.set("Cache-Control", "private, max-age=3600");
    headers.set("X-Content-Type-Options", "nosniff");
    return new Response(imageResponse.body, { status: 200, headers });
  } catch (error) {
    console.error("Telegram avatar retrieval failed:", error);
    return new Response("Avatar unavailable", { status: 404 });
  }
}
