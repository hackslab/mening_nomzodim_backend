import {
  pgTable,
  serial,
  text,
  timestamp,
  integer,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

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

export const chatMessages = pgTable(
  'chat_messages',
  {
    id: serial('id').primaryKey(),
    sessionId: integer('session_id')
      .notNull()
      .references(() => chatSessions.id, { onDelete: 'cascade' }),
    role: text('role').notNull(),
    content: text('content').notNull(),
    telegramMessageId: text('telegram_message_id'),
    createdAt: timestamp('created_at').defaultNow(),
  },
  (table) => ({
    sessionTelegramIdUnique: uniqueIndex(
      'chat_messages_session_telegram_id_unique',
    ).on(table.sessionId, table.telegramMessageId),
  }),
);

export const chatSummaries = pgTable('chat_summaries', {
  id: serial('id').primaryKey(),
  sessionId: integer('session_id')
    .notNull()
    .references(() => chatSessions.id, { onDelete: 'cascade' }),
  summaryContent: text('summary_content').notNull(),
  lastProcessedMessageId: integer('last_processed_message_id').notNull(),
  createdAt: timestamp('created_at').defaultNow(),
});

export const appSettings = pgTable('app_settings', {
  id: serial('id').primaryKey(),
  summaryBatchSize: integer('summary_batch_size').notNull().default(100),
  summaryCronMinutes: integer('summary_cron_minutes').notNull().default(1),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});
