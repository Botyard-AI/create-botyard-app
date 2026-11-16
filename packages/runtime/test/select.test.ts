import assert from "node:assert/strict";
import { createServer } from "node:net";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, describe, test } from "node:test";

import { createMockTransport, createRuntime, selectTransport, TransportError } from "../src/index.ts";
import { isLoopbackUrl } from "../src/runtime.ts";
import { tempDir } from "./helpers.ts";

async function listeningSocket(): Promise<string> {
  const dir = await tempDir();
  const path = join(dir, "daemon.sock");
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(path, resolve));
  after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return path;
}

describe("transport selection", () => {
  test("picks botyardd when the daemon socket exists", async () => {
    const socket = await listeningSocket();
    const picked = selectTransport({ env: { BOTYARD_SOCKET: socket, MCP_PROXY_PORT: "9092" } });
    assert.equal(picked.transport.kind, "botyardd");
    assert.match(picked.reason, /daemon socket/);
  });

  test("finds the socket under BOTYARD_HOME and under HOME/.botyard", async () => {
    const socket = await listeningSocket();
    const home = join(socket, "..");
    assert.equal(selectTransport({ env: { BOTYARD_HOME: home } }).transport.kind, "botyardd");
    // HOME/.botyard/daemon.sock: point HOME at a dir whose .botyard is the socket's dir.
    const fakeHome = await tempDir();
    const { symlink } = await import("node:fs/promises");
    await symlink(home, join(fakeHome, ".botyard"));
    assert.equal(selectTransport({ env: { HOME: fakeHome } }).transport.kind, "botyardd");
  });

  test("a botyardd binary without a running daemon is not native (OpenClaw pods ship the binary)", async () => {
    const home = await tempDir();
    await writeFile(join(home, "daemon.sock"), "not a socket");
    const picked = selectTransport({ env: { BOTYARD_HOME: home, MCP_PROXY_PORT: "9092" } });
    assert.equal(picked.transport.kind, "mcp");
    assert.equal(picked.reason, "MCP endpoint http://127.0.0.1:9092/mcp");
  });

  test("picks the loopback MCP proxy from MCP_PROXY_PORT", async () => {
    const home = await tempDir();
    const picked = selectTransport({ env: { HOME: home, MCP_PROXY_PORT: "9100" } });
    assert.equal(picked.transport.kind, "mcp");
    assert.match(picked.reason, /127\.0\.0\.1:9100\/mcp/);
  });

  test("BOTYARD_RUNTIME_MCP_URL overrides the proxy port", async () => {
    const home = await tempDir();
    const picked = selectTransport({ env: { HOME: home, MCP_PROXY_PORT: "9100", BOTYARD_RUNTIME_MCP_URL: "http://localhost:7000/mcp" } });
    assert.match(picked.reason, /localhost:7000/);
  });

  test("BOTYARD_RUNTIME_MCP_URL may not send tool traffic off-host", async () => {
    const home = await tempDir();
    for (const url of ["https://evil.example/mcp", "http://10.0.0.1:9092/mcp", "http://127.0.0.1.evil.example/mcp", "http://localhost.evil.example/mcp"]) {
      // Auto-detection and an env-forced mcp transport are both refused.
      assert.throws(() => selectTransport({ env: { HOME: home, BOTYARD_RUNTIME_MCP_URL: url } }), TransportError, url);
      assert.throws(
        () => selectTransport({ env: { HOME: home, BOTYARD_RUNTIME_TRANSPORT: "mcp", BOTYARD_RUNTIME_MCP_URL: url } }),
        TransportError,
        url,
      );
    }
  });

  test("only application code may choose a non-loopback MCP URL", async () => {
    const home = await tempDir();
    const picked = selectTransport({ env: { HOME: home }, mcpUrl: "https://mcp.internal.example/mcp" });
    assert.equal(picked.transport.kind, "mcp");
    assert.match(picked.reason, /mcp\.internal\.example/);
  });

  test("isLoopbackUrl accepts loopback forms only", () => {
    for (const url of ["http://127.0.0.1:9092/mcp", "http://127.9.9.9/mcp", "http://localhost:1/mcp", "http://[::1]:9/mcp", "http://0x7f.1/mcp", "http://2130706433/mcp", "https://LOCALHOST/mcp"]) {
      assert.equal(isLoopbackUrl(url), true, url);
    }
    for (const url of ["http://evil.example/mcp", "http://127.0.0.1.evil.example/mcp", "http://localhost.evil.example/", "ftp://127.0.0.1/", "http://10.0.0.1/", "not a url"]) {
      assert.equal(isLoopbackUrl(url), false, url);
    }
  });

  test("rejects a malformed MCP_PROXY_PORT", async () => {
    const home = await tempDir();
    assert.throws(() => selectTransport({ env: { HOME: home, MCP_PROXY_PORT: "nope" } }), TransportError);
  });

  test("never picks the mock on its own, and names every signal it checked", async () => {
    const home = await tempDir();
    assert.throws(
      () => selectTransport({ env: { HOME: home } }),
      (err: unknown) =>
        err instanceof TransportError &&
        err.message.includes(join(home, ".botyard", "daemon.sock")) &&
        err.message.includes("MCP_PROXY_PORT") &&
        err.message.includes("BOTYARD_RUNTIME_TRANSPORT=mock"),
    );
  });

  test("an explicit transport wins over detection, from options or env", async () => {
    const socket = await listeningSocket();
    assert.equal(selectTransport({ env: { BOTYARD_SOCKET: socket }, transport: "mock" }).transport.kind, "mock");
    assert.equal(selectTransport({ env: { BOTYARD_SOCKET: socket, BOTYARD_RUNTIME_TRANSPORT: "mcp" } }).transport.kind, "mcp");
    assert.equal(selectTransport({ env: { BOTYARD_RUNTIME_TRANSPORT: "botyardd" } }).transport.kind, "botyardd");
    const custom = createMockTransport();
    assert.equal(selectTransport({ env: {}, transport: custom }).transport, custom);
  });

  test("rejects an unknown BOTYARD_RUNTIME_TRANSPORT", () => {
    assert.throws(() => selectTransport({ env: { BOTYARD_RUNTIME_TRANSPORT: "carrier-pigeon" } }), TransportError);
  });

  test("the mock loads a fixture file from BOTYARD_RUNTIME_MOCK_FIXTURES", async () => {
    const dir = await tempDir();
    const fixtures = join(dir, "fixtures.json");
    await writeFile(
      fixtures,
      JSON.stringify({
        identity: { id: "bot-1", slug: "quote-desk", org_id: "org-1", org_slug: "acme" },
        tools: { list_org_members: { result: { members: [{ name: "Ada" }] } } },
      }),
    );
    const rt = createRuntime({ env: { BOTYARD_RUNTIME_TRANSPORT: "mock", BOTYARD_RUNTIME_MOCK_FIXTURES: fixtures } });
    assert.deepEqual(await rt.call("list_org_members"), { members: [{ name: "Ada" }] });
    assert.deepEqual(await rt.getIdentity(), {
      bot: { id: "bot-1", slug: "quote-desk", name: undefined },
      org: { id: "org-1", slug: "acme" },
      transport: "mock",
    });
  });
});
