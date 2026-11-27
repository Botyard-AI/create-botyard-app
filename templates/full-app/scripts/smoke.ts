// Checks that a running app answers as it should, and prints a pass/fail table:
//
//   npm run smoke                  the app on this machine (the port in botyard.json)
//   npm run smoke -- <url>         another address, such as http://127.0.0.1:9000
//   npm run smoke -- --browser     the same checks for the published Bot Page (see below)
//
// It exits 1 when a check fails. The checks:
// - health:  GET /api/health answers 200;
// - ready:   GET /api/ready answers 200 (on 503, it names the failing checks);
// - index:   GET / serves the UI's index.html;
// - me:      GET /api/me answers { viewer }, null or a viewer with a kind;
// - guard:   GET /api/hello refuses someone who is not an org member with 403.
//
// Here the outsider is a made-up address in `x-forwarded-user`, which the app
// trusts on 127.0.0.1 only. Behind the Bot Page, Botyard sets that header
// itself, so the outsider is you, the bot: open the page in a browser signed
// in as the bot (self-view, see the botyard-botpages skill), then evaluate
// the function `npm run smoke -- --browser` prints in that tab. It runs these
// same checks there and returns the results as JSON. A bot is not an org member, so the
// guard check proves the members-only route and the proxy together.
import { parseArgs } from "node:util"
import { loadConfig } from "../server/config.ts"
import { smoke, table } from "./smoke-checks.ts"

const { values, positionals } = parseArgs({
  options: { browser: { type: "boolean", default: false } },
  allowPositionals: true,
})

if (values.browser) {
  // A function for the browser tool's evaluate, in a tab on the Bot Page
  // signed in as the bot. It resolves to the results as JSON.
  process.stdout.write(
    `async () => JSON.stringify(await (${smoke.toString()})(location.origin, {}, "bot"))\n`
  )
} else {
  const base = positionals[0] ?? `http://127.0.0.1:${String((await loadConfig()).port)}`
  const results = await smoke(base, { "x-forwarded-user": "smoke-outsider@example.com" }, null)
  process.stdout.write(`Smoke test of ${base}\n${table(results)}\n`)
  const failed = results.filter((r) => !r.ok).length
  process.stdout.write(failed === 0 ? "All checks passed.\n" : `${String(failed)} failed.\n`)
  process.exitCode = failed === 0 ? 0 : 1
}
