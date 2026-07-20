import { z } from 'zod';

export interface ClientSafeError {
  status: number;
  error: string;
  message: string;
  hint?: string;
  issues?: string[];
}

/**
 * Turn any thrown value into the shape it's safe to send to a client.
 * Deliberate errors (thrown with an explicit `.status`, written by our
 * own code to be shown to a user) keep their authored message
 * regardless of status. Anything else — a bare `Error` with no
 * `.status`, i.e. a genuinely unexpected bug — is treated as internal:
 * its real message is never echoed to the client, only logged
 * server-side by the caller. This is the one place stack-trace-style
 * leakage would happen if it were going to; keeping the check here
 * makes it independently testable instead of implicit in middleware.
 */
export function sanitizeErrorForClient(err: unknown): ClientSafeError {
  if (err instanceof z.ZodError) {
    return {
      status: 400,
      error: 'validation_failed',
      message: 'The request did not pass validation.',
      issues: err.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`),
    };
  }
  const e = err as { message?: string; status?: number; hint?: string; issues?: string[] };
  const isOperational = typeof e.status === 'number';
  const status = e.status ?? 500;
  return {
    status,
    error:
      status === 401 ? 'auth_failed'
      : status === 409 ? 'blocked'
      : status === 422 ? 'rejected'
      : status === 503 ? 'not_connected'
      : 'error',
    message: isOperational ? (e.message ?? 'Something went wrong.') : 'Something went wrong. This has been logged.',
    ...(e.hint ? { hint: e.hint } : {}),
    ...(e.issues ? { issues: e.issues } : {}),
  };
}
