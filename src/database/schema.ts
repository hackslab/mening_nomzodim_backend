import { pgTable, serial, text, timestamp, integer } from 'drizzle-orm/pg-core';

export const sessions = pgTable('sessions', {
  id: serial('id').primaryKey(),
  phoneNumber: text('phone_number').unique().notNull(),
  sessionString: text('session_string').notNull(),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

export const chatSessions = pgTable('chat_sessions', {
  id: serial('id').primaryKey(),
  platform: text('platform').notNull(),
  userId: text('user_id').notNull(),
  status: text('status').notNull().default('active'),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
  lastMessageAt: timestamp('last_message_at').defaultNow(),
});

export const chatMessages = pgTable('chat_messages', {
  id: serial('id').primaryKey(),
  sessionId: integer('session_id')
    .notNull()
    .references(() => chatSessions.id, { onDelete: 'cascade' }),
  role: text('role').notNull(),
  content: text('content').notNull(),
  telegramMessageId: text('telegram_message_id'),
  createdAt: timestamp('created_at').defaultNow(),
});
