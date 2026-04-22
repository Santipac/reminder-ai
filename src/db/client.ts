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
      phone TEXT,
      business_scoped_user_id TEXT,
      parent_business_scoped_user_id TEXT,
      username TEXT,
      message TEXT NOT NULL,
      scheduled_at TEXT NOT NULL,
      sent_at TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      raw_input TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);

  const info = await client.execute(`PRAGMA table_info(reminders)`);
  const cols = new Map<string, { notnull: number }>();
  for (const row of info.rows as unknown as Array<{ name: string; notnull: number }>) {
    cols.set(row.name, { notnull: row.notnull });
  }

  const addIfMissing: Array<[string, string]> = [
    ['business_scoped_user_id', 'TEXT'],
    ['parent_business_scoped_user_id', 'TEXT'],
    ['username', 'TEXT'],
  ];
  for (const [name, type] of addIfMissing) {
    if (!cols.has(name)) {
      await client.execute(`ALTER TABLE reminders ADD COLUMN ${name} ${type}`);
    }
  }

  // Drop NOT NULL from phone by rebuilding the table (SQLite can't ALTER a constraint in place).
  if (cols.get('phone')?.notnull === 1) {
    await client.batch(
      [
        `CREATE TABLE reminders_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
          phone TEXT,
          business_scoped_user_id TEXT,
          parent_business_scoped_user_id TEXT,
          username TEXT,
          message TEXT NOT NULL,
          scheduled_at TEXT NOT NULL,
          sent_at TEXT,
          status TEXT NOT NULL DEFAULT 'pending',
          raw_input TEXT NOT NULL,
          created_at TEXT NOT NULL
        )`,
        `INSERT INTO reminders_new (
           id, phone, business_scoped_user_id, parent_business_scoped_user_id, username,
           message, scheduled_at, sent_at, status, raw_input, created_at
         )
         SELECT
           id, phone, business_scoped_user_id, parent_business_scoped_user_id, username,
           message, scheduled_at, sent_at, status, raw_input, created_at
         FROM reminders`,
        `DROP TABLE reminders`,
        `ALTER TABLE reminders_new RENAME TO reminders`,
      ],
      'write',
    );
  }

  await client.execute(`
    CREATE INDEX IF NOT EXISTS idx_reminders_pending
    ON reminders (status, scheduled_at)
  `);

  await client.execute(`
    CREATE INDEX IF NOT EXISTS idx_reminders_bsuid
    ON reminders (business_scoped_user_id)
  `);
}
