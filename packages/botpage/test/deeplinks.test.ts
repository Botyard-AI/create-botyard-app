import assert from "node:assert/strict"
import { test } from "vitest"

import {
  BotPageToolError,
  DeeplinkParamsError,
  DeeplinkUnavailableError,
  Deeplinks,
  UnknownDestinationError,
  buildDeeplink,
  createBotPage,
} from "../src/index.ts"
import { FakeTools } from "./fakes.ts"

// Shapes as list_navigation_destinations returns them today (no path/search)
// and as it will once platform task 5822 adds the templates.
const TODAY = [
  {
    key: "bots-botSlug-chat",
    label: "Open chat",
    breadcrumb: [],
    click_path: null,
    keywords: [],
    required_params: ["botSlug"],
    owner_only: false,
    curated: false,
  },
]
// The shape Botyard PR 5702 (task 5822) adds: `search` is a list of name/value pairs.
const WITH_TEMPLATES = [
  {
    key: "audit",
    label: "Audit log",
    required_params: [],
    path: "/orgs/$orgSlug/audit-events",
    search: [],
  },
  {
    key: "bots-botSlug",
    label: "Bot",
    required_params: ["botSlug"],
    path: "/orgs/$orgSlug/bots/$botSlug",
    search: [],
  },
  {
    key: "bots-botSlug-compute",
    label: "Compute",
    required_params: ["botSlug"],
    path: "/orgs/$orgSlug/bots/$botSlug",
    search: [{ name: "tab", value: "compute" }],
  },
  {
    key: "vault",
    label: "Vault",
    required_params: ["secretKeyPath"],
    path: "/orgs/$orgSlug/vault",
    search: [
      { name: "secret", value: "$secretKeyPath" },
      { name: "tab", value: "vault" },
    ],
  },
]

function tools(destinations: unknown[], wrap = true): FakeTools {
  return new FakeTools()
    .on("list_navigation_destinations", (args) => {
      const query = String(args?.["query"] ?? "")
      const hits = destinations.filter((d) => JSON.stringify(d).includes(query))
      return wrap ? { result: hits } : hits
    })
    .on("get_identity", () => ({ id: "b1", slug: "anvil", org_slug: "botyard" }))
}

test("resolves a key through the directory, filling the org from get_identity", async () => {
  const fake = tools(WITH_TEMPLATES)
  const links = new Deeplinks(fake)
  assert.equal(await links.resolve("audit"), "https://app.botyard.io/orgs/botyard/audit-events")
  assert.equal(
    await links.resolve("bots-botSlug-compute", { botSlug: "anvil" }),
    "https://app.botyard.io/orgs/botyard/bots/anvil?tab=compute"
  )
  assert.equal(
    await links.resolve("vault", { secretKeyPath: "github/token x" }),
    "https://app.botyard.io/orgs/botyard/vault?secret=github%2Ftoken+x&tab=vault"
  )
  assert.deepEqual(fake.calls.find((call) => call.tool === "list_navigation_destinations")?.args, {
    query: "audit",
  })
  assert.equal(fake.count("get_identity"), 1, "org slug is fetched once")
})

test("bare-list responses work too, and entries are cached", async () => {
  const fake = tools(WITH_TEMPLATES, false)
  const links = new Deeplinks(fake, { orgSlug: "acme" })
  await links.resolve("bots-botSlug", { botSlug: "neo" })
  assert.equal(
    await links.resolve("bots-botSlug", { botSlug: "neo" }),
    "https://app.botyard.io/orgs/acme/bots/neo"
  )
  assert.equal(fake.count("list_navigation_destinations"), 1)
  assert.equal(fake.count("get_identity"), 0)
})

test("throws DeeplinkUnavailableError while the directory has no route templates", async () => {
  const links = new Deeplinks(tools(TODAY))
  await assert.rejects(
    links.resolve("bots-botSlug-chat", { botSlug: "anvil" }),
    DeeplinkUnavailableError
  )
})

test("unknown keys need an exact match", async () => {
  const links = new Deeplinks(tools(WITH_TEMPLATES))
  await assert.rejects(
    links.resolve("bots"),
    UnknownDestinationError,
    "a substring hit is not a match"
  )
})

test("params must match required_params exactly and be single safe segments", async () => {
  const links = new Deeplinks(tools(WITH_TEMPLATES))
  await assert.rejects(links.resolve("bots-botSlug"), DeeplinkParamsError)
  await assert.rejects(
    links.resolve("bots-botSlug", { botSlug: "a", extra: "b" }),
    DeeplinkParamsError
  )
  for (const bad of ["", "a/b", "..", ".", "a\\b"]) {
    await assert.rejects(
      links.resolve("bots-botSlug", { botSlug: bad }),
      DeeplinkParamsError,
      JSON.stringify(bad)
    )
  }
  assert.equal(
    await links.resolve("bots-botSlug", { botSlug: "a b?" }),
    "https://app.botyard.io/orgs/botyard/bots/a%20b%3F"
  )
})

test("refuses odd templates rather than building a wrong link", () => {
  const base = { key: "k", label: "k", requiredParams: [], search: [] }
  assert.throws(
    () => buildDeeplink({ ...base, path: "/elsewhere/x" }, "o", {}),
    DeeplinkUnavailableError
  )
  assert.throws(
    () => buildDeeplink({ ...base, path: "/orgs/$orgSlug/$sneaky" }, "o", {}),
    DeeplinkUnavailableError
  )
  assert.throws(
    () => buildDeeplink({ ...base, path: "/orgs/$orgSlug/a%2F.." }, "o", {}),
    DeeplinkUnavailableError
  )
})

test("appUrl must be https; tool failures surface as BotPageToolError", async () => {
  assert.throws(() => new Deeplinks(new FakeTools(), { appUrl: "http://app.botyard.io" }), /https/)
  const staging = new Deeplinks(tools(WITH_TEMPLATES), {
    appUrl: "https://staging.botyard.io/ignored",
    orgSlug: "o",
  })
  assert.equal(await staging.resolve("audit"), "https://staging.botyard.io/orgs/o/audit-events")
  const broken = new FakeTools().on("list_navigation_destinations", () => {
    throw new Error("down")
  })
  await assert.rejects(new Deeplinks(broken).resolve("audit"), BotPageToolError)
})

test("createBotPage exposes deeplinks", async () => {
  const botpage = createBotPage({ tools: tools(WITH_TEMPLATES), env: {} })
  assert.equal(
    await botpage.deeplinks.resolve("audit"),
    "https://app.botyard.io/orgs/botyard/audit-events"
  )
})

test("an object-shaped search is tolerated; an unreadable one makes the route unavailable", async () => {
  const objectShape = [
    {
      key: "c",
      required_params: ["botSlug"],
      path: "/orgs/$orgSlug/bots/$botSlug",
      search: { tab: "compute" },
    },
  ]
  assert.equal(
    await new Deeplinks(tools(objectShape), { orgSlug: "o" }).resolve("c", { botSlug: "b" }),
    "https://app.botyard.io/orgs/o/bots/b?tab=compute"
  )
  const broken = [
    { key: "c", required_params: [], path: "/orgs/$orgSlug/x", search: [{ name: "tab" }] },
  ]
  await assert.rejects(
    new Deeplinks(tools(broken), { orgSlug: "o" }).resolve("c"),
    DeeplinkUnavailableError
  )
})
