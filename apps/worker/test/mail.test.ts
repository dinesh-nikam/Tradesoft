import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PermanentError, RetryableError } from '@tradesoft/db';
import { formatMessage, renderMail, sendEmailJob, smtpTransport, type MailMessage } from '../src/mail.ts';

const TOKEN = 'A'.repeat(40) + '_-9';
const mail: MailMessage = { to: 'a@test.local', subject: 'Hi', text: 'line one\n.starts with a dot\nend' };

describe('ops.send_email payload and rendering', () => {
  const job = sendEmailJob(async () => undefined, 'https://trade.example');

  it('puts the token in the link fragment, never in the path or query', () => {
    const m = renderMail(
      job.payloadSchema.parse({
        template: 'password-reset',
        to: 'a@test.local',
        variables: { token: TOKEN },
      }),
      'https://trade.example',
    );
    const link = m.text.split('\n').find((l) => l.startsWith('https://'))!;
    expect(link).toBe(`https://trade.example/reset-password#token=${TOKEN}`);
    expect(m).toMatchObject({ to: 'a@test.local', subject: 'Reset your TradeSoft password' });
    expect(/^[\x20-\x7e\n]*$/.test(m.text)).toBe(true);
  });

  it('rejects unknown templates, malformed tokens and header injection in the recipient', () => {
    const bad = [
      { template: 'welcome', to: 'a@test.local', variables: { token: TOKEN } },
      { template: 'invitation', to: 'a@test.local', variables: { token: 'short' } },
      { template: 'invitation', to: 'a@test.local', variables: { token: `${TOKEN.slice(1)}/` } },
      { template: 'invitation', to: 'a@test.local\r\nBcc: x@evil.test', variables: { token: TOKEN } },
    ];
    for (const p of bad) expect(() => job.payloadSchema.parse(p)).toThrow();
  });

  it('formats a dot-stuffed, CRLF-terminated message', () => {
    const data = formatMessage('noreply@trade.example', mail, new Date('2026-11-03T10:00:00Z'));
    expect(data).toContain('Date: Tue, 03 Nov 2026 10:00:00 GMT\r\n');
    expect(data).toMatch(/Message-ID: <[0-9a-f-]{36}@trade\.example>\r\n/);
    expect(data.endsWith('\r\n\r\nline one\r\n..starts with a dot\r\nend\r\n.')).toBe(true);
    expect(data).not.toMatch(/[^\r]\n/);
  });
});

