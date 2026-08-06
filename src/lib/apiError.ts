/**
 * Shared error type for both the live (fetch-based) API client
 * (src/lib/api.ts) and the demo (fixture-based) API client
 * (src/lib/demoApi.ts). Kept in its own module so the two clients
 * never need to import from one another.
 */
export class ApiError extends Error {
  status: number;
  hint?: string;
  issues?: string[];
  constructor(status: number, body: { message?: string; hint?: string; issues?: string[] }) {
    super(body.message ?? `Request failed (${status})`);
    this.status = status;
    this.hint = body.hint;
    this.issues = body.issues;
  }
}
