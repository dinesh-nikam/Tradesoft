import { Decimal as DecimalJs } from 'decimal.js';
import { instant, isoDate, uuidV7 } from '@tradesoft/contracts';
import { DomainError } from './errors.ts';

export type { Timeframe } from '@tradesoft/contracts';
export { TIMEFRAMES } from '@tradesoft/contracts';

// Exact decimal arithmetic for prices (ADR-005). A private clone, so no other code can change its rounding.
export const Decimal = DecimalJs.clone({ precision: 40, rounding: DecimalJs.ROUND_HALF_UP });
export type Decimal = DecimalJs;

const DECIMAL_LITERAL = /^-?(0|[1-9]\d*)(\.\d+)?$/;

export function parseDecimal(value: string): Decimal {
  if (!DECIMAL_LITERAL.test(value)) {
    throw new DomainError('VALIDATION_FAILED', 'Not a plain decimal literal', { value });
  }
  return new Decimal(value);
}

declare const brand: unique symbol;
type Branded<T, B extends string> = T & { readonly [brand]: B };

export type Id<Entity extends string> = Branded<string, Entity>;
export type UserId = Id<'AppUser'>;
export type ExchangeId = Id<'Exchange'>;
export type InstrumentId = Id<'Instrument'>;
export type MarketGroupId = Id<'MarketGroup'>;
export type ImportBatchId = Id<'ImportBatch'>;
export type BrickSetId = Id<'RenkoBrickSet'>;
export type ScannerRunId = Id<'ScannerRun'>;
export type JobId = Id<'Job'>;

export function parseId<Entity extends string>(value: string): Id<Entity> {
  if (!uuidV7.safeParse(value).success) throw new DomainError('VALIDATION_FAILED', 'Not a UUIDv7', { value });
  return value as Id<Entity>;
}

/** Exchange-local trading date (05 §4.3). Never derived from an Instant. */
export type IsoDate = Branded<string, 'IsoDate'>;
export function parseIsoDate(value: string): IsoDate {
  if (!isoDate.safeParse(value).success)
    throw new DomainError('VALIDATION_FAILED', 'Not a calendar date', { value });
  return value as IsoDate;
}

/** A UTC instant with millisecond precision (05 §4.3). */
export type Instant = Branded<string, 'Instant'>;
export function parseInstant(value: string): Instant {
  if (!instant.safeParse(value).success)
    throw new DomainError('VALIDATION_FAILED', 'Not a UTC instant', { value });
  return value as Instant;
}
