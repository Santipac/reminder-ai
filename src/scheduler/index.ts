import { and, eq, lte } from 'drizzle-orm';
import { getDb, ensureSchema } from '../db/client';
import { reminders } from '../db/schema';
import { sendWhatsAppMessage } from '../services/kapso';
import { generatePersonalizedReminder } from '../services/openai';
import type { Env } from '../index';

/**
 * Runs once per cron trigger (every minute via wrangler.toml).
 * Sends all pending reminders that are due.
 */
export async function runScheduler(env: Env): Promise<void> {
  // Ensure table exists on first run
  await ensureSchema(env);

  const db = getDb(env);
  const now = new Date().toISOString();

  const due = await db
    .select()
    .from(reminders)
    .where(and(eq(reminders.status, 'pending'), lte(reminders.scheduledAt, now)));

  if (due.length === 0) return;

  console.log(`[scheduler] Sending ${due.length} due reminder(s)`);

  for (const reminder of due) {
    try {
      const personalizedMessage = await generatePersonalizedReminder(reminder.message, env);
      await sendWhatsAppMessage(reminder.phone, personalizedMessage, env);

      await db
        .update(reminders)
        .set({ status: 'sent', sentAt: new Date().toISOString() })
        .where(eq(reminders.id, reminder.id));
    } catch (err) {
      console.error(`[scheduler] Failed to send reminder #${reminder.id}:`, err);

      await db
        .update(reminders)
        .set({ status: 'failed' })
        .where(eq(reminders.id, reminder.id));
    }
  }
}
