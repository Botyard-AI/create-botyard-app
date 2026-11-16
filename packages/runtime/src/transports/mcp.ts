/**
 * OpenClaw-runtime transport: MCP Streamable HTTP to the bot bridge's
 * loopback proxy, `http://127.0.0.1:$MCP_PROXY_PORT/mcp`.
 *
 * The bridge authenticates every request itself: it fetches a JWT-SVID from
 * the identity broker and forwards to botyard-mcp. This transport sends no
 * credential and reads none. It deliberately never touches the identity
 * broker or its token: the provisioner keeps that token out of reach of the
 * OpenClaw runtime UID on purpose (IB-03), and app code must not route
 * around that boundary.
 *
 * The proxy is stateless: each POST is one JSON-RPC request, answered as
 * `application/json` or as a `text/event-stream` carrying the response.
 */

import {
  InvalidInputError,
  OutcomeUnknownError,
  TransportError,
  type BotyardErrorOptions,
} from "../errors.ts";
import { bounded, deadline, describeEnd, isRecord } from "../internal.ts";
import type { RequestOptions, ToolDescriptor, ToolResult, Transport } from "../types.ts";

/** Default proxy port, as the bridge and the provisioner define it. */
export const DEFAULT_MCP_PROXY_PORT = 9092;

/** Largest response accepted. */
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
/** Most of a non-2xx body read for an error message; the rest is cancelled. */
const MAX_ERROR_BODY_BYTES = 4 * 1024;

/** Socket errors that prove the request never reached the proxy. */
const NOT_CONNECTED = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH", "EADDRNOTAVAIL"]);

/** JSON-RPC codes the server sends before dispatching to a tool. */
const RPC_PARSE_ERROR = -32700;
const RPC_INVALID_REQUEST = -32600;
const RPC_METHOD_NOT_FOUND = -32601;
const RPC_INVALID_PARAMS = -32602;

export interface McpTransportOptions {
  /** Full MCP endpoint URL, e.g. `http://127.0.0.1:9092/mcp`. */
  readonly url: string | URL;
  /** Injection point for tests. Defaults to the global `fetch`. */
  readonly fetch?: typeof fetch;
}

let nextId = 1;

export function createMcpTransport(options: McpTransportOptions): Transport {
  const url = new URL(options.url);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TransportError(`MCP URL must be http(s): ${url.protocol}`, { transport: "mcp" });
  }
  if (url.username !== "" || url.password !== "") {
    throw new TransportError("MCP URL must not carry credentials", { transport: "mcp" });
  }
  const fetchImpl = options.fetch ?? fetch;

  /**
   * One JSON-RPC round trip. `mutating` decides how an ambiguous failure is
   * reported: a `tools/call` that may have been delivered is outcome-unknown;
   * a read is just a transport failure.
   */
  async function rpc(method: string, params: Record<string, unknown>, opts: RequestOptions, tool: string | undefined): Promise<unknown> {
    const where: BotyardErrorOptions = { tool, transport: "mcp" };
    const mutating = method === "tools/call";
    const ambiguous = (message: string, cause?: unknown): Error =>
      mutating
        ? new OutcomeUnknownError(`${message}; the tool may have run. Do not retry automatically.`, { ...where, cause })
        : new TransportError(message, { ...where, cause });

    if (opts.signal?.aborted) {
      throw new TransportError("the call was aborted before it started", where);
    }
    const id = nextId++;
    const d = deadline(opts.timeoutMs, opts.signal);
    try {
      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
          },
          body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
          redirect: "error",
          signal: d.signal,
        });
      } catch (err) {
        if (d.signal.aborted) throw ambiguous(describeEnd(d), err);
        const code = socketCode(err);
        if (code !== undefined && NOT_CONNECTED.has(code)) {
          throw new TransportError(`cannot reach the Botyard MCP proxy at ${url.origin} (${code})`, { ...where, cause: err });
        }
        throw ambiguous(`the connection to the Botyard MCP proxy failed (${code ?? "network error"})`, err);
      }

      if (!response.ok) {
        // The status alone classifies the failure; the body is a bounded,
        // best-effort detail that can never stall or exhaust memory.
        const detail = bounded((await errorDetail(response, d.signal)).trim(), 300);
        // 4xx: the proxy or botyard-mcp refused the request (route, method,
        // auth, headers) before any tool ran. 5xx: the bridge answers 502 for
        // both "could not authenticate" and "upstream failed mid-request", so
        // it cannot prove the tool did not run.
        const message = `the Botyard MCP proxy answered HTTP ${response.status}${detail ? `: ${detail}` : ""}`;
        if (response.status >= 400 && response.status < 500) throw new TransportError(message, where);
        throw ambiguous(message);
      }

      let message: unknown;
      try {
        message = await readRpcResponse(response, id, d.signal);
      } catch (err) {
        if (d.signal.aborted) throw ambiguous(`${describeEnd(d)} while reading the response`, err);
        throw ambiguous(`unreadable response from the Botyard MCP proxy: ${err instanceof Error ? err.message : String(err)}`, err);
      }
      if (!isRecord(message)) throw ambiguous("the Botyard MCP proxy sent no JSON-RPC response");

      const error = message["error"];
      if (isRecord(error)) {
        const code = typeof error["code"] === "number" ? error["code"] : undefined;
        const text = bounded(typeof error["message"] === "string" ? error["message"] : "no message");
        if (code === RPC_INVALID_PARAMS) throw new InvalidInputError(`invalid input: ${text}`, where);
        if (code === RPC_PARSE_ERROR || code === RPC_INVALID_REQUEST || code === RPC_METHOD_NOT_FOUND) {
          throw new TransportError(`botyard-mcp rejected the request (${code}): ${text}`, where);
        }
        throw ambiguous(`botyard-mcp answered with JSON-RPC error ${code ?? "(no code)"}: ${text}`);
      }
      if (!("result" in message)) throw ambiguous("the JSON-RPC response has neither result nor error");
      return message["result"];
    } finally {
      d.dispose();
    }
  }

  return {
    kind: "mcp",

    async listTools(opts) {
      const tools: ToolDescriptor[] = [];
      let cursor: string | undefined;
      // tools/list may paginate. Bound the loop against a server that never ends it.
      for (let page = 0; page < 100; page++) {
        const result = await rpc("tools/list", cursor === undefined ? {} : { cursor }, opts, undefined);
        if (!isRecord(result) || !Array.isArray(result["tools"])) {
          throw new TransportError("tools/list returned no tool array", { transport: "mcp" });
        }
        for (const tool of result["tools"]) {
          if (!isRecord(tool) || typeof tool["name"] !== "string") continue;
          const description = tool["description"];
          tools.push({
            name: tool["name"],
            description: typeof description === "string" ? description : undefined,
            inputSchema: tool["inputSchema"],
            outputSchema: tool["outputSchema"],
          });
        }
        const next = result["nextCursor"];
        if (typeof next !== "string" || next === "") return tools;
        cursor = next;
      }
      throw new TransportError("tools/list did not finish paginating", { transport: "mcp" });
    },

    async callTool(name, args, opts) {
      const result = await rpc("tools/call", { name, arguments: args }, opts, name);
      if (!isRecord(result)) {
        throw new OutcomeUnknownError("tools/call returned no result object; the tool may have run", { tool: name, transport: "mcp" });
      }
      const content = result["content"];
      return {
        content: Array.isArray(content) ? content : [],
        ...("structuredContent" in result ? { structuredContent: result["structuredContent"] } : {}),
        isError: result["isError"] === true,
      } satisfies ToolResult;
    },
  };
}

