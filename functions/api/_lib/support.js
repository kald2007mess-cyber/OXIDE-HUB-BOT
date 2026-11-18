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
  // Upgrade databases that already contain an older support_conversations table.
  // CREATE TABLE IF NOT EXISTS does not add columns to an existing table.
  const conversationColumns = await DB.prepare("PRAGMA table_info(support_conversations)").all();
  const knownConversationColumns = new Set((conversationColumns.results || []).map(column => column.name));
  if (!knownConversationColumns.has("user_id")) {
    await DB.prepare("ALTER TABLE support_conversations ADD COLUMN user_id TEXT").run();
  }
  if (!knownConversationColumns.has("status")) {
    await DB.prepare("ALTER TABLE support_conversations ADD COLUMN status TEXT NOT NULL DEFAULT 'open'").run();
  }
  if (!knownConversationColumns.has("created_at")) {
    await DB.prepare("ALTER TABLE support_conversations ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0").run();
  }
  if (!knownConversationColumns.has("updated_at")) {
    await DB.prepare("ALTER TABLE support_conversations ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0").run();
  }
  await DB.prepare(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_support_conversations_user
    ON support_conversations(user_id)
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
  const messageColumns = await DB.prepare("PRAGMA table_info(support_messages)").all();
  const knownMessageColumns = new Set((messageColumns.results || []).map(column => column.name));
  if (!knownMessageColumns.has("media_file_id")) {
    await DB.prepare("ALTER TABLE support_messages ADD COLUMN media_file_id TEXT").run();
  }
  if (!knownMessageColumns.has("telegram_chat_id")) {
    await DB.prepare("ALTER TABLE support_messages ADD COLUMN telegram_chat_id TEXT").run();
  }
  if (!knownMessageColumns.has("telegram_message_id")) {
    await DB.prepare("ALTER TABLE support_messages ADD COLUMN telegram_message_id INTEGER").run();
  }
  await DB.prepare(`
    CREATE INDEX IF NOT EXISTS idx_support_messages_conversation
    ON support_messages(conversation_id, id)
  `).run();
  await DB.prepare(`
    CREATE INDEX IF NOT EXISTS idx_support_conversations_updated
    ON support_conversations(updated_at DESC)
  `).run();
}
