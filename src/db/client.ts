import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client/web';
import type { Env } from '../index';

// Cached per Worker instance
let db: ReturnType<typeof drizzle> | null = null;

export function getDb(env: Env) {
  if (!db) {
    const client = createClient({
      url: env.TURSO_DATABASE_URL,
      authToken: env.TURSO_AUTH_TOKEN,
    });
    db = drizzle(client);
  }
  return db;
}

export async function ensureSchema(env: Env): Promise<void> {
  const client = createClient({
    url: env.TURSO_DATABASE_URL,
    authToken: env.TURSO_AUTH_TOKEN,
  });

  await client.execute(`
    CREATE TABLE IF NOT EXISTS reminders (
      id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
      phone TEXT NOT NULL,
      message TEXT NOT NULL,
      scheduled_at TEXT NOT NULL,
      sent_at TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      raw_input TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);

  await client.execute(`
    CREATE INDEX IF NOT EXISTS idx_reminders_pending
    ON reminders (status, scheduled_at)
  `);
}
