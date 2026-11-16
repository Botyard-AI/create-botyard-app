import assert from "node:assert/strict";
import { test } from "node:test";

import { BotPageToolError, MemberDirectory, parseMember } from "../src/index.ts";
import { fakeTools, membersHandler } from "./fakes.ts";

test("parseMember reads the list_org_members shape", () => {
  assert.deepEqual(
    parseMember({ user_id: "u1", role_id: "owner", user: { user_id: "u1", email: "a@b.io", name: "A" } }),
    { userId: "u1", email: "a@b.io", name: "A", role: "owner", avatarUrl: null },
  );
  assert.equal(parseMember({ role_id: "owner", user: {} }), null);
  assert.equal(parseMember("nope"), null);
});

test("lookup by email is case-insensitive, and by user id", async () => {
  const directory = new MemberDirectory(fakeTools());
  assert.equal((await directory.lookup("jakob@botyard.io"))?.userId, "u-jakob");
  assert.equal((await directory.lookup("u-vera"))?.name, "Vera");
  assert.equal(await directory.lookup("stranger@botyard.io"), null);
});

test("the member list is cached for the TTL and shared by concurrent lookups", async () => {
  let now = 0;
  const tools = fakeTools();
  const directory = new MemberDirectory(tools, { ttlMs: 1000, now: () => now });
  await Promise.all([directory.lookup("a"), directory.lookup("b"), directory.lookup("c")]);
  assert.equal(tools.count("list_org_members"), 1);
  now = 999;
  await directory.lookup("unknown-subject");
  assert.equal(tools.count("list_org_members"), 1, "an unknown subject must not force a refetch");
  now = 1000;
  await directory.lookup("a");
  assert.equal(tools.count("list_org_members"), 2);
});

test("paginates until a short page", async () => {
  const many = Array.from({ length: 5 }, (_, i) => ({ user_id: `u${i}`, role_id: "member", user: { email: `u${i}@x.io` } }));
  const tools = fakeTools().on("list_org_members", membersHandler(many));
  const directory = new MemberDirectory(tools, { pageSize: 2 });
  assert.equal((await directory.list()).length, 5);
  assert.deepEqual(
    tools.calls.map((call) => call.args),
    [
      { limit: 2, offset: 0 },
      { limit: 2, offset: 2 },
      { limit: 2, offset: 4 },
    ],
  );
});

test("serves stale data with backoff when a refresh fails", async () => {
  let now = 0;
  let fail = false;
  const tools = fakeTools();
  const ok = membersHandler();
  tools.on("list_org_members", (args) => {
    if (fail) throw new Error("platform down");
    return ok(args);
  });
  const directory = new MemberDirectory(tools, { ttlMs: 1000, retryAfterMs: 100, now: () => now });
  await directory.lookup("u-jakob");
  fail = true;
  now = 2000;
  assert.equal((await directory.lookup("u-jakob"))?.userId, "u-jakob");
  assert.equal(tools.count("list_org_members"), 2);
  now = 2050;
  await directory.lookup("u-jakob");
  assert.equal(tools.count("list_org_members"), 2, "backs off before retrying");
  now = 2100;
  await directory.lookup("u-jakob");
  assert.equal(tools.count("list_org_members"), 3);
});

test("rejects with BotPageToolError when there is no data at all", async () => {
  const tools = fakeTools().on("list_org_members", () => {
    throw new Error("platform down");
  });
  await assert.rejects(new MemberDirectory(tools).lookup("x"), BotPageToolError);
  const bad = fakeTools().on("list_org_members", () => ({ nope: true }));
  await assert.rejects(new MemberDirectory(bad).lookup("x"), /no members array/);
});
