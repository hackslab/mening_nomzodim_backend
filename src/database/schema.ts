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
  systemPrompt: text('system_prompt'),
  summaryPrompt: text('summary_prompt'),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

export const adminTasks = pgTable('admin_tasks', {
  id: serial('id').primaryKey(),
  taskType: text('task_type').notNull(),
  status: text('status').notNull().default('pending'),
  sessionId: integer('session_id').references(() => chatSessions.id, {
    onDelete: 'set null',
  }),
  userId: text('user_id'),
  payload: text('payload'),
  adminMessageId: text('admin_message_id'),
  adminTopicId: integer('admin_topic_id'),
  adminActionBy: text('admin_action_by'),
  adminActionAt: timestamp('admin_action_at'),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

export const adPosts = pgTable('ad_posts', {
  id: serial('id').primaryKey(),
  taskId: integer('task_id').references(() => adminTasks.id, {
    onDelete: 'set null',
  }),
  sessionId: integer('session_id').references(() => chatSessions.id, {
    onDelete: 'set null',
  }),
  userId: text('user_id'),
  content: text('content').notNull(),
  status: text('status').notNull().default('draft'),
  publicMessageId: text('public_message_id'),
  publicStatus: text('public_status'),
  vipMessageId: text('vip_message_id'),
  vipStatus: text('vip_status'),
  archiveMessageId: text('archive_message_id'),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

export const userMedia = pgTable('user_media', {
  id: serial('id').primaryKey(),
  sessionId: integer('session_id').references(() => chatSessions.id, {
    onDelete: 'set null',
  }),
  userId: text('user_id').notNull(),
  messageId: integer('message_id').notNull(),
  archiveGroupId: text('archive_group_id'),
  archiveTopicId: integer('archive_topic_id'),
  archiveMessageId: integer('archive_message_id'),
  mediaType: text('media_type').notNull(),
  albumId: text('album_id'),
  orderId: integer('order_id').references(() => orders.id, {
    onDelete: 'set null',
  }),
  createdAt: timestamp('created_at').defaultNow(),
});

export const orders = pgTable('orders', {
  id: serial('id').primaryKey(),
  orderType: text('order_type').notNull(),
  status: text('status').notNull().default('awaiting_payment'),
  sessionId: integer('session_id').references(() => chatSessions.id, {
    onDelete: 'set null',
  }),
  userId: text('user_id').notNull(),
  amount: integer('amount').notNull(),
  adId: integer('ad_id'),
  meta: text('meta'),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

export const vipSubscriptions = pgTable('vip_subscriptions', {
  id: serial('id').primaryKey(),
  userId: text('user_id').notNull(),
  status: text('status').notNull().default('active'),
  startsAt: timestamp('starts_at').defaultNow(),
  expiresAt: timestamp('expires_at').notNull(),
  reminderSentAt: timestamp('reminder_sent_at'),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

export const userProfiles = pgTable('user_profiles', {
  id: serial('id').primaryKey(),
  userId: text('user_id').unique().notNull(),
  gender: text('gender'),
  adCount: integer('ad_count').notNull().default(0),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});
