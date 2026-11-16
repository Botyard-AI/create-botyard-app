import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";

import { serve } from "@hono/node-server";
import { Hono } from "hono";

import { BotPageConfigError, createBotPage } from "../src/index.ts";
import { viewerMiddleware, type BotPageEnv } from "../src/hono.ts";
import { memberGuard, withMember, withViewer as nextWithViewer } from "../src/next.ts";
import { guardListen, listenLoopback, requireMember, withViewer } from "../src/node.ts";
import { captureLogger, fakeTools } from "./fakes.ts";

const env = { NODE_ENV: "test" };
const servers: Server[] = [];
after(() => {
  for (const server of servers) server.close();
});

async function get(port: number, headers: Record<string, string> = {}): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`http://127.0.0.1:${port}/`, { headers });
  return { status: response.status, body: await response.json() };
}

test("node: requireMember answers 401/403 and passes members through", async () => {
  const botpage = createBotPage({ tools: fakeTools(), env });
  const server = createServer(
    requireMember(botpage, (_req, res, viewer) => {
      res.end(JSON.stringify({ name: viewer.name }));
    }),
  );
  servers.push(server);
  const { port } = await listenLoopback(server, 0, { botpage });
  assert.deepEqual(await get(port, { "x-forwarded-user": "jakob@botyard.io" }), { status: 200, body: { name: "Jakob" } });
  assert.equal((await get(port)).status, 401);
  assert.equal((await get(port, { "x-forwarded-user": "stranger@else.io" })).status, 403);
});

test("node: withViewer passes null, and directory outages are 503", async () => {
  const down = fakeTools().on("list_org_members", () => {
    throw new Error("down");
  });
  const botpage = createBotPage({ tools: down, env });
  const server = createServer(
    withViewer(botpage, (_req, res, viewer) => {
      res.end(JSON.stringify({ viewer }));
    }),
  );
  servers.push(server);
  const { port } = await listenLoopback(server, 0);
  assert.deepEqual(await get(port), { status: 200, body: { viewer: null } });
  const outage = await get(port, { "x-forwarded-user": "jakob@botyard.io" });
  assert.equal(outage.status, 503);
  assert.deepEqual((outage.body as { error: string }).error, "directory_unavailable");
});

test("node: listenLoopback refuses non-loopback hosts before binding", async () => {
  const server = createServer();
  await assert.rejects(listenLoopback(server, 0, { host: "0.0.0.0" }), BotPageConfigError);
  assert.equal(server.listening, false);
});

test("node: guardListen warns on a wildcard bind", async () => {
  const logger = captureLogger();
  const botpage = createBotPage({ tools: fakeTools(), env, logger });
  const server = createServer();
  servers.push(server);
  guardListen(server, { botpage });
  await new Promise<void>((resolve) => server.listen(0, "0.0.0.0", resolve));
  assert.match(logger.warnings.join("\n"), /bound to 0\.0\.0\.0, not loopback/);
});

test("hono: viewerMiddleware sets the viewer and guards members", async () => {
  const botpage = createBotPage({ tools: fakeTools(), env });
  const app = new Hono<BotPageEnv>();
  app.use("/open/*", viewerMiddleware(botpage));
  app.use("/members/*", viewerMiddleware(botpage, { require: "member", roles: ["owner"] }));
  app.get("/open/me", (c) => c.json({ viewer: c.get("viewer") }));
  app.get("/members/me", (c) => c.json({ name: c.get("viewer")?.kind === "member" ? c.get("viewer") : null }));

  const anonymous = await app.request("/open/me");
  assert.deepEqual(await anonymous.json(), { viewer: null });
  const owner = await app.request("/members/me", { headers: { "x-forwarded-user": "jakob@botyard.io" } });
  assert.equal(owner.status, 200);
  const viewerRole = await app.request("/members/me", { headers: { "x-forwarded-user": "vera@botyard.io" } });
  assert.equal(viewerRole.status, 403);
  assert.deepEqual((await viewerRole.json()).error, "role_not_allowed");
  const none = await app.request("/members/me");
  assert.equal(none.status, 401);
  assert.equal(none.headers.get("cache-control"), "no-store");
});

test("hono on node-server: the socket feeds the peer check and dev override", async () => {
  const botpage = createBotPage({ tools: fakeTools(), env, devViewer: "u-vera" });
  const app = new Hono<BotPageEnv>();
  app.use(viewerMiddleware(botpage));
  app.get("/", (c) => c.json({ subject: c.get("viewer")?.subject ?? null }));
  const port = await new Promise<number>((resolve) => {
    const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, (info) => resolve(info.port)) as Server;
    servers.push(server);
  });
  assert.deepEqual(await get(port), { status: 200, body: { subject: "u-vera" } });
});

test("next: withMember / withViewer / memberGuard", async () => {
  const botpage = createBotPage({ tools: fakeTools(), env });
  const GET = withMember(botpage, (_req, ctx: { params: Promise<{ id: string }> }, viewer) =>
    ctx.params.then(({ id }) => Response.json({ id, role: viewer.role })),
  );
  const ctx = { params: Promise.resolve({ id: "q1" }) };
  const ok = await GET(new Request("http://x/", { headers: { "x-forwarded-user": "u-jakob" } }), ctx);
  assert.deepEqual(await ok.json(), { id: "q1", role: "owner" });
  assert.equal((await GET(new Request("http://x/"), ctx)).status, 401);

  const open = nextWithViewer(botpage, (_req, _ctx: undefined, viewer) => Response.json({ kind: viewer?.kind ?? null }));
  assert.deepEqual(await (await open(new Request("http://x/"), undefined)).json(), { kind: null });

  const guard = memberGuard(botpage);
  assert.equal(await guard(new Request("http://x/", { headers: { "x-forwarded-user": "vera@botyard.io" } })), undefined);
  assert.equal((await guard(new Request("http://x/", { headers: { "x-forwarded-user": "nope@x.io" } })))?.status, 403);
});
