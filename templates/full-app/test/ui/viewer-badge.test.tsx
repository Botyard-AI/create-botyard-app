import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, test } from "vitest"
import { ViewerBadge } from "@/components/viewer-badge"
import { initials } from "@/lib/initials"
import { parseViewer } from "@/lib/api"

const member = parseViewer({
  kind: "member",
  viewerType: "user",
  subject: "ada@example.com",
  source: "x-forwarded-user",
  userId: "user-ada",
  email: "ada@example.com",
  name: "Ada Lovelace",
  role: "owner",
  avatarUrl: null,
})

function render(...args: Parameters<typeof ViewerBadge>): string {
  return renderToStaticMarkup(<ViewerBadge {...args[0]} />)
}

describe("ViewerBadge", () => {
  test("a member: initials, name and role", () => {
    const html = render({ state: { status: "ready", viewer: member } })
    expect(html).toContain("Signed in as")
    expect(html).toContain("Ada Lovelace")
    expect(html).toContain(">AL<")
    expect(html).toContain("owner")
  })

  test("someone outside the org", () => {
    const viewer = parseViewer({
      kind: "unknown",
      viewerType: "user",
      subject: "m@example.org",
      source: "x-forwarded-user",
      email: "m@example.org",
    })
    const html = render({ state: { status: "ready", viewer } })
    expect(html).toContain("m@example.org")
    expect(html).toContain("Not in this org")
  })

  test("a bot", () => {
    const viewer = parseViewer({
      kind: "bot",
      viewerType: "bot",
      subject: "bot-1",
      source: "x-forwarded-user",
      botId: "bot-1",
    })
    expect(render({ state: { status: "ready", viewer } })).toContain("A bot")
  })

  test("nobody, loading and error", () => {
    expect(render({ state: { status: "ready", viewer: null } })).toContain("Not signed in")
    expect(render({ state: { status: "loading" } })).toContain('aria-busy="true"')
    expect(render({ state: { status: "error", message: "/api/me answered 503" } })).toContain(
      "/api/me answered 503"
    )
  })
})

describe("parseViewer", () => {
  test("rejects malformed viewers", () => {
    expect(() => parseViewer({ kind: "admin" })).toThrow()
    expect(() => parseViewer("ada")).toThrow()
    expect(() => parseViewer({ ...member, name: 7 })).toThrow()
  })

  test("initials", () => {
    expect(initials("Ada Lovelace")).toBe("AL")
    expect(initials("grace@example.com")).toBe("GE")
    expect(initials("")).toBe("?")
  })
})
