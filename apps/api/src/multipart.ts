// A streaming multipart/form-data reader for the upload endpoints (05 §3.5, 06 §11.1). The file part is
// handed to the writer chunk by chunk, so the body is never buffered whole; text fields are small and capped.
import type { ImportFileWriter } from '@tradesoft/db';
import { ApiError } from './platform.ts';

const MAX_FIELD_BYTES = 65_536;
const MAX_HEADER_BYTES = 16_384;
const CRLF = Buffer.from('\r\n');
const HEADER_END = Buffer.from('\r\n\r\n');

export interface MultipartUpload {
  fields: Record<string, string>;
  file: { field: string; filename: string; mimeType: string; writer: ImportFileWriter } | null;
}

const malformed = (detail: string) =>
  new ApiError('VALIDATION_FAILED', `The multipart body is malformed: ${detail}`);

export function boundaryOf(contentType: string | undefined): string {
  const m = /^multipart\/form-data\s*;.*boundary=(?:"([^"]{1,70})"|([^;\s]{1,70}))/i.exec(contentType ?? '');
  if (!m) throw new ApiError('UNSUPPORTED_MEDIA_TYPE', 'Expected multipart/form-data with a boundary');
  return (m[1] ?? m[2])!;
}

function partHeaders(raw: string) {
  const headers = new Map<string, string>();
  for (const line of raw.split('\r\n')) {
    const i = line.indexOf(':');
    if (i > 0) headers.set(line.slice(0, i).trim().toLowerCase(), line.slice(i + 1).trim());
  }
  const disposition = headers.get('content-disposition') ?? '';
  const name = /\bname="([^"]*)"/i.exec(disposition)?.[1];
  const filename = /\bfilename="([^"]*)"/i.exec(disposition)?.[1];
  if (!/^form-data\b/i.test(disposition) || name === undefined)
    throw malformed('a part has no form-data name');
  return { name, filename, mimeType: headers.get('content-type') ?? 'application/octet-stream' };
}

/**
 * Reads the whole body. The first part with a filename is the file and goes to `openFile()`'s writer; a
 * second file part is refused. On any error the writer, if opened, is discarded before the error is thrown.
 */
export async function readMultipart(
  body: AsyncIterable<Buffer>,
  contentType: string | undefined,
  openFile: () => Promise<ImportFileWriter>,
): Promise<MultipartUpload> {
  const delimiter = Buffer.from(`\r\n--${boundaryOf(contentType)}`);
  const out: MultipartUpload = { fields: {}, file: null };
  // A leading CRLF lets the first delimiter match the same pattern as the others.
  let buf: Buffer = CRLF;
  let state = 'preamble' as 'preamble' | 'afterDelimiter' | 'headers' | 'body' | 'done';
  let current: { name: string; isFile: boolean; chunks: Buffer[]; size: number } | null = null;

  const emit = async (data: Buffer) => {
    if (data.length === 0 || !current) return;
    if (current.isFile) return out.file!.writer.write(data);
    current.size += data.length;
    if (current.size > MAX_FIELD_BYTES) throw malformed(`field ${current.name} is too long`);
    current.chunks.push(data);
  };
  const endPart = () => {
    if (current && !current.isFile) out.fields[current.name] = Buffer.concat(current.chunks).toString('utf8');
    current = null;
  };

  const drain = async () => {
    for (;;) {
      if (state === 'preamble' || state === 'body') {
        const at = buf.indexOf(delimiter);
        if (at < 0) {
          // Keep enough of the tail to recognise a delimiter split across chunks.
          const keep = Math.min(buf.length, delimiter.length - 1);
          if (state === 'body') await emit(buf.subarray(0, buf.length - keep));
          buf = buf.subarray(buf.length - keep);
          return;
        }
        if (state === 'body') {
          await emit(buf.subarray(0, at));
          endPart();
        }
        buf = buf.subarray(at + delimiter.length);
        state = 'afterDelimiter';
      } else if (state === 'afterDelimiter') {
        if (buf.length < 2) return;
        if (buf[0] === 0x2d && buf[1] === 0x2d) {
          state = 'done';
          return;
        }
        if (!buf.subarray(0, 2).equals(CRLF)) throw malformed('bad delimiter line');
        buf = buf.subarray(2);
        state = 'headers';
      } else if (state === 'headers') {
        const at = buf.indexOf(HEADER_END);
        if (at < 0) {
          if (buf.length > MAX_HEADER_BYTES) throw malformed('part headers are too long');
          return;
        }
        const h = partHeaders(buf.subarray(0, at).toString('utf8'));
        buf = buf.subarray(at + HEADER_END.length);
        const isFile = h.filename !== undefined;
        if (isFile) {
          if (out.file) throw malformed('only one file may be uploaded');
          out.file = { field: h.name, filename: h.filename!, mimeType: h.mimeType, writer: await openFile() };
        }
        current = { name: h.name, isFile, chunks: [], size: 0 };
        state = 'body';
      } else return;
    }
  };

  try {
    for await (const chunk of body) {
      if (state === 'done') continue;
      buf = Buffer.concat([buf, chunk]);
      await drain();
    }
    if (state !== 'done') throw malformed('the body ended before the closing boundary');
    return out;
  } catch (error) {
    await out.file?.writer.discard();
    throw error;
  }
}
