const { Client } = require('pg');
require('dotenv').config();

async function createDb() {
  const dbUrl = process.env.DB_URL;
  if (!dbUrl) {
    console.error('DB_URL not found');
    process.exit(1);
  }

  // Parse DB name from URL
  const urlParts = dbUrl.split('/');
  const dbName = urlParts[urlParts.length - 1];
  const postgresUrl = dbUrl.replace(`/${dbName}`, '/postgres');

  console.log(`Connecting to postgres to check/create DB: ${dbName}`);

  const client = new Client({ connectionString: postgresUrl });

  try {
    await client.connect();

    const res = await client.query(
      `SELECT 1 FROM pg_database WHERE datname = '${dbName}'`,
    );
    if (res.rowCount === 0) {
      console.log(`Database ${dbName} does not exist. Creating...`);
      await client.query(`CREATE DATABASE "${dbName}"`);
      console.log(`Database ${dbName} created successfully.`);
    } else {
      console.log(`Database ${dbName} already exists.`);
    }
  } catch (err) {
    console.error('Error creating database:', err);
  } finally {
    await client.end();
  }
}

createDb();
