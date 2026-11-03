import { z } from 'zod';

// 05 §4.2: UUIDv7, lowercase, hyphenated.
export const uuidV7 = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    'Expected a lowercase UUIDv7',
  );

// 05 §4.3: exchange-local trading date, YYYY-MM-DD, a real calendar date.
export const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD')
  .refine((s) => {
    const ms = Date.parse(`${s}T00:00:00.000Z`);
    return Number.isFinite(ms) && new Date(ms).toISOString().startsWith(s);
  }, 'Not a calendar date');

// 05 §4.3: an instant, always UTC with millisecond precision.
export const instant = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, 'Expected YYYY-MM-DDTHH:mm:ss.sssZ')
  .refine((s) => {
    const ms = Date.parse(s);
    return Number.isFinite(ms) && new Date(ms).toISOString() === s;
  }, 'Not a valid instant');
