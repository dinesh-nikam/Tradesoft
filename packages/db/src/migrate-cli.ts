import pg from 'pg';
import { migrate } from './migrate.ts';

const url = process.env.MIGRATOR_DATABASE_URL;
if (!url) {
  console.error('MIGRATOR_DATABASE_URL is not set');
  process.exit(78);
}

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  const applied = await migrate(client);
  console.log(applied.length > 0 ? `applied ${applied.join(', ')}` : 'schema is up to date');
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
} finally {
  await client.end();
}
