import type { TransportKind } from "./types.ts";

export interface BotyardErrorOptions {
  /** The canonical tool name the caller asked for, when the error is about a call. */
  readonly tool?: string | undefined;
  /** The transport that produced the error, once one has been chosen. */
  readonly transport?: TransportKind | undefined;
  readonly cause?: unknown;
}

/**
 * Base class of every error this package throws. Catch this to handle any
 * Botyard failure; catch a subclass to react to one kind.
 *
 * Messages never contain tool arguments or credentials.
 */
export class BotyardError extends Error {
  readonly tool: string | undefined;
  readonly transport: TransportKind | undefined;

  constructor(message: string, options: BotyardErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "BotyardError";
    this.tool = options.tool;
    this.transport = options.transport;
  }
}

/**
 * The call was refused before the tool ran: the arguments are not a JSON
 * object, fail the tool's input schema, or are too large. Fix the input; the
 * same request will fail the same way.
 */
export class InvalidInputError extends BotyardError {
  constructor(message: string, options: BotyardErrorOptions = {}) {
    super(message, options);
    this.name = "InvalidInputError";
  }
}

/**
 * No tool with this name is assigned to the bot. A subclass of
 * {@link InvalidInputError}: nothing ran.
 */
export class UnknownToolError extends InvalidInputError {
  constructor(message: string, options: BotyardErrorOptions = {}) {
    super(message, options);
    this.name = "UnknownToolError";
  }
}

export interface ToolErrorOptions extends BotyardErrorOptions {
  /** The MCP content blocks the tool returned with its error. */
  readonly content?: readonly unknown[] | undefined;
  /** The tool's structured error payload, when it sent one. */
  readonly structuredContent?: unknown;
}

/**
 * The tool ran and reported an error (MCP `isError: true`), for example "not
 * found" or "permission denied". `message` is the tool's own text.
 */
export class ToolError extends BotyardError {
  readonly content: readonly unknown[];
  readonly structuredContent: unknown;

  constructor(message: string, options: ToolErrorOptions = {}) {
    super(message, options);
    this.name = "ToolError";
    this.content = options.content ?? [];
    this.structuredContent = options.structuredContent;
  }
}

/**
 * The request may have reached the tool, but no result came back: a timeout,
 * an abort, a dropped connection or an unreadable answer after dispatch.
 *
 * **Never retry automatically.** The tool may have run, and a mutation could
 * run twice. Check the effect (or ask a human) before trying again.
 */
export class OutcomeUnknownError extends BotyardError {
  constructor(message: string, options: BotyardErrorOptions = {}) {
    super(message, options);
    this.name = "OutcomeUnknownError";
  }
}

/**
 * Botyard could not be reached, or refused the request before any tool ran:
 * no transport detected, the daemon is down, the proxy refused the
 * connection, an HTTP 4xx, and so on. The tool did not run.
 */
export class TransportError extends BotyardError {
  constructor(message: string, options: BotyardErrorOptions = {}) {
    super(message, options);
    this.name = "TransportError";
  }
}
