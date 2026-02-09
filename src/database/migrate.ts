import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import * as dotenv from 'dotenv';
import {
  assertMediaArchiveSchemaReadiness,
  MediaArchiveConnectivityError,
  MediaArchiveReadinessError,
} from './media-archive-readiness';

dotenv.config();

const runMigrate = async () => {
  if (!process.env.DB_URL) {
    throw new Error('DB_URL is not defined');
  }

  const pool = new Pool({
    connectionString: process.env.DB_URL,
  });

  const db = drizzle(pool);

  console.log('Running migrations...');

  await migrate(db, { migrationsFolder: 'drizzle' });

  await assertMediaArchiveSchemaReadiness({
    db,
    source: 'migration',
    logger: {
      log: (message: string) => console.log(message),
      warn: (message: string) => console.warn(message),
      error: (message: string) => console.error(message),
    },
  });

  console.log('Migrations completed successfully');

  await pool.end();
};

runMigrate().catch((err) => {
  if (err instanceof MediaArchiveReadinessError) {
    console.error(
      `Migration verification failed: missing user_media columns (${err.missingColumns.join(', ')}). ${err.remediation}`,
    );
  } else if (err instanceof MediaArchiveConnectivityError) {
    console.error(
      `Migration verification failed: database connectivity issue. ${err.remediation}`,
    );
  }
  console.error('Migration failed!', err);
  process.exit(1);
});
