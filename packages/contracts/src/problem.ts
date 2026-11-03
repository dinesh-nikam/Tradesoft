import { z } from 'zod';
import { ERROR_CATALOGUE, errorCode, isRetryableStatus, problemType, type ErrorCode } from './errors';

// RFC 9457 problem document with the TradeSoft members (05 §5.1). Responses are open (D-05-06).
export const problemDetails = z
  .object({
    type: z.string().regex(/^urn:tradesoft:problem:v1:[a-z0-9-]+$/),
    title: z.string().min(1),
    status: z.number().int().min(400).max(599),
    detail: z.string(),
    instance: z.string().startsWith('/'),
    code: errorCode,
    correlationId: z.string().min(1).max(128),
    retryable: z.boolean(),
    errors: z
      .array(z.object({ path: z.string().startsWith('/'), code: errorCode, message: z.string() }))
      .optional(),
  })
  .refine((p) => p.status === ERROR_CATALOGUE[p.code].status, { message: 'status does not match the code' })
  .refine((p) => p.type === problemType(p.code), { message: 'type does not match the code' });
export type ProblemDetails = z.infer<typeof problemDetails>;

export interface ProblemInput {
  detail: string;
  instance: string;
  correlationId: string;
  errors?: { path: string; code: ErrorCode; message: string }[];
}

/** The only constructor of a problem document; status, title and type always come from the catalogue. */
export function problem(code: ErrorCode, input: ProblemInput): ProblemDetails {
  const { status, title } = ERROR_CATALOGUE[code];
  return {
    type: problemType(code),
    title,
    status,
    detail: input.detail,
    instance: input.instance,
    code,
    correlationId: input.correlationId,
    retryable: isRetryableStatus(status),
    ...(input.errors ? { errors: input.errors } : {}),
  };
}
