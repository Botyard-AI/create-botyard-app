import assert from "node:assert/strict";
import { test } from "node:test";

import { parseBotShadowAddress, parseForwardedUser, trustedForwardedUser } from "../src/index.ts";
import { nodeReq } from "./fakes.ts";

test("parseForwardedUser accepts an email or an id", () => {
  assert.equal(parseForwardedUser("  jakob@botyard.io "), "jakob@botyard.io");
  assert.equal(parseForwardedUser("ac73e0df-313e-4038-b37f-ca2632e30b3d"), "ac73e0df-313e-4038-b37f-ca2632e30b3d");
  assert.equal(parseForwardedUser(["one@botyard.io"]), "one@botyard.io");
});

test("parseForwardedUser rejects repeated, empty, oversized and malformed values", () => {
  assert.equal(parseForwardedUser(["a@botyard.io", "b@botyard.io"]), null);
  assert.equal(parseForwardedUser("a@botyard.io, b@botyard.io"), null);
  assert.equal(parseForwardedUser("   "), null);
  assert.equal(parseForwardedUser([]), null);
  assert.equal(parseForwardedUser("a b@botyard.io"), null);
  assert.equal(parseForwardedUser("a@botyard.io\u0000"), null);
  assert.equal(parseForwardedUser(`${"a".repeat(321)}`), null);
});

test("trustedForwardedUser reads only x-forwarded-user", async () => {
  const source = trustedForwardedUser();
  const result = await source.identify(
    nodeReq({
      "x-botyard-user-email": "forged@evil.test",
      "x-user-email": "forged@evil.test",
      "x-forwarded-email": "forged@evil.test",
      "x-auth-request-email": "forged@evil.test",
      "x-botyard-user": "forged@evil.test",
      authorization: "Bearer forged",
    }),
  );
  assert.deepEqual(result, { ok: false, reason: "missing", source: "trusted-forwarded-user" });
});

test("trustedForwardedUser identifies the viewer from the header", async () => {
  const result = await trustedForwardedUser().identify(nodeReq({ "x-forwarded-user": "jakob@botyard.io" }));
  assert.deepEqual(result, {
    ok: true,
    subject: "jakob@botyard.io",
    viewerType: "unknown",
    email: "jakob@botyard.io",
    audience: null,
    source: "trusted-forwarded-user",
  });
  const byId = await trustedForwardedUser().identify(new Request("http://x/", { headers: { "x-forwarded-user": "u-1" } }));
  assert.equal(byId.ok && byId.email, null);
});

test("trustedForwardedUser reports malformed headers", async () => {
  const result = await trustedForwardedUser().identify(nodeReq({ "x-forwarded-user": ["a@x.io", "b@x.io"] }));
  assert.deepEqual(result, { ok: false, reason: "malformed", source: "trusted-forwarded-user" });
});

test("trustedForwardedUser refuses a non-loopback peer unless told otherwise", async () => {
  const req = nodeReq({ "x-forwarded-user": "jakob@botyard.io" }, { localAddress: "10.0.0.2", remoteAddress: "10.0.0.9" });
  const refused = await trustedForwardedUser().identify(req);
  assert.equal(refused.ok, false);
  assert.equal(!refused.ok && refused.reason, "untrusted_peer");
  const allowed = await trustedForwardedUser({ requireLoopbackPeer: false }).identify(req);
  assert.equal(allowed.ok, true);
});

test("a bot's shadow address is a bot identity: subject = bot id, no email", async () => {
  const address = "bot+FF5A77D8-333a-4f80-975e-41485c751ee3@Bots.Botyard.Internal";
  const result = await trustedForwardedUser().identify(nodeReq({ "x-forwarded-user": address }));
  assert.deepEqual(result, {
    ok: true,
    viewerType: "bot",
    subject: "ff5a77d8-333a-4f80-975e-41485c751ee3",
    botId: "ff5a77d8-333a-4f80-975e-41485c751ee3",
    email: null,
    audience: null,
    source: "trusted-forwarded-user",
  });
  for (const other of [
    "bot@bots.botyard.internal",
    "bot+x@botyard.internal",
    "bot+x@bots.botyard.internal.evil.io",
    "evil+bot+x@bots.botyard.internal",
    "bot+-x@bots.botyard.internal",
  ]) {
    assert.equal(parseBotShadowAddress(other), null, other);
    const person = await trustedForwardedUser().identify(nodeReq({ "x-forwarded-user": other }));
    assert.equal(person.ok && person.viewerType, "unknown", other);
  }
});
