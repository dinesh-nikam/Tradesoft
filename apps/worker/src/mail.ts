import { createHash, randomUUID } from 'node:crypto';
import net from 'node:net';
import { hostname } from 'node:os';
import tls from 'node:tls';
import { z } from 'zod';
import { PermanentError, RetryableError, type JobDefinition } from '@tradesoft/db';

// ops.send_email (03 §5.3, 06 §4.2, §4.5). Mail is best-effort: a send that succeeds just before the job's
// commit fails is sent again on the retry.

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}
export type MailTransport = (message: MailMessage) => Promise<void>;

// Bodies stay ASCII, so the message is valid 7bit without encoding.
const TEMPLATES = {
  'password-reset': (link: string) => ({
    subject: 'Reset your TradeSoft password',
    text: [
      'A password reset was requested for your TradeSoft account.',
      '',
      'Choose a new password here. The link works once, for 60 minutes:',
      link,
      '',
      'If you did not ask for this, ignore this email. Your password has not changed.',
    ].join('\n'),
  }),
  invitation: (link: string) => ({
    subject: 'Your TradeSoft account',
    text: [
      'An administrator has created a TradeSoft account for you.',
      '',
      'Choose your password here. The link works once, for 72 hours:',
      link,
    ].join('\n'),
  }),
};

const payloadSchema = z.object({
  template: z.enum(['password-reset', 'invitation']),
  to: z.email(),
  // randomToken(): 32 bytes, base64url (06 §4.2).
  variables: z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }),
});
export type SendEmailPayload = z.infer<typeof payloadSchema>;

export function renderMail(p: SendEmailPayload, publicOrigin: string): MailMessage {
  // The token goes in the fragment, which browsers never send to a server or put in a Referer header.
  const link = `${new URL('/reset-password', publicOrigin).href}#token=${p.variables.token}`;
  return { to: p.to, ...TEMPLATES[p.template](link) };
}

export function sendEmailJob(
  transport: MailTransport,
  publicOrigin: string,
): JobDefinition<SendEmailPayload> {
  return {
    type: 'ops.send_email',
    payloadVersion: 1,
    payloadSchema,
    queue: 'default',
    maxAttempts: 5,
    baseDelayMs: 30_000,
    maxDelayMs: 1_800_000,
    idempotencyKey: (p) =>
      `mail:${p.template}:${createHash('sha256')
        .update(p.to + JSON.stringify(p.variables))
        .digest('hex')}`,
    handle: (p) => transport(renderMail(p, publicOrigin)),
  };
}

/** 07 §3.1: development and test never open a network connection for mail. */
export function consoleTransport(log: { info(obj: object, msg: string): void }): MailTransport {
  return async (mail) => log.info({ mail }, 'mail not sent: console transport');
}

export interface SmtpOptions {
  host: string;
  /** 465 is implicit TLS; any other port must offer STARTTLS. */
  port: number;
  user: string;
  password: { reveal(): string };
  from: string;
  /** Extra trust roots, for tests. */
  ca?: string;
  timeoutMs?: number;
}

export function smtpTransport(o: SmtpOptions): MailTransport {
  return (mail) => sendSmtp(o, mail);
}

async function sendSmtp(o: SmtpOptions, mail: MailMessage): Promise<void> {
  const secure = { host: o.host, port: o.port, servername: o.host, ...(o.ca ? { ca: o.ca } : {}) };
  const implicit = o.port === 465;
  const session = new SmtpSession(
    implicit ? tls.connect(secure) : net.connect({ host: o.host, port: o.port }),
    o.timeoutMs ?? 30_000,
  );
  const ehlo = `EHLO ${hostname()}`;
  try {
    await session.reply([220], 'greeting');
    let caps = await session.command(ehlo, [250]);
    if (!implicit) {
      // 06 §12: the password never crosses the network in clear text.
      if (!caps.some((c) => /^STARTTLS\b/i.test(c)))
        throw new PermanentError('SMTP server does not offer STARTTLS; refusing to authenticate');
      await session.command('STARTTLS', [220]);
      await session.upgrade(secure);
      caps = await session.command(ehlo, [250]);
    }
    // shortcut: AUTH PLAIN only; add LOGIN or XOAUTH2 when a provider requires one.
    if (!caps.some((c) => /^AUTH\b.*\bPLAIN\b/i.test(c)))
      throw new PermanentError('SMTP server does not offer AUTH PLAIN');
    const credentials = Buffer.from(`\0${o.user}\0${o.password.reveal()}`).toString('base64');
    await session.command(`AUTH PLAIN ${credentials}`, [235], 'AUTH PLAIN');
    await session.command(`MAIL FROM:<${o.from}>`, [250]);
    await session.command(`RCPT TO:<${mail.to}>`, [250, 251]);
    await session.command('DATA', [354]);
    await session.command(formatMessage(o.from, mail), [250], 'message');
    await session.command('QUIT', [221]).catch(() => undefined);
  } finally {
    session.close();
  }
}

