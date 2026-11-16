import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  BotyardError,
  createMockTransport,
  createRuntime,
  InvalidInputError,
  OutcomeUnknownError,
  ToolError,
  TransportError,
  UnknownToolError,
  type ToolCaller,
  type ToolDescriptor,
  type Transport,
} from "../src/index.ts";

describe("errors", () => {
  test("every error extends BotyardError and carries its name", () => {
    for (const E of [InvalidInputError, UnknownToolError, ToolError, OutcomeUnknownError, TransportError]) {
      const err = new E("m");
      assert.ok(err instanceof BotyardError);
      assert.ok(err instanceof Error);
      assert.equal(err.name, E.name);
    }
    assert.ok(new UnknownToolError("m") instanceof InvalidInputError);
  });
});

describe("name resolution", () => {
  test("uses the exact name, else the one `<prefix>__<name>` tool, with no hardcoded prefix", async () => {
    const mock = createMockTransport({ tools: { acme__list_org_members: { result: { n: 1 } }, create_task: { result: { id: 7 } } } });
    const rt = createRuntime({ transport: mock, env: {} });
    assert.deepEqual(await rt.call("list_org_members"), { n: 1 });
    assert.deepEqual(await rt.call("create_task"), { id: 7 });
    assert.deepEqual(
      mock.calls.map((c) => c.tool),
      ["acme__list_org_members", "create_task"],
    );
  });

  test("refuses to guess between two prefixed matches", async () => {
    const rt = createRuntime({ transport: createMockTransport({ tools: { a__x: { result: 1 }, b__x: { result: 2 } } }), env: {} });
    await assert.rejects(rt.call("x"), (err: unknown) => err instanceof InvalidInputError && /ambiguous/.test(err.message));
  });

  test("an unknown tool is UnknownToolError, without refetching a list it just fetched", async () => {
    let lists = 0;
    const inner = createMockTransport({ tools: { a: { result: 1 } } });
    const counting: Transport = { ...inner, listTools: (o) => (lists++, inner.listTools(o)) };
    const rt = createRuntime({ transport: counting, env: {} });
    await assert.rejects(rt.call("missing"), UnknownToolError);
    // The first miss happens right after the first fetch, so no refresh yet.
    assert.equal(lists, 1);
  });

  test("a tool assigned after start is found by the refresh", async (t) => {
    t.mock.timers.enable({ apis: ["Date"] });
    let names = ["a"];
    const transport: Transport = {
      kind: "mock",
      listTools: async () => names.map((name): ToolDescriptor => ({ name, inputSchema: {} })),
      callTool: async (name) => ({ content: [{ type: "text", text: name }], isError: false }),
    };
    const rt = createRuntime({ transport, env: {} });
    await rt.listTools();
    names = ["a", "b"];
    t.mock.timers.tick(10_000);
    assert.equal(await rt.call("b"), "b");
  });

  test("rejects a blank or spaced tool name and non-object args", async () => {
    const rt = createRuntime({ transport: "mock", env: {} });
    await assert.rejects(rt.call(""), InvalidInputError);
    await assert.rejects(rt.call("get identity"), InvalidInputError);
    await assert.rejects(rt.call("get_identity", [] as unknown as Record<string, unknown>), InvalidInputError);
    await assert.rejects(rt.call("get_identity", {}, { timeoutMs: 0 }), InvalidInputError);
  });
});

describe("results", () => {
  function single(result: { content: unknown[]; structuredContent?: unknown; isError?: boolean }, outputSchema?: unknown) {
    const transport: Transport = {
      kind: "mock",
      listTools: async () => [{ name: "t", inputSchema: {}, outputSchema }],
      callTool: async () => ({ isError: false, ...result }),
    };
    return createRuntime({ transport, env: {} });
  }

  test("prefers structuredContent", async () => {
    assert.deepEqual(await single({ content: [{ type: "text", text: "ignored" }], structuredContent: { a: 1 } }).call("t"), { a: 1 });
  });

  test("unwraps a FastMCP-wrapped primitive result", async () => {
    const rt = single({ content: [], structuredContent: { result: 42 } }, { "x-fastmcp-wrap-result": true });
    assert.equal(await rt.call("t"), 42);
  });

  test("parses a single JSON text block, else returns the text", async () => {
    assert.deepEqual(await single({ content: [{ type: "text", text: "[1,2]" }] }).call("t"), [1, 2]);
    assert.equal(await single({ content: [{ type: "text", text: "plain words" }] }).call("t"), "plain words");
  });

  test("returns other content blocks as they are, and nothing as undefined", async () => {
    const blocks = [{ type: "image", data: "x", mimeType: "image/png" }];
    assert.deepEqual(await single({ content: blocks }).call("t"), blocks);
    assert.equal(await single({ content: [] }).call("t"), undefined);
  });

  test("ToolError keeps the raw content and the canonical tool name", async () => {
    const mock = createMockTransport({ tools: { acme__t: { error: { kind: "tool", message: "nope" } } } });
    const rt = createRuntime({ transport: mock, env: {} });
    await assert.rejects(rt.call("t"), (err: unknown) => {
      return err instanceof ToolError && err.tool === "t" && err.message === "nope" && err.content.length === 1;
    });
  });

  test("OutcomeUnknownError surfaces once: the runtime never retries a call", async () => {
    const mock = createMockTransport({ tools: { create_task: { error: { kind: "outcome_unknown", message: "lost" } } } });
    const rt = createRuntime({ transport: mock, env: {} });
    await assert.rejects(rt.call("create_task", { title: "x" }), OutcomeUnknownError);
    assert.equal(mock.calls.length, 1);
  });

  test("a non-Botyard transport failure becomes a TransportError", async () => {
    const transport: Transport = {
      kind: "mock",
      listTools: async () => [{ name: "t", inputSchema: {} }],
      callTool: async () => {
        throw new Error("boom");
      },
    };
    await assert.rejects(createRuntime({ transport, env: {} }).call("t"), TransportError);
  });
});

describe("getIdentity", () => {
  test("reads get_identity and reports the transport", async () => {
    const rt = createRuntime({ transport: "mock", mock: { identity: { id: "b1", slug: "s", name: "N", org_id: "o1", org_slug: "acme" } }, env: {} });
    assert.deepEqual(await rt.getIdentity(), {
      bot: { id: "b1", slug: "s", name: "N" },
      org: { id: "o1", slug: "acme" },
      transport: "mock",
    });
  });

  test("falls back to the pod env when get_identity is not assigned", async () => {
    const transport: Transport = { kind: "mcp", listTools: async () => [], callTool: async () => ({ content: [], isError: false }) };
    const rt = createRuntime({ transport, env: { BOTYARD_BOT_ID: "b2", BOTYARD_ORG_ID: "o2", BOTYARD_ORG_SLUG: "acme" } });
    assert.deepEqual(await rt.getIdentity(), { bot: { id: "b2", slug: undefined, name: undefined }, org: { id: "o2", slug: "acme" }, transport: "mcp" });
  });

  test("a transport failure is not hidden behind the env fallback", async () => {
    const transport: Transport = {
      kind: "mcp",
      listTools: async () => {
        throw new TransportError("down");
      },
      callTool: async () => ({ content: [], isError: false }),
    };
    await assert.rejects(createRuntime({ transport, env: { BOTYARD_BOT_ID: "b" } }).getIdentity(), TransportError);
  });
});

describe("the shared contract", () => {
  test("a Runtime is a ToolCaller", () => {
    const caller: ToolCaller = createRuntime({ transport: "mock", env: {} });
    assert.equal(typeof caller.call, "function");
  });
});