/**
 * Read the JSON-RPC response for `id` from a JSON or SSE body. Server
 * notifications and requests on the stream are skipped.
 */
async function readRpcResponse(response: Response, id: number, signal: AbortSignal): Promise<unknown> {
  const body = await readBounded(response, signal);
  const type = response.headers.get("content-type") ?? "";
  if (!type.includes("text/event-stream")) {
    return matching(JSON.parse(body), id);
  }
  // SSE: events are separated by a blank line; an event's data is its
  // `data:` lines joined with "\n".
  for (const event of body.split(/\r?\n\r?\n/)) {
    const data = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n");
    if (data === "") continue;
    const found = matching(JSON.parse(data), id);
    if (found !== undefined) return found;
  }
  throw new Error("the event stream ended without a response");
}

function matching(message: unknown, id: number): unknown {
  const messages = Array.isArray(message) ? message : [message];
  return messages.find((m) => isRecord(m) && m["id"] === id && ("result" in m || "error" in m));
}

async function readBounded(response: Response, signal: AbortSignal): Promise<string> {
  const { text, truncated } = await readUpTo(response, signal, MAX_RESPONSE_BYTES);
  if (truncated) throw new Error(`response exceeds ${MAX_RESPONSE_BYTES} bytes`);
  if (signal.aborted) throw new Error("aborted");
  return text;
}

/**
 * Read at most `max` bytes of the body, then cancel the rest. Stops early,
 * without error, when `signal` aborts. Cancellation is started, never
 * awaited, on both paths.
 */
async function readUpTo(response: Response, signal: AbortSignal, max: number): Promise<{ text: string; truncated: boolean }> {
  if (response.body === null) return { text: "", truncated: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  const onAbort = (): void => void reader.cancel().catch(() => undefined);
  if (signal.aborted) onAbort();
  else signal.addEventListener("abort", onAbort, { once: true });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const room = max - total;
      if (value.byteLength > room) {
        chunks.push(value.subarray(0, room));
        truncated = true;
        // Start cancellation, but never wait for it: the underlying source's
        // cleanup may not settle, and the call's deadline must still hold.
        // Cancelling closes the stream at once, so nothing reads it again.
        void reader.cancel().catch(() => undefined);
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
  return { text: Buffer.concat(chunks).toString("utf8"), truncated };
}

/** Up to {@link MAX_ERROR_BODY_BYTES} of a failure body; "" when it cannot be read. */
async function errorDetail(response: Response, signal: AbortSignal): Promise<string> {
  try {
    return (await readUpTo(response, signal, MAX_ERROR_BODY_BYTES)).text;
  } catch {
    return "";
  }
}

function socketCode(err: unknown): string | undefined {
  // undici wraps the socket error: TypeError("fetch failed", { cause }).
  for (let e: unknown = err, depth = 0; isObject(e) && depth < 4; e = e["cause"], depth++) {
    const code = e["code"];
    if (typeof code === "string" && /^E[A-Z_]+$/.test(code)) return code;
  }
  return undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
