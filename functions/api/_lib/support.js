export async function ensureSupportTables(DB) {
  await DB.prepare(`
    CREATE TABLE IF NOT EXISTS support_conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'open',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `).run();
  await DB.prepare(`
    CREATE TABLE IF NOT EXISTS support_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id INTEGER NOT NULL,
      sender TEXT NOT NULL,
      message_type TEXT NOT NULL DEFAULT 'text',
      message_text TEXT NOT NULL DEFAULT '',
      media_file_id TEXT,
      created_at INTEGER NOT NULL,
      telegram_chat_id TEXT,
      telegram_message_id INTEGER
    )
  `).run();
  await DB.prepare(`
    CREATE INDEX IF NOT EXISTS idx_support_messages_conversation
    ON support_messages(conversation_id, id)
  `).run();
  await DB.prepare(`
    CREATE INDEX IF NOT EXISTS idx_support_conversations_updated
    ON support_conversations(updated_at DESC)
  `).run();
}
