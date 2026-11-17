// The org's bots, from the platform. Used to pick and check the reviewer bot.
import type { ToolCaller } from "@botyard/runtime"
import { items, num, record, str } from "../shared/narrow.ts"
import type { BotOption } from "../shared/types.ts"

const PAGE = 100
/** list_org_bots pages at most 100 at a time; stop after this many bots. */
const MAX_BOTS = 1000

/** Every bot in the org but this one, read page by page. */
export async function listOrgBots(tools: ToolCaller): Promise<BotOption[]> {
  const bots: BotOption[] = []
  for (let offset = 0; offset < MAX_BOTS; offset += PAGE) {
    const r = record(await tools.call("list_org_bots", { limit: PAGE, offset }), "list_org_bots")
    const page = items(r, "bots", "list_org_bots", PAGE, (v, p) => {
      const b = record(v, p)
      return { slug: str(b, "slug", p, 63), name: str(b, "name", p) }
    })
    bots.push(...page)
    if (page.length < PAGE || bots.length >= num(r, "total", "list_org_bots")) break
  }
  return bots
}
