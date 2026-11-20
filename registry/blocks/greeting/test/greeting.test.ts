import { describe, expect, it } from "vitest"
import { greeting } from "../server/greeting.ts"

describe("greeting", () => {
  it("greets the viewer by name", () => {
    expect(greeting("Ada")).toBe("Hello, Ada!")
  })

  it("greets without a name", () => {
    expect(greeting(null)).toBe("Hello!")
    expect(greeting("  ")).toBe("Hello!")
  })
})
