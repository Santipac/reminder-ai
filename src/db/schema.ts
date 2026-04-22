import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const reminders = sqliteTable('reminders', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  phone: text('phone'),
  businessScopedUserId: text('business_scoped_user_id'),
  parentBusinessScopedUserId: text('parent_business_scoped_user_id'),
  username: text('username'),
  message: text('message').notNull(),
  scheduledAt: text('scheduled_at').notNull(),
  sentAt: text('sent_at'),
  status: text('status').notNull().default('pending'), // pending | sent | failed | cancelled
  rawInput: text('raw_input').notNull(),
  createdAt: text('created_at').notNull(),
});

export type Reminder = typeof reminders.$inferSelect;
export type NewReminder = typeof reminders.$inferInsert;
