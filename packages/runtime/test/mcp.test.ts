import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { createRuntime, InvalidInputError, OutcomeUnknownError, ToolError, TransportError, UnknownToolError } from "../src/index.ts";
import { callResult, connectionError, json, scriptedFetch, sse, toolsList } from "./helpers.ts";

const NAMES = ["list_org_members", "create_task"];

function runtime(answers: Parameters<typeof scriptedFetch>[0]) {
  const scripted = scriptedFetch(answers);
  const rt = createRuntime({ transport: "mcp", mcpUrl: "http://127.0.0.1:9092/mcp", fetch: scripted.fetch, env: {} });
  const calls = () => scripted.requests.filter((r) => r["method"] === "tools/call");
  return { rt, requests: scripted.requests, calls };
}

describe("mcp transport", () => {
  test("sends a JSON-RPC tools/call with no credentials and reads an SSE answer", async () => {
    let headers: Headers | undefined;
    const scripted = scriptedFetch([toolsList(NAMES), callResult({ content: [], structuredContent: { total: 1 }, isError: false })]);
    const rt = createRuntime({
      transport: "mcp",
      mcpUrl: "http://127.0.0.1:9092/mcp",
      env: {},
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        headers = new Headers(init?.headers);
        return scripted.fetch(input, init);
      }) as typeof fetch,
    });
    assert.deepEqual(await rt.call("list_org_members", { q: 1 }), { total: 1 });
    const call = scripted.requests[1];
    assert.equal(call?.["method"], "tools/call");
    assert.deepEqual(call?.["params"], { name: "list_org_members", arguments: { q: 1 } });
    assert.equal(headers?.get("authorization"), null);
    assert.match(headers?.get("accept") ?? "", /text\/event-stream/);
  });

  test("reads a plain JSON answer too", async () => {
    const { rt } = runtime([
      (b) => json({ jsonrpc: "2.0", id: b["id"], result: { tools: [{ name: "create_task", inputSchema: {} }] } }),
      (b) => json({ jsonrpc: "2.0", id: b["id"], result: { content: [{ type: "text", text: "done" }], isError: false } }),
    ]);
    assert.equal(await rt.call("create_task"), "done");
  });

  test("skips notifications on the event stream", async () => {
    const { rt } = runtime([
      toolsList(NAMES),
      (b) =>
        new Response(
          `event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}\n\n` +
            `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: b["id"], result: { content: [], structuredContent: { ok: true }, isError: false } })}\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        ),
    ]);
    assert.deepEqual(await rt.call("create_task"), { ok: true });
  });

  test("follows tools/list pagination", async () => {
    const { rt } = runtime([toolsList(["a"], { nextCursor: "p2" }), toolsList(["b"])]);
    assert.deepEqual((await rt.listTools()).map((t) => t.name), ["a", "b"]);
  });

  test("isError maps to ToolError", async () => {
    const { rt } = runtime([toolsList(NAMES), callResult({ content: [{ type: "text", text: "not found" }], isError: true })]);
    await assert.rejects(rt.call("create_task"), (err: unknown) => err instanceof ToolError && err.message === "not found" && err.transport === "mcp");
  });

  test("FastMCP argument validation maps to InvalidInputError", async () => {
    const { rt } = runtime([
      toolsList(NAMES),
      callResult({ content: [{ type: "text", text: "1 validation error for call[create_task]\ntitle\n  Missing required argument" }], isError: true }),
    ]);
    await assert.rejects(rt.call("create_task"), (err: unknown) => err instanceof InvalidInputError && !(err instanceof UnknownToolError));
  });

  test("JSON-RPC -32602 maps to InvalidInputError", async () => {
    const { rt } = runtime([toolsList(NAMES), (b) => sse({ jsonrpc: "2.0", id: b["id"], error: { code: -32602, message: "bad params" } })]);
    await assert.rejects(rt.call("create_task"), InvalidInputError);
  });

  test("a refused connection is a TransportError: nothing was sent", async () => {
    const { rt, calls } = runtime([toolsList(NAMES), () => connectionError("ECONNREFUSED")]);
    await assert.rejects(rt.call("create_task"), (err: unknown) => err instanceof TransportError && /ECONNREFUSED/.test(err.message));
    assert.equal(calls().length, 1);
  });

  test("HTTP 4xx is a TransportError", async () => {
    const { rt } = runtime([toolsList(NAMES), () => json({ error: "not found" }, 404)]);
    await assert.rejects(rt.call("create_task"), TransportError);
  });

  test("HTTP 502 after sending a call is outcome-unknown and is never retried", async () => {
    const { rt, calls } = runtime([toolsList(NAMES), () => json({ error: "botyard-mcp unreachable" }, 502)]);
    await assert.rejects(rt.call("create_task", { title: "x" }), OutcomeUnknownError);
    assert.equal(calls().length, 1);
  });

  test("a connection reset mid-call is outcome-unknown and is never retried", async () => {
    const { rt, calls } = runtime([toolsList(NAMES), () => connectionError("ECONNRESET")]);
    await assert.rejects(rt.call("create_task"), OutcomeUnknownError);
    assert.equal(calls().length, 1);
  });

  test("a response with no matching JSON-RPC message is outcome-unknown", async () => {
    const { rt } = runtime([toolsList(NAMES), () => sse({ jsonrpc: "2.0", id: 999_999, result: {} })]);
    await assert.rejects(rt.call("create_task"), OutcomeUnknownError);
  });

  test("the deadline after dispatch is outcome-unknown", async () => {
    const scripted = scriptedFetch([toolsList(NAMES)]);
    let sent = 0;
    const rt = createRuntime({
      transport: "mcp",
      mcpUrl: "http://127.0.0.1:9092/mcp",
      env: {},
      // Lists normally; never answers a call, but honours the abort signal.
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        if (body["method"] === "tools/list") return scripted.fetch(input, init);
        sent++;
        return new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        });
      }) as typeof fetch,
    });
    await assert.rejects(rt.call("create_task", {}, { timeoutMs: 100 }), (err: unknown) => {
      return err instanceof OutcomeUnknownError && /deadline passed/.test(err.message);
    });
    assert.equal(sent, 1);
  });

  /** A body that streams 64 KiB chunks forever, counting how many were pulled. */
  function endlessBody(status: number): { response: Response; pulled: () => number } {
    let pulled = 0;
    const chunk = new Uint8Array(64 * 1024).fill(0x61);
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++;
        controller.enqueue(chunk);
      },
    });
    return { response: new Response(body, { status }), pulled: () => pulled };
  }

  /** A body that sends nothing and never ends. */
  function stalledBody(status: number): Response {
    return new Response(new ReadableStream<Uint8Array>({ pull: () => new Promise<void>(() => undefined) }), { status });
  }

  test("an oversized 5xx body is read only up to a bound, then cancelled", async () => {
    const endless = endlessBody(502);
    const { rt, calls } = runtime([toolsList(NAMES), () => endless.response]);
    await assert.rejects(rt.call("create_task", { title: "x" }), (err: unknown) => {
      return err instanceof OutcomeUnknownError && /HTTP 502/.test(err.message) && err.message.length < 1000;
    });
    assert.ok(endless.pulled() <= 3, `pulled ${endless.pulled()} chunks`);
    assert.equal(calls().length, 1);
  });

  test("an oversized 4xx body is bounded too, and still a TransportError", async () => {
    const endless = endlessBody(404);
    const { rt } = runtime([toolsList(NAMES), () => endless.response]);
    await assert.rejects(rt.call("create_task"), TransportError);
    assert.ok(endless.pulled() <= 3, `pulled ${endless.pulled()} chunks`);
  });

  test("a stalled 5xx body cannot outlive the deadline, and the outcome stays unknown", async () => {
    const { rt } = runtime([toolsList(NAMES), () => stalledBody(502)]);
    const started = Date.now();
    await assert.rejects(rt.call("create_task", {}, { timeoutMs: 200 }), (err: unknown) => {
      return err instanceof OutcomeUnknownError && /HTTP 502/.test(err.message);
    });
    assert.ok(Date.now() - started < 2000);
  });

  test("a stalled 4xx body cannot outlive the deadline, and is still a TransportError", async () => {
    const { rt } = runtime([toolsList(NAMES), () => stalledBody(401)]);
    await assert.rejects(rt.call("create_task", {}, { timeoutMs: 200 }), (err: unknown) => {
      return err instanceof TransportError && /HTTP 401/.test(err.message);
    });
  });

  test("an oversized success body is refused as outcome-unknown, without reading it all", async () => {
    // 32 MiB cap / 64 KiB chunks = 512 chunks; the reader must stop right after.
    const endless = endlessBody(200);
    const { rt } = runtime([toolsList(NAMES), () => endless.response]);
    await assert.rejects(rt.call("create_task"), (err: unknown) => err instanceof OutcomeUnknownError && /exceeds/.test(err.message));
    assert.ok(endless.pulled() <= 515, `pulled ${endless.pulled()} chunks`);
  });

  test("a failing tools/list is a TransportError, even on an ambiguous status", async () => {
    const { rt } = runtime([() => json({}, 502)]);
    await assert.rejects(rt.call("create_task"), (err: unknown) => err instanceof TransportError);
  });

  test("refuses a URL that carries credentials", () => {
    assert.throws(() => createRuntime({ transport: "mcp", mcpUrl: "http://u:p@127.0.0.1:9092/mcp", env: {} }), TransportError);
  });
});
