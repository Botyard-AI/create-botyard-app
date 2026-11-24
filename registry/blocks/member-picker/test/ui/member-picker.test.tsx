import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, test } from "vitest"
import { MemberPicker, type MemberPickerProps } from "@/components/member-picker"
import { filterMembers, memberLabel } from "@/lib/org-members"
import { parseMembersResponse } from "@/lib/org-members-contract"

const { members } = parseMembersResponse({
  members: [
    { userId: "user-ada", name: "Ada Lovelace", email: "ada@example.com", role: "owner" },
    { userId: "user-grace", name: "Grace Hopper", email: "grace@example.com", role: "member" },
    { userId: "user-x", name: null, email: null, role: null },
  ],
})

function render(props: Partial<MemberPickerProps> & Pick<MemberPickerProps, "members">): string {
  return renderToStaticMarkup(<MemberPicker value={null} onChange={() => undefined} {...props} />)
}

describe("MemberPicker", () => {
  test("lists every member with their role", () => {
    const html = render({ members: { status: "ready", members } })
    expect(html).toContain("Ada Lovelace")
    expect(html).toContain("grace@example.com")
    expect(html).toContain("owner")
    expect(html).toContain("3 members")
  })

  test("checks the chosen member", () => {
    const html = render({ members: { status: "ready", members }, value: "user-grace" })
    const checked = html.split("<input").filter((tag) => tag.includes('checked=""'))
    expect(checked).toHaveLength(1)
    expect(checked[0]).toContain('value="user-grace"')
  })

  test("loading, error and an empty org", () => {
    expect(render({ members: { status: "loading" } })).toContain('aria-busy="true"')
    expect(
      render({ members: { status: "error", message: "/api/members answered 503" } })
    ).toContain("/api/members answered 503")
    expect(render({ members: { status: "ready", members: [] } })).toContain("No member matches.")
  })
})

describe("filterMembers", () => {
  test("matches name or email, ignoring case", () => {
    expect(filterMembers(members, "GRACE").map((m) => m.userId)).toEqual(["user-grace"])
    expect(filterMembers(members, "ada@").map((m) => m.userId)).toEqual(["user-ada"])
    expect(filterMembers(members, "  ")).toHaveLength(3)
    expect(filterMembers(members, "nobody")).toEqual([])
  })
})

describe("parseMembersResponse", () => {
  test("labels a member by name, email or id", () => {
    expect(members.map(memberLabel)).toEqual(["Ada Lovelace", "Grace Hopper", "user-x"])
  })

  test("rejects malformed answers", () => {
    const ok = { userId: "u", name: null, email: null, role: null }
    expect(() => parseMembersResponse({})).toThrow()
    expect(() => parseMembersResponse({ members: [{ ...ok, userId: 7 }] })).toThrow()
    expect(() => parseMembersResponse({ members: [{ ...ok, email: 7 }] })).toThrow()
    // A field the server stopped sending is an error, not a silent null.
    const noRole = { userId: "u", name: null, email: null }
    expect(() => parseMembersResponse({ members: [noRole] })).toThrow("role: missing")
  })
})
