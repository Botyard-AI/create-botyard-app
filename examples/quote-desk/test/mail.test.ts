import { createBotPage } from "@botyard/botpage"
import { OutcomeUnknownError, ToolError, TransportError } from "@botyard/runtime"
import { describe, expect, test } from "vitest"
import {
  MailInbox,
  address,
  cleanBody,
  normSubject,
  parseMailState,
  type MailState,
} from "../server/mail.ts"
import { MEMBER_CACHE } from "../server/members.ts"
import { mockRuntime } from "./helpers.ts"

const ORIGIN = "0b6c1c9e-3d1a-4f7e-9a51-2f0f3c2b9d10"
const NOW = new Date("2026-11-10T09:00:00Z")

type Mail = {
  id: string
  from: string
  subject: string
  text: string
  headers?: Record<string, string>
  received_at?: string
}

/** The inbox, with these emails stored (fixtures/dev.json members: Ada, Grace). */
function setup(mails: Mail[], fail: Record<string, Error[]> = {}, state?: MailState) {
  const posts: { conversation_id: unknown; message: string }[] = []
  const created: unknown[] = []
  const saved: MailState[] = []
  const take = (tool: string) => {
    const err = fail[tool]?.shift()
    if (err !== undefined) throw err
  }
  const tools = mockRuntime({
    search_inbound_emails: (args) => {
      take("search_inbound_emails")
      const since = String(args["since"])
      const page = mails
        .filter((m) => (m.received_at ?? NOW.toISOString()) >= since)
        .map((m) => ({ inbound_email_id: m.id, received_at: m.received_at ?? NOW.toISOString() }))
      return { items: page, total: page.length, has_more: false }
    },
    get_inbound_email: (args) => {
      take("get_inbound_email")
      const m = mails.find((x) => x.id === args["inbound_email_id"])
      if (m === undefined) throw new ToolError("Inbound email not found")
      return {
        inbound_email_id: m.id,
        from_address: m.from,
        subject: m.subject,
        text_body: m.text,
        html_body: null,
        headers: m.headers ?? {},
        received_at: m.received_at ?? NOW.toISOString(),
      }
    },
    create_conversation: (args) => {
      take("create_conversation")
      created.push(args)
      return { conversation_id: `conv-${String(created.length)}` }
    },
    send_message_to_self: (args) => {
      take("send_message_to_self")
      posts.push({ conversation_id: args["conversation_id"], message: String(args["message"]) })
      return { status: "delivered" }
    },
  })
  const log: string[] = []
  const inbox = new MailInbox({
    tools,
    botpage: createBotPage({ tools, env: {}, members: MEMBER_CACHE }),
    origin: ORIGIN,
    state: state ?? { since: "2026-11-10T08:00:00Z", handled: [], threads: {} },
    save: (s) => saved.push(s),
    now: () => NOW,
    log: (l) => log.push(l),
  })
  return { inbox, posts, created, saved, log }
}

const GRACE_MAIL: Mail = {
  id: "m-1",
  from: "Grace Hopper <Grace@Example.com>",
  subject: "Q-2026-0200 terms",
  text: "Can we make Q-2026-0200 Net 45?\n\nOn Monday Ada wrote:\n> old stuff",
}

describe("the mail inbox", () => {
  test("posts a member's email into a new thread with them, once", async () => {
    const t = setup([GRACE_MAIL])
    await t.inbox.tick()
    await t.inbox.tick()
    expect(t.created).toEqual([
      {
        title: "Email · Q-2026-0200 terms · Grace Hopper",
        origin_conversation_id: ORIGIN,
        members: [{ actor_type: "user", actor_id: "user-grace" }],
      },
    ])
    expect(t.posts).toHaveLength(1)
    const msg = t.posts[0]?.message ?? ""
    expect(msg).toContain("> Can we make Q-2026-0200 Net 45?")
    expect(msg).not.toContain("old stuff")
    expect(msg).toContain("Quotes mentioned: Q-2026-0200.")
    expect(msg).toContain("The sender's address is not verified")
    expect(t.saved.at(-1)?.handled.map((h) => h.outcome)).toEqual(["posted"])
  })

  test("a reply goes into the same thread", async () => {
    const t = setup([GRACE_MAIL, { ...GRACE_MAIL, id: "m-2", subject: "RE: Q-2026-0200 terms" }])
    await t.inbox.tick()
    expect(t.created).toHaveLength(1)
    expect(t.posts.map((p) => p.conversation_id)).toEqual(["conv-1", "conv-1"])
  })

  test.each([
    ["a stranger", { from: "mallory@evil.example" }, "the sender is not an org member"],
    ["an auto-reply", { headers: { "Auto-Submitted": "auto-replied" } }, "an automatic email"],
    ["an out-of-office", { subject: "Out of office" }, "an automatic reply"],
    [
      "a DMARC failure",
      { headers: { "Authentication-Results": "mx; dmarc=fail header.from=example.com" } },
      "it failed DMARC",
    ],
  ])("skips %s", async (_name, change, reason) => {
    const t = setup([{ ...GRACE_MAIL, ...change }])
    await t.inbox.tick()
    expect(t.posts).toEqual([])
    expect(t.saved.at(-1)?.handled).toEqual([
      { id: "m-1", outcome: "skipped", detail: reason, at: NOW.toISOString() },
    ])
  })

  test("mail from before the inbox started is left alone", async () => {
    const t = setup([{ ...GRACE_MAIL, received_at: "2026-11-10T07:00:00Z" }])
    await t.inbox.tick()
    expect(t.posts).toEqual([])
  })

  test("an unreachable platform ends the pass; the email is posted on the next", async () => {
    const t = setup([GRACE_MAIL], { send_message_to_self: [new TransportError("down")] })
    await t.inbox.tick()
    expect(t.posts).toEqual([])
    await t.inbox.tick()
    expect(t.created).toHaveLength(1) // the thread made on the first pass is reused
    expect(t.posts).toHaveLength(1)
  })

  test("a refused email is tried 3 times, then skipped", async () => {
    const no = () => new ToolError("no")
    const t = setup([GRACE_MAIL], { send_message_to_self: [no(), no(), no()] })
    for (let i = 0; i < 4; i++) await t.inbox.tick()
    expect(t.posts).toEqual([])
    expect(t.saved.at(-1)?.handled.map((h) => [h.outcome, h.detail])).toEqual([
      ["skipped", "failed 3 times"],
    ])
  })

  test("a post whose outcome is unknown is not posted again", async () => {
    const t = setup([GRACE_MAIL], { send_message_to_self: [new OutcomeUnknownError("lost")] })
    await t.inbox.tick()
    await t.inbox.tick()
    expect(t.posts).toEqual([])
    expect(t.saved.at(-1)?.handled.map((h) => h.outcome)).toEqual(["unknown"])
  })

  test("the saved state round-trips, and a restart posts nothing twice", async () => {
    const first = setup([GRACE_MAIL])
    await first.inbox.tick()
    const stored = parseMailState(JSON.parse(JSON.stringify(first.inbox.state())))
    const again = setup([GRACE_MAIL], {}, stored)
    await again.inbox.tick()
    expect(again.posts).toEqual([])
  })
})

test("helpers", () => {
  expect(address("Grace <Grace@Example.com>")).toBe("grace@example.com")
  expect(normSubject("Re: FWD:  Quote  terms")).toBe("quote terms")
  expect(
    cleanBody({
      from: "",
      subject: "",
      text: null,
      html: "<p>Hi</p><p>there</p>",
      headers: {},
      received_at: null,
    })
  ).toBe("Hi\nthere")
})
