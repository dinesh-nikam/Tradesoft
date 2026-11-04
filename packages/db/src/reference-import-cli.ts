// Loads one REFERENCE batch: node packages/db/src/reference-import-cli.ts <KIND> <EXCHANGE> <file.csv>
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { importReference, REFERENCE_KINDS, type ReferenceKind } from './reference/import.ts';

const [kind, exchangeCode, file] = process.argv.slice(2);
const url = process.env.DATABASE_URL;
if (!kind || !exchangeCode || !file || !REFERENCE_KINDS.includes(kind as ReferenceKind)) {
  console.error(`usage: db:import:reference <${REFERENCE_KINDS.join('|')}> <EXCHANGE> <file.csv>`);
  process.exit(64);
}
if (!url) {
  console.error('DATABASE_URL is not set');
  process.exit(78);
}

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  const result = await importReference(client, {
    kind: kind as ReferenceKind,
    exchangeCode,
    csv: readFileSync(file, 'utf8'),
    actorType: 'SYSTEM',
    requestedBy: null,
    correlationId: randomUUID(),
  });
  console.log(JSON.stringify(result, null, 2));
  if (result.status !== 'COMPLETED') process.exitCode = 1;
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
} finally {
  await client.end();
}
