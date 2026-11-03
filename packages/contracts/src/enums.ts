import { z } from 'zod';

// Database values, unchanged on the wire (05 §4.5). Sources: 02 §5 check constraints, 01 §3.
export const TIMEFRAMES = ['15m', '60m', '75m', '120m', '240m', '1D', '1W', '1M', '3M', '1Y'] as const;
export const timeframe = z.enum(TIMEFRAMES);
export type Timeframe = z.infer<typeof timeframe>;

export const IMPORT_BATCH_STATUSES = [
  'RECEIVED',
  'VALIDATING',
  'VALIDATED',
  'PROCESSING',
  'COMPLETED',
  'VALIDATION_FAILED',
  'PROCESSING_FAILED',
  'RECONCILIATION_FAILED',
] as const;
export const importBatchStatus = z.enum(IMPORT_BATCH_STATUSES);
export type ImportBatchStatus = z.infer<typeof importBatchStatus>;

export const JOB_STATUSES = ['QUEUED', 'RUNNING', 'COMPLETED', 'DEAD_LETTER', 'CANCELLED'] as const;
export const jobStatus = z.enum(JOB_STATUSES);
export type JobStatus = z.infer<typeof jobStatus>;

export const SCANNER_RUN_STATUSES = ['QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED'] as const;
export const scannerRunStatus = z.enum(SCANNER_RUN_STATUSES);
export type ScannerRunStatus = z.infer<typeof scannerRunStatus>;

export const USER_STATUSES = [
  'PENDING_VERIFICATION',
  'ACTIVE',
  'LOCKED',
  'SUSPENDED',
  'DEACTIVATED',
] as const;
export const userStatus = z.enum(USER_STATUSES);
export type UserStatus = z.infer<typeof userStatus>;

export const INSTRUMENT_STATUSES = ['ACTIVE', 'SUSPENDED', 'DELISTED'] as const;
export const instrumentStatus = z.enum(INSTRUMENT_STATUSES);
export type InstrumentStatus = z.infer<typeof instrumentStatus>;

export const BAR_QUALITY_STATUSES = ['VALIDATED', 'CORRECTED', 'QUARANTINED'] as const;
export const barQualityStatus = z.enum(BAR_QUALITY_STATUSES);
export type BarQualityStatus = z.infer<typeof barQualityStatus>;
