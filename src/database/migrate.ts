import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import * as dotenv from 'dotenv';

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

  console.log('Migrations completed successfully');

  await pool.end();
};

runMigrate().catch((err) => {
  console.error('Migration failed!', err);
  process.exit(1);
});
