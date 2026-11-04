import type pg from 'pg';
import { emitEvent } from '../jobs.ts';

/**
 * Creates an import batch for a stored file and announces it, in the caller's transaction (03 §7.3: the
 * file row, the batch row and `import.received` commit together, so no batch can exist that nobody will
 * process). A new file is inserted; `fileId` reuses one, which is how a reprocess creates its batch.
 * `uq_import_file_sha` and `uq_import_batch_idem` violations propagate to the caller.
 */
export async function createImportBatch(
  c: pg.ClientBase,
  q: {
    file:
      | { fileId: string }
      | { originalFilename: string; storedPath: string; byteSize: number; sha256: string; mimeType: string };
    sourceId: string;
    exchangeId: string;
    batchType: 'EOD_CSV' | 'INTRADAY_CSV' | 'CORRECTION';
    timeframe: string | null;
    idempotencyKey: string | null;
    supersedesBatchId: string | null;
    correlationId: string;
    requestedBy: string | null;
  },
): Promise<{ batchId: string; fileId: string }> {
  const fileId =
    'fileId' in q.file
      ? q.file.fileId
      : (
          await c.query<{ id: string }>(
            `insert into md.import_file (original_filename, stored_path, byte_size, sha256, mime_type, uploaded_by)
             values ($1, $2, $3, decode($4, 'hex'), $5, $6) returning id::text`,
            [
              q.file.originalFilename,
              q.file.storedPath,
              q.file.byteSize,
              q.file.sha256,
              q.file.mimeType,
              q.requestedBy,
            ],
          )
        ).rows[0]!.id;
  const batchId = (
    await c.query<{ id: string }>(
      `insert into md.import_batch (source_id, file_id, exchange_id, batch_type, timeframe, idempotency_key,
                                    supersedes_batch_id, correlation_id, requested_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id::text`,
      [
        q.sourceId,
        fileId,
        q.exchangeId,
        q.batchType,
        q.timeframe,
        q.idempotencyKey,
        q.supersedesBatchId,
        q.correlationId,
        q.requestedBy,
      ],
    )
  ).rows[0]!.id;
  await emitEvent(c, {
    type: 'import.received',
    aggregateType: 'import_batch',
    aggregateId: batchId,
    payload: { batchId, fileId },
    correlationId: q.correlationId,
  });
  return { batchId, fileId };
}
