import assert from "node:assert/strict";
import { test } from "node:test";

import { BotPageAuthError, BotPageConfigError, createBotPage, type IdentitySource } from "../src/index.ts";
import { captureLogger, fakeTools, nodeReq } from "./fakes.ts";

const env = { NODE_ENV: "development" };

test("viewer enriches a member from the directory", async () => {
  const botpage = createBotPage({ tools: fakeTools(), env });
  const viewer = await botpage.viewer(nodeReq({ "x-forwarded-user": "jakob@botyard.io" }));
  assert.deepEqual(viewer, {
    kind: "member",
    subject: "jakob@botyard.io",
    viewerType: "user",
    source: "trusted-forwarded-user",
    userId: "u-jakob",
    email: "Jakob@Botyard.io",
    name: "Jakob",
    role: "owner",
    avatarUrl: null,
  });
});

test("viewer is unknown for a subject outside the org, and null without one", async () => {
  const botpage = createBotPage({ tools: fakeTools(), env });
  const viewer = await botpage.viewer(nodeReq({ "x-forwarded-user": "stranger@else.io" }));
  assert.deepEqual(viewer, {
    kind: "unknown",
    subject: "stranger@else.io",
    viewerType: "unknown",
    email: "stranger@else.io",
    source: "trusted-forwarded-user",
  });
  assert.equal(await botpage.viewer(nodeReq({})), null);
});

test("a bot viewer skips the member directory and is never a member", async () => {
  const tools = fakeTools();
  const botpage = createBotPage({ tools, env });
  const req = nodeReq({ "x-forwarded-user": "bot+b1@bots.botyard.internal" });
  assert.deepEqual(await botpage.viewer(req), {
    kind: "bot",
    viewerType: "bot",
    subject: "b1",
    botId: "b1",
    source: "trusted-forwarded-user",
  });
  await assert.rejects(botpage.requireMember(req), { status: 403, code: "not_a_member" });
  assert.equal(tools.count("list_org_members"), 0, "no enrichment for bots");
});

test("a dev viewer can be a bot shadow address", async () => {
  const botpage = createBotPage({ tools: fakeTools(), env, devViewer: "bot+b2@bots.botyard.internal" });
  const viewer = await botpage.viewer(nodeReq({}));
  assert.equal(viewer?.kind, "bot");
  assert.equal(viewer?.kind === "bot" && viewer.botId, "b2");
});

test("requireMember: 401 without a viewer, 403 for non-members and wrong roles", async () => {
  const botpage = createBotPage({ tools: fakeTools(), env });
  await assert.rejects(botpage.requireMember(nodeReq({})), (error: unknown) => {
    assert.ok(error instanceof BotPageAuthError);
    assert.equal(error.status, 401);
    assert.equal(error.reason, "missing");
    return true;
  });
  await assert.rejects(botpage.requireMember(nodeReq({ "x-forwarded-user": "stranger@else.io" })), {
    status: 403,
    code: "not_a_member",
  });
  await assert.rejects(botpage.requireMember(nodeReq({ "x-forwarded-user": "vera@botyard.io" }), { roles: ["owner"] }), {
    status: 403,
    code: "role_not_allowed",
  });
  const owner = await botpage.requireMember(nodeReq({ "x-forwarded-user": "u-jakob" }), { roles: ["owner"] });
  assert.equal(owner.name, "Jakob");
});

test("a custom identity source plugs in without other changes", async () => {
  const signed: IdentitySource = {
    name: "test-assertion",
    identify: (req) => {
      const token = req.headers instanceof Headers ? req.headers.get("x-test-assertion") : null;
      return token === "valid"
        ? { ok: true, subject: "u-vera", viewerType: "user", email: null, audience: "exp-1", source: "test-assertion" }
        : { ok: false, reason: token === null ? "missing" : "invalid_signature", source: "test-assertion" };
    },
  };
  const botpage = createBotPage({ tools: fakeTools(), env, identity: signed });
  const viewer = await botpage.requireMember(new Request("http://x/", { headers: { "x-test-assertion": "valid" } }));
  assert.equal(viewer.userId, "u-vera");
  assert.equal(viewer.source, "test-assertion");
  await assert.rejects(
    botpage.requireMember(new Request("http://x/", { headers: { "x-test-assertion": "forged", "x-forwarded-user": "u-jakob" } })),
    { status: 401, reason: "invalid_signature" },
  );
});

test("dev viewer override is refused in production", () => {
  assert.throws(
    () => createBotPage({ tools: fakeTools(), env: { NODE_ENV: "production", BOTYARD_DEV_VIEWER: "jakob@botyard.io" } }),
    BotPageConfigError,
  );
  assert.throws(
    () => createBotPage({ tools: fakeTools(), env: { NODE_ENV: "production" }, devViewer: "jakob@botyard.io" }),
    BotPageConfigError,
  );
});

test("dev viewer override applies on loopback when no identity is present", async () => {
  const botpage = createBotPage({ tools: fakeTools(), env: { ...env, BOTYARD_DEV_VIEWER: "jakob@botyard.io" } });
  const viewer = await botpage.viewer(nodeReq({}));
  assert.equal(viewer?.kind, "member");
  assert.equal(viewer?.source, "dev-viewer");
  const real = await botpage.viewer(nodeReq({ "x-forwarded-user": "vera@botyard.io" }));
  assert.equal(real?.subject, "vera@botyard.io", "a real header wins over the override");
  const malformed = await botpage.viewer(nodeReq({ "x-forwarded-user": ["a@x.io", "b@x.io"] }));
  assert.equal(malformed, null, "the override never papers over a bad credential");
});

test("dev viewer override is refused off loopback", async () => {
  const logger = captureLogger();
  const botpage = createBotPage({ tools: fakeTools(), env, devViewer: "jakob@botyard.io", logger });
  assert.equal(await botpage.viewer(nodeReq({}, { localAddress: "10.0.0.2", remoteAddress: "127.0.0.1" })), null);
  assert.equal(await botpage.viewer(new Request("http://x/")), null, "no socket and no known bind");
  assert.equal(logger.warnings.length, 1);
  assert.match(logger.warnings[0] ?? "", /dev viewer override/);
});

test("dev viewer override uses the recorded bind when requests have no socket", async () => {
  const logger = captureLogger();
  const onLoopback = createBotPage({ tools: fakeTools(), env, devViewer: "u-jakob", bind: "127.0.0.1", logger });
  assert.equal((await onLoopback.viewer(new Request("http://x/")))?.subject, "u-jakob");
  const wide = createBotPage({ tools: fakeTools(), env, devViewer: "u-jakob", logger });
  wide.noteBind("0.0.0.0");
  assert.equal(await wide.viewer(new Request("http://x/")), null);
  assert.match(logger.warnings.join("\n"), /bound to 0\.0\.0\.0, not loopback/);
});

test("a Unix socket bind counts as local", async () => {
  const logger = captureLogger();
  const botpage = createBotPage({ tools: fakeTools(), env, devViewer: "u-jakob", logger });
  botpage.noteBind("/tmp/app.sock");
  assert.equal(logger.warnings.length, 0);
  assert.equal((await botpage.viewer(new Request("http://x/")))?.subject, "u-jakob");
});
