// Publishes the running app as a Bot Page: `npm run expose`.
// Pass --persistent to keep the page until it is revoked; otherwise it expires
// after two hours. Start the app first (npm start, or npm run dev).
import { call } from "@botyard/runtime"
import { loadConfig } from "../server/config.ts"

const persistent = process.argv.includes("--persistent")
const config = await loadConfig()

const page: unknown = await call("expose_botpage", {
  port: config.port,
  name: config.name,
  ...(persistent ? { persistent: true, ttl_minutes: null } : {}),
})

const url = typeof page === "object" && page !== null && "url" in page ? page.url : undefined
if (typeof url === "string") {
  process.stdout.write(`${config.name} is published at ${url}\n`)
} else {
  process.stdout.write(`${JSON.stringify(page, null, 2)}\n`)
}
