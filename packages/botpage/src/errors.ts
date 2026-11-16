import type { IdentityFailureReason } from "./identity.ts";

/** Base class for every error this package throws. */
export class BotPageError extends Error {
  override name = "BotPageError";
}

/** The SDK was configured in a way that is unsafe or invalid. Thrown at setup time. */
export class BotPageConfigError extends BotPageError {
  override name = "BotPageConfigError";
}

export type AuthFailureCode = "unauthenticated" | "not_a_member" | "role_not_allowed";

/**
 * A guard refused the request. `status` is 401 when no viewer could be
 * identified and 403 when the viewer is known but not allowed.
 */
export class BotPageAuthError extends BotPageError {
  override name = "BotPageAuthError";
  readonly code: AuthFailureCode;
  readonly status: 401 | 403;
  /** For `unauthenticated`: why the identity source found no viewer. */
  readonly reason: IdentityFailureReason | null;

  constructor(code: AuthFailureCode, message: string, reason: IdentityFailureReason | null = null) {
    super(message);
    this.code = code;
    this.reason = reason;
    this.status = code === "unauthenticated" ? 401 : 403;
  }
}

/**
 * A Botyard platform tool call failed, or returned something this package
 * cannot read. Adapters answer 503: the viewer may be fine, the directory is
 * just unavailable right now.
 */
export class BotPageToolError extends BotPageError {
  override name = "BotPageToolError";
  readonly tool: string;

  constructor(tool: string, message: string, options?: ErrorOptions) {
    super(`${tool}: ${message}`, options);
    this.tool = tool;
  }
}
