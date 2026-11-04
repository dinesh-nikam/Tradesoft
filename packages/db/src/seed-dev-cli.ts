import pg from 'pg';
import { seedDev } from './seed-dev.ts';

// 02 §9: the development seed refuses to run anywhere but an explicitly opted-in development database.
if (process.env.NODE_ENV !== 'development' || process.env.SEED_ALLOW !== 'true') {
  console.error('seed-dev runs only with NODE_ENV=development and SEED_ALLOW=true');
  process.exit(78);
}
const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set');
  process.exit(78);
}

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  const { passwords } = await seedDev(client);
  // Printed once; never written anywhere else.
  for (const [email, password] of Object.entries(passwords)) console.log(`${email}  ${password}`);
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
} finally {
  await client.end();
}
