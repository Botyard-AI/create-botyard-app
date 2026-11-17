import { describe, expect, test } from "vitest"
import {
  FileFetchError,
  MAX_VERDICT_BYTES,
  fetchSmallFile,
  fileHosts,
  parseVerdict,
  type Fetch,
} from "../server/review/verdict.ts"

const HOSTS = fileHosts(" Files.Example.org , ,other.example.org")
const LINK = "https://files.example.org/verdict.json?X-Amz-Signature=deadbeef"

const serving =
  (body: ConstructorParameters<typeof Response>[0], init: ResponseInit = {}): Fetch =>
  () =>
    Promise.resolve(new Response(body, init))

async function refused(link: string, f: Fetch = serving("{}")): Promise<FileFetchError> {
  try {
    await fetchSmallFile(link, HOSTS, f)
  } catch (err) {
    if (err instanceof FileFetchError) return err
    throw err
  }
  throw new Error("expected a FileFetchError")
}

describe("fetching verdict.json", () => {
  test("reads an allowed https link", async () => {
    expect(await fetchSmallFile(LINK, HOSTS, serving('{"ok":1}'))).toBe('{"ok":1}')
  })

  test("never follows redirects", async () => {
    let init: RequestInit | undefined
    await fetchSmallFile(LINK, HOSTS, (_url, i) => {
      init = i
      return Promise.resolve(new Response("{}"))
    })
    expect(init?.redirect).toBe("error")
    expect(init?.signal).toBeInstanceOf(AbortSignal)
  })

  test.each([
    ["http://files.example.org/v.json", "not https"],
    ["https://user:pw@files.example.org/v.json", "carries credentials"],
    ["https://evil.example.com/v.json", "evil.example.com is not in QUOTE_DESK_FILE_HOSTS"],
    ["not a url", "not a URL"],
  ])("refuses %s", async (link, why) => {
    const err = await refused(link)
    expect(err.kind).toBe("refused")
    expect(err.message).toContain(why)
  })

  test("refuses files over the cap, declared or streamed", async () => {
    const big = "x".repeat(MAX_VERDICT_BYTES + 1)
    const declared = await refused(
      LINK,
      serving("{}", { headers: { "content-length": String(big.length) } })
    )
    expect(declared.kind).toBe("refused")
    const streamed = await refused(LINK, serving(big))
    expect(streamed.kind).toBe("refused")
  })

  test("refuses bytes that aren't UTF-8", async () => {
    expect((await refused(LINK, serving(new Uint8Array([0xff, 0xfe])))).kind).toBe("refused")
  })

  test("a failing read is worth trying again, and never names the link", async () => {
    const status = await refused(LINK, serving("no", { status: 503 }))
    expect(status.kind).toBe("failed")
    const network = await refused(LINK, () => Promise.reject(new Error(`boom ${LINK}`)))
    expect(network.kind).toBe("failed")
    for (const err of [status, network]) expect(err.message).not.toContain("X-Amz")
  })
})

describe("parsing verdict.json", () => {
  const ok = { quote_id: "Q-1", decision: "approve", note: " Fine. " }

  test("takes the decision, note and analysis", () => {
    expect(parseVerdict(JSON.stringify({ ...ok, analysis: "Long" }), "Q-1", "approved")).toEqual({
      decision: "approve",
      note: "Fine.",
      analysis: "Long",
    })
  })

  test.each([
    ["not json", "not JSON"],
    [JSON.stringify({ ...ok, terms: "NET30" }), "unknown field terms"],
    [JSON.stringify({ ...ok, quote_id: "Q-2" }), "quote_id is not Q-1"],
    [JSON.stringify({ ...ok, note: "  " }), "must say why"],
    [JSON.stringify({ ...ok, decision: "maybe" }), "decision"],
  ])("refuses %s", (text, why) => {
    expect(() => parseVerdict(text, "Q-1", "approved")).toThrow(why)
  })

  test("the decision must match the column", () => {
    expect(() => parseVerdict(JSON.stringify(ok), "Q-1", "changes-requested")).toThrow(
      'decision "approve" but the task is in changes-requested'
    )
  })
})
