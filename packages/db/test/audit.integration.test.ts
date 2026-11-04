import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createScratchDatabase, testDatabaseUrl, type ScratchDatabase } from '@tradesoft/testing';
import { migrate, recordAudit, recordSecurityEvent, verifyAuditChain } from '../src/index.ts';

// E3.4: the chain verifies over 10,000 events, and altering one row makes verification name that row.
const adminUrl = testDatabaseUrl();

describe.skipIf(!adminUrl)('audit chain', () => {
  let db: ScratchDatabase;
  let client: pg.Client;

  beforeAll(async () => {
    db = await createScratchDatabase(adminUrl!);
    client = await db.connect();
    await migrate(client);
  }, 120_000);

  afterAll(async () => {
    await client?.end();
    await db?.drop();
  }, 60_000);

  it('verifies 10,000 chained events written from sessions in different time zones', async () => {
    const insert = (from: number, to: number) =>
      client.query(
        `insert into audit.audit_event (action, entity_type, entity_id, actor_type, after, correlation_id)
         select 'bar.corrected', 'market_bar', g::text, 'SYSTEM', jsonb_build_object('close', g), gen_random_uuid()
           from generate_series($1::integer, $2::integer) g`,
        [from, to],
      );
    await client.query("set timezone = 'Asia/Kolkata'");
    await insert(1, 5000);
    await client.query("set timezone = 'America/New_York'");
    await insert(5001, 10000);
    await client.query("set timezone = 'UTC'");
    expect(await verifyAuditChain(client)).toEqual({
      checked: 10_000,
      firstBreakId: null,
      firstBreakAt: null,
    });
  });

  it('names the first altered row', async () => {
    const { rows } = await client.query<{ id: string }>(
      'select id::text from audit.audit_event order by id offset 6000 limit 1',
    );
    const target = rows[0]!.id;
    // A superuser bypassing the append-only trigger is exactly the tampering the chain exists to expose.
    await client.query('begin');
    await client.query('set local session_replication_role = replica');
    await client.query(`update audit.audit_event set after = '{"close": 1}' where id = $1`, [target]);
    await client.query('commit');
    const result = await verifyAuditChain(client);
    expect(result.firstBreakId).toBe(target);
    expect(result.firstBreakAt).not.toBeNull();
  });

  it('refuses updates from the application role (INV-14)', async () => {
    await client.query('begin');
    try {
      await client.query('set local role tradesoft_app');
      await expect(client.query("update audit.audit_event set action = 'x.y' where id = 1")).rejects.toThrow(
        /permission denied/,
      );
    } finally {
      await client.query('rollback');
    }
  });

  it('redacts credentials before writing audit and security rows', async () => {
    const correlationId = '018f2c4b-1d22-7b33-8c44-5d6e7f809a1b';
    const id = await recordAudit(client, {
      action: 'user.created',
      entityType: 'user',
      entityId: 'u1',
      actorType: 'SYSTEM',
      after: { email: 'a@b.c', passwordHash: '$argon2id$secret' },
      metadata: { refreshToken: 'abc' },
      correlationId,
    });
    const audit = await client.query<{ after: object; metadata: object }>(
      'select after, metadata from audit.audit_event where id = $1',
      [id],
    );
    expect(audit.rows[0]).toEqual({
      after: { email: 'a@b.c', passwordHash: '[REDACTED]' },
      metadata: { refreshToken: '[REDACTED]' },
    });
    const sid = await recordSecurityEvent(client, {
      eventType: 'LOGIN_FAILURE',
      severity: 'INFO',
      emailAttempted: 'a@b.c',
      details: { password: 'hunter2' },
      correlationId,
    });
    const sec = await client.query<{ details: object }>(
      'select details from audit.security_event where id = $1',
      [sid],
    );
    expect(sec.rows[0]!.details).toEqual({ password: '[REDACTED]' });
  });
});
