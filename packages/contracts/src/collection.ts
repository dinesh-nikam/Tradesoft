import { z } from 'zod';

// 05 §6.3: base64url(payload) "." base64url(truncated HMAC). Verification lives with CURSOR_SECRET in the API.
export const cursor = z.string().regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/, 'Malformed cursor');

// 05 §6.1
export const page = z
  .object({
    limit: z.number().int().positive(),
    hasMore: z.boolean(),
    nextCursor: cursor.nullable(),
    totalCount: z.number().int().nonnegative().optional(),
  })
  .refine((p) => (p.nextCursor === null) === !p.hasMore, {
    message: 'nextCursor is null exactly when hasMore is false',
  });

export function collection<T extends z.ZodType>(item: T) {
  return z.object({ data: z.array(item), page });
}
