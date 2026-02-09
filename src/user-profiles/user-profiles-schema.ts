import { Logger } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { NodePgDatabase } from "drizzle-orm/node-postgres";

export async function ensureUserProfilesSchema(
  db: NodePgDatabase<any>,
  logger: Logger,
) {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "user_profiles" (
      "id" serial PRIMARY KEY,
      "user_id" text NOT NULL,
      "display_name" text,
      "preferred_language" text NOT NULL DEFAULT 'uz',
      "role_use_case" text,
      "timezone" text,
      "gender" text,
      "phone_number" text,
      "email" text,
      "notes" text,
      "current_step" text NOT NULL DEFAULT 'idle',
      "ad_count" integer NOT NULL DEFAULT 0,
      "created_at" timestamp DEFAULT now(),
      "updated_at" timestamp DEFAULT now()
    )
  `);

  await db.execute(
    sql`ALTER TABLE "user_profiles" ADD COLUMN IF NOT EXISTS "display_name" text`,
  );
  await db.execute(
    sql`ALTER TABLE "user_profiles" ADD COLUMN IF NOT EXISTS "preferred_language" text`,
  );
  await db.execute(
    sql`ALTER TABLE "user_profiles" ADD COLUMN IF NOT EXISTS "role_use_case" text`,
  );
  await db.execute(
    sql`ALTER TABLE "user_profiles" ADD COLUMN IF NOT EXISTS "timezone" text`,
  );
  await db.execute(
    sql`ALTER TABLE "user_profiles" ADD COLUMN IF NOT EXISTS "gender" text`,
  );
  await db.execute(
    sql`ALTER TABLE "user_profiles" ADD COLUMN IF NOT EXISTS "phone_number" text`,
  );
  await db.execute(
    sql`ALTER TABLE "user_profiles" ADD COLUMN IF NOT EXISTS "email" text`,
  );
  await db.execute(
    sql`ALTER TABLE "user_profiles" ADD COLUMN IF NOT EXISTS "notes" text`,
  );
  await db.execute(
    sql`ALTER TABLE "user_profiles" ADD COLUMN IF NOT EXISTS "current_step" text`,
  );
  await db.execute(
    sql`ALTER TABLE "user_profiles" ADD COLUMN IF NOT EXISTS "ad_count" integer`,
  );
  await db.execute(
    sql`ALTER TABLE "user_profiles" ADD COLUMN IF NOT EXISTS "created_at" timestamp`,
  );
  await db.execute(
    sql`ALTER TABLE "user_profiles" ADD COLUMN IF NOT EXISTS "updated_at" timestamp`,
  );

  await db.execute(
    sql`UPDATE "user_profiles" SET "preferred_language" = 'uz' WHERE "preferred_language" IS NULL`,
  );
  await db.execute(
    sql`UPDATE "user_profiles" SET "current_step" = 'idle' WHERE "current_step" IS NULL`,
  );
  await db.execute(
    sql`UPDATE "user_profiles" SET "ad_count" = 0 WHERE "ad_count" IS NULL`,
  );
  await db.execute(
    sql`UPDATE "user_profiles" SET "created_at" = now() WHERE "created_at" IS NULL`,
  );
  await db.execute(
    sql`UPDATE "user_profiles" SET "updated_at" = now() WHERE "updated_at" IS NULL`,
  );

  await db.execute(
    sql`ALTER TABLE "user_profiles" ALTER COLUMN "preferred_language" SET DEFAULT 'uz'`,
  );
  await db.execute(
    sql`ALTER TABLE "user_profiles" ALTER COLUMN "preferred_language" SET NOT NULL`,
  );
  await db.execute(
    sql`ALTER TABLE "user_profiles" ALTER COLUMN "current_step" SET DEFAULT 'idle'`,
  );
  await db.execute(
    sql`ALTER TABLE "user_profiles" ALTER COLUMN "current_step" SET NOT NULL`,
  );
  await db.execute(
    sql`ALTER TABLE "user_profiles" ALTER COLUMN "ad_count" SET DEFAULT 0`,
  );
  await db.execute(
    sql`ALTER TABLE "user_profiles" ALTER COLUMN "ad_count" SET NOT NULL`,
  );

  await db.execute(
    sql`CREATE UNIQUE INDEX IF NOT EXISTS "user_profiles_user_id_unique" ON "user_profiles" ("user_id")`,
  );

  await db.execute(sql`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'user_profiles_ad_count_non_negative'
      ) THEN
        ALTER TABLE "user_profiles"
        ADD CONSTRAINT "user_profiles_ad_count_non_negative"
        CHECK ("ad_count" >= 0);
      END IF;
    END $$;
  `);

  logger.log("User profile schema ensured");
}
