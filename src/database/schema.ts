import { pgTable, serial, text, timestamp } from 'drizzle-orm/pg-core';

export const sessions = pgTable('sessions', {
  id: serial('id').primaryKey(),
  phoneNumber: text('phone_number').unique().notNull(),
  sessionString: text('session_string').notNull(),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});