function hasOpenssl(): boolean {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

interface Fake {
  port: number;
  commands: string[];
  data: string;
  close(): Promise<void>;
}

/** A minimal SMTP server: STARTTLS on request, records commands and the DATA section. */
async function fakeSmtp(o: { starttls: boolean; rcpt?: string; key?: string; cert?: string }): Promise<Fake> {
  const fake = { commands: [] as string[], data: '' };
  const server = net.createServer((raw) => {
    let s: net.Socket = raw;
    let buffer = '';
    let inData = false;
    let secure = false;
    const say = (line: string) => s.write(`${line}\r\n`);
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString('latin1');
      let end: number;
      while ((end = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (inData) {
          if (line === '.') {
            inData = false;
            say('250 queued');
          } else fake.data += `${line}\r\n`;
          continue;
        }
        fake.commands.push(secure ? `tls:${line}` : line);
        const verb = line.split(' ')[0]!.toUpperCase();
        if (verb === 'EHLO') {
          say('250-fake.test');
          if (o.starttls && !secure) say('250-STARTTLS');
          say('250 AUTH LOGIN PLAIN');
        } else if (verb === 'STARTTLS') {
          say('220 ready');
          s.off('data', onData);
          s = new tls.TLSSocket(raw, { isServer: true, key: o.key!, cert: o.cert! });
          s.on('data', onData).on('error', () => undefined);
          secure = true;
        } else if (verb === 'AUTH') say('235 ok');
        else if (verb === 'MAIL') say('250 ok');
        else if (verb === 'RCPT') say(o.rcpt ?? '250 ok');
        else if (verb === 'DATA') {
          say('354 go ahead');
          inData = true;
        } else if (verb === 'QUIT') {
          say('221 bye');
          s.end();
        }
      }
    };
    raw.on('data', onData).on('error', () => undefined);
    say('220 fake.test ESMTP');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return Object.assign(fake, {
    port: (server.address() as net.AddressInfo).port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  });
}

const password = { reveal: () => 'smtp pass word' };

describe('SMTP transport', { timeout: 20_000 }, () => {
  it('refuses to authenticate when the server does not offer STARTTLS', async () => {
    const server = await fakeSmtp({ starttls: false });
    try {
      const send = smtpTransport({
        host: '127.0.0.1',
        port: server.port,
        user: 'u',
        password,
        from: 'f@t.test',
      });
      await expect(send(mail)).rejects.toBeInstanceOf(PermanentError);
      expect(server.commands.some((c) => c.startsWith('AUTH'))).toBe(false);
    } finally {
      await server.close();
    }
  });

  it('retries when the server cannot be reached', async () => {
    const server = await fakeSmtp({ starttls: false });
    await server.close();
    const send = smtpTransport({
      host: '127.0.0.1',
      port: server.port,
      user: 'u',
      password,
      from: 'f@t.test',
    });
    await expect(send(mail)).rejects.toBeInstanceOf(RetryableError);
  });
});

describe.skipIf(!hasOpenssl())('SMTP transport over STARTTLS', { timeout: 20_000 }, () => {
  let dir: string;
  let key: string;
  let cert: string;

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'smtp-'));
    // prettier-ignore
    execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
      '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem'), '-days', '1',
      '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost'], { stdio: 'ignore' });
    key = readFileSync(path.join(dir, 'key.pem'), 'utf8');
    cert = readFileSync(path.join(dir, 'cert.pem'), 'utf8');
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const transport = (port: number, ca?: string) =>
    smtpTransport({
      host: 'localhost',
      port,
      user: 'mailer',
      password,
      from: 'noreply@t.test',
      ...(ca ? { ca } : {}),
    });

  it('upgrades before authenticating and delivers the message', async () => {
    const server = await fakeSmtp({ starttls: true, key, cert });
    try {
      await transport(server.port, cert)(mail);
      const auth = server.commands.find((c) => c.startsWith('tls:AUTH PLAIN '))!;
      expect(Buffer.from(auth.slice('tls:AUTH PLAIN '.length), 'base64').toString()).toBe(
        '\0mailer\0smtp pass word',
      );
      expect(server.commands.filter((c) => !c.startsWith('tls:'))).toEqual([
        expect.stringMatching(/^EHLO /),
        'STARTTLS',
      ]);
      expect(server.commands).toContain('tls:RCPT TO:<a@test.local>');
      expect(server.data).toContain('\r\n..starts with a dot\r\n');
    } finally {
      await server.close();
    }
  });

  it('rejects a certificate it does not trust, before sending credentials', async () => {
    const server = await fakeSmtp({ starttls: true, key, cert });
    try {
      await expect(transport(server.port)(mail)).rejects.toThrow(/TLS handshake failed/);
      expect(server.commands.some((c) => c.includes('AUTH'))).toBe(false);
    } finally {
      await server.close();
    }
  });

  it('retries on 4xx and dead-letters on 5xx', async () => {
    for (const [rcpt, kind] of [
      ['451 try again later', RetryableError],
      ['550 no such mailbox', PermanentError],
    ] as const) {
      const server = await fakeSmtp({ starttls: true, rcpt, key, cert });
      try {
        await expect(transport(server.port, cert)(mail)).rejects.toBeInstanceOf(kind);
      } finally {
        await server.close();
      }
    }
  });
});
