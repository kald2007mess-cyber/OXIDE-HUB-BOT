
import { json } from "./_lib/session.js";

const DEFAULT_MESSAGE =
  "نعتذر عن الإزعاج، الموقع تحت الصيانة حالياً. سنعود قريباً.";

async function ensureSiteSettingsTable(DB) {
  await DB.prepare(`
    CREATE TABLE IF NOT EXISTS site_settings (
      setting_key TEXT PRIMARY KEY,
      setting_value TEXT NOT NULL DEFAULT '',
      updated_at INTEGER NOT NULL DEFAULT 0
    )
  `).run();

  const columns = await DB.prepare("PRAGMA table_info(site_settings)").all();
  const names = (columns.results || []).map(column => column.name);

  if (!names.includes("setting_key") || !names.includes("setting_value")) {
    throw new Error("SITE_SETTINGS_SCHEMA_INVALID");
  }
  if (!names.includes("updated_at")) {
    await DB.prepare("ALTER TABLE site_settings ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0").run();
  }
}

export async function onRequestGet({ env }) {
  try {
    if (!env.DB) {
      return json({ success: false, error: "DATABASE_ERROR" }, 500);
    }

    await ensureSiteSettingsTable(env.DB);

    const result = await env.DB.prepare(
      "SELECT setting_key, setting_value FROM site_settings WHERE setting_key IN (?, ?)"
    ).bind("maintenance_enabled", "maintenance_message").all();

    const settings = {};
    for (const row of result.results || []) {
      settings[row.setting_key] = row.setting_value;
    }

    return json({
      success: true,
      maintenance: settings.maintenance_enabled === "1",
      message: settings.maintenance_message || DEFAULT_MESSAGE
    });
  } catch (error) {
    console.error("Maintenance GET error:", error);
    return json({ success: false, error: "MAINTENANCE_LOAD_FAILED" }, 500);
  }
}
