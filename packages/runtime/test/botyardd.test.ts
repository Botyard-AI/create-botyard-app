import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, test } from "node:test";

import {
  createRuntime,
  InvalidInputError,
  OutcomeUnknownError,
  ToolError,
  TransportError,
  UnknownToolError,
} from "../src/index.ts";
import { fakeBotyardd, tempDir, TOOLS_LIST } from "./helpers.ts";

/**
 * A runtime over a fake botyardd whose `tools list` succeeds and whose
 * `tools call` behaves as given. The list is fetched first so the call's
 * behaviour file is in place for the call alone.
 */
async function setup(call: { exit: number; stdout?: string; stderr?: string; sleepMs?: number }) {
  const fake = await fakeBotyardd();
  const rt = createRuntime({ transport: "botyardd", botyarddPath: fake.path, env: { PATH: process.env["PATH"] ?? "" } });
  await fake.behave({ exit: 0, stdout: TOOLS_LIST });
  await rt.listTools();
  await fake.behave(call);
  const calls = async () => (await fake.invocations()).filter((i) => i.argv[1] === "call");
  return { rt, fake, calls };
}

describe("botyardd transport", () => {
  test("exit 0: passes args on stdin, never in argv, and returns structured content", async () => {
    const { rt, calls } = await setup({
      exit: 0,
      stdout: JSON.stringify({ content: [{ type: "text", text: "{}" }], structured_content: { members: [] }, is_error: false }),
    });
    const result = await rt.call("list_org_members", { query: "secret-ish" }, { timeoutMs: 2500 });
    assert.deepEqual(result, { members: [] });
    const [only, ...rest] = await calls();
    assert.equal(rest.length, 0);
    assert.deepEqual(only?.argv, ["tools", "call", "--timeout-seconds", "3", "--input", "-", "list_org_members"]);
    assert.deepEqual(JSON.parse(only?.stdin ?? ""), { query: "secret-ish" });
  });

  test("exit 3 maps to ToolError carrying the tool's message", async () => {
    const { rt } = await setup({
      exit: 3,
      stdout: JSON.stringify({ content: [{ type: "text", text: "task not found" }], is_error: true }),
    });
    await assert.rejects(rt.call("create_task", {}), (err: unknown) => {
      return err instanceof ToolError && err.message === "task not found" && err.tool === "create_task" && err.transport === "botyardd";
    });
  });

  test("exit 2 maps to InvalidInputError", async () => {
    const { rt } = await setup({ exit: 2, stderr: "botyardd tools: tool arguments must be a JSON object\n" });
    await assert.rejects(rt.call("create_task", {}), (err: unknown) => err instanceof InvalidInputError && /JSON object/.test(err.message));
  });

  test("exit 4 maps to OutcomeUnknownError and is never retried", async () => {
    const { rt, calls } = await setup({ exit: 4, stderr: "botyardd tools: OUTCOME_UNKNOWN: the tool may have run; do not automatically retry\n" });
    await assert.rejects(rt.call("create_task", { title: "x" }), OutcomeUnknownError);
    assert.equal((await calls()).length, 1);
  });

  test("exit 1 maps to TransportError", async () => {
    const { rt, calls } = await setup({ exit: 1, stderr: "botyardd tools: daemon unavailable\n" });
    await assert.rejects(rt.call("create_task", {}), (err: unknown) => err instanceof TransportError && /daemon unavailable/.test(err.message));
    assert.equal((await calls()).length, 1);
  });

  test("exit 1 for an unassigned tool maps to UnknownToolError", async () => {
    const { rt } = await setup({ exit: 1, stderr: "botyardd tools: tool is unknown or no longer assigned\n" });
    await assert.rejects(rt.call("create_task", {}), UnknownToolError);
  });

  test("an exit code it does not know is outcome-unknown, not a guess", async () => {
    const { rt } = await setup({ exit: 9 });
    await assert.rejects(rt.call("create_task", {}), OutcomeUnknownError);
  });

  test("exit 0 with an unreadable body is outcome-unknown: the tool may have run", async () => {
    const { rt } = await setup({ exit: 0, stdout: "{not json" });
    await assert.rejects(rt.call("create_task", {}), OutcomeUnknownError);
  });

  test("being killed at the deadline is outcome-unknown, and is not retried", async () => {
    // The CLI gets --timeout-seconds plus a grace period before the kill; a
    // caller abort ends it at once, which exercises the same kill path.
    const { rt, calls } = await setup({ exit: 0, sleepMs: 10_000 });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 300);
    await assert.rejects(rt.call("create_task", {}, { signal: controller.signal }), (err: unknown) => {
      return err instanceof OutcomeUnknownError && /aborted/.test(err.message);
    });
    assert.equal((await calls()).length, 1);
  });

  test("an already-aborted signal fails before anything is spawned", async () => {
    const { rt, calls } = await setup({ exit: 0 });
    await assert.rejects(rt.call("create_task", {}, { signal: AbortSignal.abort() }), TransportError);
    assert.equal((await calls()).length, 0);
  });

  test("a missing binary is a TransportError", async () => {
    const dir = await tempDir();
    const rt = createRuntime({ transport: "botyardd", botyarddPath: join(dir, "nope"), env: {} });
    await assert.rejects(rt.call("list_org_members"), (err: unknown) => err instanceof TransportError && /ENOENT/.test(err.message));
  });

  test("tools list reads snake_case descriptors", async () => {
    const fake = await fakeBotyardd();
    await fake.behave({
      exit: 0,
      stdout: JSON.stringify([{ name: "botyard__list_org_members", description: "d", input_schema: { type: "object" }, output_schema: { type: "object" } }]),
    });
    const rt = createRuntime({ transport: "botyardd", botyarddPath: fake.path, env: {} });
    assert.deepEqual(await rt.listTools(), [
      { name: "botyard__list_org_members", description: "d", inputSchema: { type: "object" }, outputSchema: { type: "object" } },
    ]);
    assert.equal(await rt.resolveToolName("list_org_members"), "botyard__list_org_members");
  });

  test("a failing tools list is a TransportError and is not cached", async () => {
    const fake = await fakeBotyardd();
    await fake.behave({ exit: 1, stderr: "botyardd tools: daemon unavailable" });
    const rt = createRuntime({ transport: "botyardd", botyarddPath: fake.path, env: {} });
    await assert.rejects(rt.listTools(), TransportError);
    await fake.behave({ exit: 0, stdout: TOOLS_LIST });
    assert.equal((await rt.listTools()).length, 2);
  });
});
