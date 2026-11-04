import type {
  ErrorCode,
  ImportBatchStatus,
  InstrumentStatus,
  JobStatus,
  ScannerRunStatus,
  UserStatus,
} from '@tradesoft/contracts';
import { DomainError } from './errors.ts';

export interface StateMachine<S extends string, E extends string> {
  readonly name: string;
  readonly initial: readonly S[];
  readonly terminal: readonly S[];
  readonly transitions: readonly { readonly from: S; readonly event: E; readonly to: S }[];
  /** Catalogue code returned when an event is not allowed in the current state. */
  readonly conflictCode: ErrorCode;
}

function defineMachine<S extends string, E extends string>(machine: StateMachine<S, E>): StateMachine<S, E> {
  const seen = new Set<string>();
  for (const t of machine.transitions) {
    const key = `${t.from}:${t.event}`;
    if (seen.has(key)) throw new Error(`${machine.name}: duplicate transition ${key}`);
    if (machine.terminal.includes(t.from))
      throw new Error(`${machine.name}: terminal state ${t.from} has an exit`);
    seen.add(key);
  }
  return Object.freeze(machine);
}

/** The state after `event`, or a DomainError carrying the machine's conflict code (INV-07 for batches). */
export function transition<S extends string, E extends string>(
  machine: StateMachine<S, E>,
  from: S,
  event: E,
): S {
  const t = machine.transitions.find((x) => x.from === from && x.event === event);
  if (!t) {
    throw new DomainError(machine.conflictCode, `${machine.name}: ${event} is not allowed in state ${from}`, {
      machine: machine.name,
      from,
      event,
    });
  }
  return t.to;
}

export function isTerminal<S extends string, E extends string>(
  machine: StateMachine<S, E>,
  state: S,
): boolean {
  return machine.terminal.includes(state);
}

// 01 §3.1
export type ImportBatchEvent =
  | 'START_VALIDATION'
  | 'PASS_VALIDATION'
  | 'FAIL_VALIDATION'
  | 'START_PROCESSING'
  | 'FAIL_PROCESSING'
  | 'PASS_RECONCILIATION'
  | 'FAIL_RECONCILIATION';
export const importBatchMachine = defineMachine<ImportBatchStatus, ImportBatchEvent>({
  name: 'ImportBatch',
  initial: ['RECEIVED'],
  terminal: ['VALIDATION_FAILED', 'PROCESSING_FAILED', 'RECONCILIATION_FAILED', 'COMPLETED'],
  conflictCode: 'IMPORT_BATCH_STATE_INVALID',
  transitions: [
    { from: 'RECEIVED', event: 'START_VALIDATION', to: 'VALIDATING' },
    { from: 'VALIDATING', event: 'PASS_VALIDATION', to: 'VALIDATED' },
    { from: 'VALIDATING', event: 'FAIL_VALIDATION', to: 'VALIDATION_FAILED' },
    { from: 'VALIDATED', event: 'START_PROCESSING', to: 'PROCESSING' },
    { from: 'PROCESSING', event: 'PASS_RECONCILIATION', to: 'COMPLETED' },
    { from: 'PROCESSING', event: 'FAIL_PROCESSING', to: 'PROCESSING_FAILED' },
    { from: 'PROCESSING', event: 'FAIL_RECONCILIATION', to: 'RECONCILIATION_FAILED' },
  ],
});

// 01 §3.2. Whether a failure retries or dead-letters is decided by the job runtime (03 §5.2), not here.
export type JobEvent =
  'CLAIM' | 'SUCCEED' | 'RETRY_LATER' | 'RECLAIM' | 'DEAD_LETTER' | 'CANCEL' | 'OPERATOR_RETRY';
export const jobMachine = defineMachine<JobStatus, JobEvent>({
  name: 'Job',
  initial: ['QUEUED'],
  terminal: ['COMPLETED', 'CANCELLED'],
  conflictCode: 'JOB_STATE_INVALID',
  transitions: [
    { from: 'QUEUED', event: 'CLAIM', to: 'RUNNING' },
    { from: 'RUNNING', event: 'SUCCEED', to: 'COMPLETED' },
    { from: 'RUNNING', event: 'RETRY_LATER', to: 'QUEUED' },
    { from: 'RUNNING', event: 'RECLAIM', to: 'QUEUED' },
    { from: 'RUNNING', event: 'DEAD_LETTER', to: 'DEAD_LETTER' },
    { from: 'QUEUED', event: 'CANCEL', to: 'CANCELLED' },
    { from: 'DEAD_LETTER', event: 'OPERATOR_RETRY', to: 'QUEUED' },
  ],
});

// 01 §3.3
export type ScannerRunEvent = 'CLAIM' | 'COMPLETE' | 'FAIL' | 'CANCEL';
export const scannerRunMachine = defineMachine<ScannerRunStatus, ScannerRunEvent>({
  name: 'ScannerRun',
  initial: ['QUEUED'],
  terminal: ['COMPLETED', 'FAILED', 'CANCELLED'],
  conflictCode: 'RESOURCE_CONFLICT',
  transitions: [
    { from: 'QUEUED', event: 'CLAIM', to: 'RUNNING' },
    { from: 'RUNNING', event: 'COMPLETE', to: 'COMPLETED' },
    { from: 'RUNNING', event: 'FAIL', to: 'FAILED' },
    { from: 'QUEUED', event: 'CANCEL', to: 'CANCELLED' },
    { from: 'RUNNING', event: 'CANCEL', to: 'CANCELLED' },
  ],
});

// 01 §3.4
export type UserEvent = 'VERIFY_EMAIL' | 'LOCK' | 'UNLOCK' | 'SUSPEND' | 'REINSTATE' | 'DEACTIVATE';
export const userMachine = defineMachine<UserStatus, UserEvent>({
  name: 'AppUser',
  initial: ['PENDING_VERIFICATION'],
  terminal: ['DEACTIVATED'],
  conflictCode: 'RESOURCE_CONFLICT',
  transitions: [
    { from: 'PENDING_VERIFICATION', event: 'VERIFY_EMAIL', to: 'ACTIVE' },
    { from: 'ACTIVE', event: 'LOCK', to: 'LOCKED' },
    { from: 'LOCKED', event: 'UNLOCK', to: 'ACTIVE' },
    { from: 'ACTIVE', event: 'SUSPEND', to: 'SUSPENDED' },
    { from: 'SUSPENDED', event: 'REINSTATE', to: 'ACTIVE' },
    { from: 'ACTIVE', event: 'DEACTIVATE', to: 'DEACTIVATED' },
    { from: 'SUSPENDED', event: 'DEACTIVATE', to: 'DEACTIVATED' },
  ],
});

// 01 §3.5
export type InstrumentEvent = 'SUSPEND' | 'RESUME' | 'DELIST';
export const instrumentMachine = defineMachine<InstrumentStatus, InstrumentEvent>({
  name: 'Instrument',
  initial: ['ACTIVE'],
  terminal: ['DELISTED'],
  conflictCode: 'RESOURCE_CONFLICT',
  transitions: [
    { from: 'ACTIVE', event: 'SUSPEND', to: 'SUSPENDED' },
    { from: 'SUSPENDED', event: 'RESUME', to: 'ACTIVE' },
    { from: 'ACTIVE', event: 'DELIST', to: 'DELISTED' },
    { from: 'SUSPENDED', event: 'DELIST', to: 'DELISTED' },
  ],
});
