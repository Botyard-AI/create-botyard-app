import { describe, expect, test } from "vitest"
import { packageNameProblem, pageName } from "../src/names.ts"

describe("packageNameProblem", () => {
  test.each(["my-app", "app2", "a.b_c~d", "@acme/my-app", "x".repeat(214)])(
    "accepts %s",
    (name) => {
      expect(packageNameProblem(name)).toBeNull()
    }
  )

  test.each([
    ["", "is empty"],
    ["x".repeat(215), "is longer than 214 characters"],
    ["My-App", "must be lowercase"],
    [".app", 'must not start with "." or "_"'],
    ["_app", 'must not start with "." or "_"'],
    ["my app", "may only contain"],
    ["café", "may only contain"],
    ["@acme/", "may only contain"],
    ["a/b", "may only contain"],
    ["node_modules", "is reserved"],
    ["http", "is the name of a Node.js core module"],
  ])("rejects %j", (name, problem) => {
    expect(packageNameProblem(name)).toContain(problem)
  })
})

describe("pageName", () => {
  test("drops the scope and caps the length at 80", () => {
    expect(pageName("@acme/quotes")).toBe("quotes")
    expect(pageName("quotes")).toBe("quotes")
    expect(pageName("q".repeat(100))).toHaveLength(80)
  })
})
