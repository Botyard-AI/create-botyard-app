import { BotPageAuthError, BotPageToolError } from "./errors.ts";

export interface GuardFailure {
  readonly status: 401 | 403 | 503;
  readonly body: { readonly error: string; readonly message: string };
}

/**
 * Map a guard error to an HTTP status and JSON body, or `null` when the
 * error is not one this package answers for (rethrow it).
 */
export function guardFailure(error: unknown): GuardFailure | null {
  if (error instanceof BotPageAuthError) {
    return { status: error.status, body: { error: error.code, message: error.message } };
  }
  if (error instanceof BotPageToolError) {
    return {
      status: 503,
      body: { error: "directory_unavailable", message: "The organization directory is unavailable. Try again shortly." },
    };
  }
  return null;
}

export function guardFailureResponse(failure: GuardFailure): Response {
  return Response.json(failure.body, {
    status: failure.status,
    headers: { "cache-control": "no-store" },
  });
}
