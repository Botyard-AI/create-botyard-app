// Prints the app's recent requests and errors from data/trace.jsonl:
//
//   npm run trace                  the last 50 records
//   npm run trace -- -n 200        the last 200
//   npm run trace -- --errors      warnings and errors only, with stacks
//   npm run trace -- --id <id>     everything about one request (the id a 500 sent back)
//   npm run trace -- --json        raw JSON lines, for jq
//
// It reads the file from disk: the trace is never served over HTTP.
import { parseArgs } from "node:util"
import { appRoot } from "../server/config.ts"
import { readTrace, traceFilePath, TraceUnavailableError } from "../server/trace.ts"

const { values } = parseArgs({
  options: {
    n: { type: "string", short: "n", default: "50" },
    errors: { type: "boolean", default: false },
    id: { type: "string" },
    json: { type: "boolean", default: false },
  },
})

let file: string
try {
  file = traceFilePath(appRoot).real
} catch (err) {
  // The server runs without a trace in this case, so there is none to show.
  if (!(err instanceof TraceUnavailableError)) throw err
  process.stdout.write(`No trace: ${err.message}\n`)
  process.exit(0)
}
let records = readTrace(file)
if (records.length === 0) {
  process.stdout.write(`No trace yet in ${file}. Start the app and make a request.\n`)
  process.exit(0)
}
if (values.errors) records = records.filter((r) => r["level"] !== "info")
if (values.id !== undefined) records = records.filter((r) => r["requestId"] === values.id)
const count = Number(values.n)
records = records.slice(-(Number.isInteger(count) && count > 0 ? count : 50))

if (records.length === 0) process.stdout.write("No records match.\n")
for (const record of records) {
  process.stdout.write(`${values.json ? JSON.stringify(record) : format(record)}\n`)
}

function format(record: Record<string, unknown>): string {
  const { time, level, event, error, ...rest } = record
  const head = `${str(time)} ${str(level).toUpperCase().padEnd(5)} ${str(event)}`
  const fields =
    event === "request"
      ? `${str(rest["method"])} ${str(rest["path"])} ${str(rest["status"])} ${str(rest["ms"])}ms viewer=${str(rest["viewer"])} id=${str(rest["requestId"])}`
      : Object.entries(rest)
          .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
          .join(" ")
  return [head, fields].filter((part) => part !== "").join(" ") + formatError(error)
}

/** An error's stack on lines of its own, indented; or the error as JSON. */
function formatError(error: unknown): string {
  if (error === undefined) return ""
  const stack = typeof error === "object" && error !== null && "stack" in error ? error.stack : null
  if (typeof stack === "string") return `\n    ${stack.split("\n").join("\n    ")}`
  return ` error=${JSON.stringify(error)}`
}

function str(value: unknown): string {
  if (value === undefined) return "-"
  return typeof value === "string" ? value : JSON.stringify(value)
}
