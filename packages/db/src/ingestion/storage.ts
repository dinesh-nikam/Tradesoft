import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream, type WriteStream } from 'node:fs';
import { mkdir, readFile, unlink } from 'node:fs/promises';
import { extname, join } from 'node:path';

/**
 * Raw import files on the import volume (ADR-020, 06 §11). A file is written once, under a generated name
 * (`imports/{yyyy}/{mm}/{uuid}.csv`), while its SHA-256, byte count, leading null bytes and UTF-8 validity
 * are checked in the same pass (06 §11.1 steps 4–9). The original filename is metadata only.
 */

export const MAX_IMPORT_BYTES = 209_715_200;
const ALLOWED_MIME = new Set(['text/csv', 'text/plain', 'application/csv', 'application/vnd.ms-excel']);

/** An L1 file-level failure (03 §3.1) found while the file was received. */
export class ImportFileError extends Error {
  readonly code: 'FILE_TOO_LARGE' | 'FILE_EMPTY' | 'FILE_TYPE_REJECTED';
  constructor(code: ImportFileError['code'], message: string) {
    super(message);
    this.name = 'ImportFileError';
    this.code = code;
  }
}

export interface StoredImportFile {
  /** Relative to the import root; this is what `md.import_file.stored_path` holds. */
  storedPath: string;
  sha256: string;
  byteSize: number;
}

export interface ImportFileWriter {
  write(chunk: Buffer): Promise<void>;
  /** Finishes the file and runs the checks that need the whole stream. */
  close(meta: { filename: string; mimeType: string }): Promise<StoredImportFile>;
  /** Removes a partial or refused file. Safe to call more than once. */
  discard(): Promise<void>;
}

export async function openImportFile(root: string, maxBytes = MAX_IMPORT_BYTES): Promise<ImportFileWriter> {
  const now = new Date();
  const dir = join('imports', String(now.getUTCFullYear()), String(now.getUTCMonth() + 1).padStart(2, '0'));
  await mkdir(join(root, dir), { recursive: true, mode: 0o750 });
  const storedPath = join(dir, `${randomUUID()}.csv`).replace(/\\/g, '/');
  const absolute = join(root, storedPath);
  const out: WriteStream = createWriteStream(absolute, { flags: 'wx', mode: 0o640 });
  const hash = createHash('sha256');
  const utf8 = new TextDecoder('utf-8', { fatal: true });
  let size = 0;
  let head = Buffer.alloc(0);
  let badEncoding = false;
  let closed = false;

  const writeOut = (chunk: Buffer) =>
    new Promise<void>((resolve, reject) => out.write(chunk, (err) => (err ? reject(err) : resolve())));
  const finish = () =>
    new Promise<void>((resolve, reject) => {
      if (closed) return resolve();
      closed = true;
      out.end((err?: Error | null) => (err ? reject(err) : resolve()));
    });

  const writer: ImportFileWriter = {
    async write(chunk) {
      size += chunk.length;
      if (size > maxBytes) throw new ImportFileError('FILE_TOO_LARGE', `The file exceeds ${maxBytes} bytes`);
      if (head.length < 512) head = Buffer.concat([head, chunk.subarray(0, 512 - head.length)]);
      hash.update(chunk);
      if (!badEncoding) {
        try {
          utf8.decode(chunk, { stream: true });
        } catch {
          badEncoding = true;
        }
      }
      await writeOut(chunk);
    },
    async close({ filename, mimeType }) {
      await finish();
      try {
        utf8.decode();
      } catch {
        badEncoding = true;
      }
      const ext = extname(filename).toLowerCase();
      const fail = (code: ImportFileError['code'], message: string) => new ImportFileError(code, message);
      if (size === 0) throw fail('FILE_EMPTY', 'The file is empty');
      if (ext !== '.csv' && ext !== '.txt')
        throw fail('FILE_TYPE_REJECTED', 'Only .csv and .txt files are accepted');
      if (!ALLOWED_MIME.has(mimeType.split(';')[0]!.trim().toLowerCase()))
        throw fail('FILE_TYPE_REJECTED', `Content type ${mimeType} is not accepted`);
      if (head.includes(0)) throw fail('FILE_TYPE_REJECTED', 'The file is binary');
      if (badEncoding) throw fail('FILE_TYPE_REJECTED', 'The file is not valid UTF-8');
      return { storedPath, sha256: hash.digest('hex'), byteSize: size };
    },
    async discard() {
      await finish().catch(() => undefined);
      await unlink(absolute).catch(() => undefined);
    },
  };
  return writer;
}

/**
 * shortcut: the worker reads a whole file (at most 200 MiB) into memory to parse it; switch to a streaming
 * parser if files near the limit become routine.
 */
export function readImportFile(root: string, storedPath: string): Promise<string> {
  return readFile(join(root, storedPath), 'utf8');
}