/** RFC 5322 text/plain message, CRLF line ends, dot-stuffed and terminated for DATA (RFC 5321 §4.5.2). */
export function formatMessage(from: string, mail: MailMessage, now = new Date()): string {
  const headers = [
    `From: TradeSoft <${from}>`,
    `To: <${mail.to}>`,
    `Subject: ${mail.subject}`,
    `Date: ${now.toUTCString()}`,
    `Message-ID: <${randomUUID()}@${from.slice(from.lastIndexOf('@') + 1)}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=us-ascii',
    'Content-Transfer-Encoding: 7bit',
  ];
  const body = mail.text.split(/\r?\n/).map((line) => (line.startsWith('.') ? `.${line}` : line));
  return [...headers, '', ...body, '.'].join('\r\n');
}

/** One SMTP conversation: a line reader over the socket, swapped to TLS in place by STARTTLS. */
class SmtpSession {
  #socket: net.Socket;
  #buffer = '';
  #lines: string[] = [];
  #replies: string[][] = [];
  #waiter: { resolve(lines: string[]): void; reject(error: Error): void } | null = null;
  #failure: Error | null = null;
  readonly #timeoutMs: number;
  readonly #onData = (chunk: Buffer) => this.#read(chunk);
  readonly #onError = (error: Error) =>
    this.#fail(new RetryableError(`SMTP connection failed: ${error.message}`, { cause: error }));
  readonly #onClose = () => this.#fail(new RetryableError('SMTP connection closed by the server'));
  readonly #onTimeout = () => this.#fail(new RetryableError('SMTP server did not answer in time'));

  constructor(socket: net.Socket, timeoutMs: number) {
    this.#timeoutMs = timeoutMs;
    this.#socket = socket;
    this.#attach(socket);
  }

  #attach(s: net.Socket): void {
    s.setTimeout(this.#timeoutMs);
    s.on('data', this.#onData)
      .on('error', this.#onError)
      .on('close', this.#onClose)
      .on('timeout', this.#onTimeout);
  }

  #detach(s: net.Socket): void {
    s.off('data', this.#onData)
      .off('error', this.#onError)
      .off('close', this.#onClose)
      .off('timeout', this.#onTimeout);
  }

  #read(chunk: Buffer): void {
    this.#buffer += chunk.toString('latin1');
    let end: number;
    while ((end = this.#buffer.indexOf('\r\n')) >= 0) {
      const line = this.#buffer.slice(0, end);
      this.#buffer = this.#buffer.slice(end + 2);
      this.#lines.push(line);
      // "250-..." continues a reply; "250 ..." or a bare "250" ends it.
      if (line.length < 4 || line[3] === ' ') {
        this.#replies.push(this.#lines);
        this.#lines = [];
      }
    }
    if (this.#waiter && this.#replies.length > 0) {
      const w = this.#waiter;
      this.#waiter = null;
      w.resolve(this.#replies.shift()!);
    }
  }

  #fail(error: Error): void {
    this.#failure ??= error;
    this.#socket.destroy();
    const w = this.#waiter;
    this.#waiter = null;
    w?.reject(this.#failure);
  }

  #next(): Promise<string[]> {
    const ready = this.#replies.shift();
    if (ready) return Promise.resolve(ready);
    if (this.#failure) return Promise.reject(this.#failure);
    return new Promise((resolve, reject) => (this.#waiter = { resolve, reject }));
  }

  /** Waits for one reply; returns its lines without the code. 5xx is permanent, anything else retries. */
  async reply(expected: number[], label: string): Promise<string[]> {
    const lines = await this.#next();
    const last = lines.at(-1) ?? '';
    const code = Number(last.slice(0, 3));
    if (!expected.includes(code)) {
      const message = `SMTP ${label} rejected: ${last}`;
      throw code >= 500 && code < 600 ? new PermanentError(message) : new RetryableError(message);
    }
    return lines.map((l) => l.slice(4));
  }

  /** `label` replaces the line in errors, so credentials and message bodies never reach a log. */
  command(line: string, expected: number[], label = line): Promise<string[]> {
    this.#socket.write(`${line}\r\n`);
    return this.reply(expected, label);
  }

  async upgrade(options: tls.ConnectionOptions): Promise<void> {
    const raw = this.#socket;
    this.#detach(raw);
    const secure = tls.connect({ ...options, socket: raw });
    this.#socket = secure;
    await new Promise<void>((resolve, reject) => {
      secure.once('secureConnect', resolve);
      secure.once('error', reject);
    }).catch((error: Error) => {
      secure.destroy();
      throw new RetryableError(`SMTP TLS handshake failed: ${error.message}`, { cause: error });
    });
    this.#attach(secure);
  }

  close(): void {
    this.#detach(this.#socket);
    this.#socket.destroy();
  }
}
