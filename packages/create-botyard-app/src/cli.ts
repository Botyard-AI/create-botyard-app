import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"
import { packageNameProblem } from "./names.ts"
import { listTemplates, scaffold, ScaffoldError } from "./scaffold.ts"

export const DEFAULT_TEMPLATE = "full-app"

const USAGE = `Usage: create-botyard-app <directory> [options]

Creates a Botyard app in <directory>, which must be new or empty, from a
template bundled in this package. It downloads nothing and installs nothing.

Options:
  -t, --template <name>  Template to use (default: ${DEFAULT_TEMPLATE})
      --name <name>      npm package name (default: the directory name)
      --list-templates   List the bundled templates
  -v, --version          Print the version
  -h, --help             Print this help
`

type CliIo = {
  cwd: string
  templatesDir: string
  stdout: (text: string) => void
  stderr: (text: string) => void
}

const packageRoot = fileURLToPath(new URL("..", import.meta.url))

export function defaultIo(): CliIo {
  return {
    cwd: process.cwd(),
    templatesDir: path.join(packageRoot, "templates"),
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  }
}

/** Runs the CLI and returns the exit code: 0 ok, 1 failed, 2 usage error. */
export async function main(argv: string[], io: CliIo): Promise<number> {
  let parsed
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        template: { type: "string", short: "t", default: DEFAULT_TEMPLATE },
        name: { type: "string" },
        "list-templates": { type: "boolean", default: false },
        version: { type: "boolean", short: "v", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
    })
  } catch (err) {
    io.stderr(`${err instanceof Error ? err.message : String(err)}\n\n${USAGE}`)
    return 2
  }
  const { values, positionals } = parsed

  if (values.help) {
    io.stdout(USAGE)
    return 0
  }
  if (values.version) {
    io.stdout(`${await readVersion()}\n`)
    return 0
  }
  if (values["list-templates"]) {
    io.stdout(`${(await listTemplates(io.templatesDir)).join("\n")}\n`)
    return 0
  }

  const [dir, ...extra] = positionals
  if (dir === undefined || dir === "" || extra.length > 0) {
    io.stderr(`Expected exactly one directory.\n\n${USAGE}`)
    return 2
  }

  const targetDir = path.resolve(io.cwd, dir)
  const packageName = values.name ?? path.basename(targetDir)
  const problem = packageNameProblem(packageName)
  if (problem !== null) {
    const hint = values.name === undefined ? " Pass --name <name> to choose another." : ""
    io.stderr(`"${packageName}" is not a valid npm package name: it ${problem}.${hint}\n`)
    return 2
  }

  try {
    await scaffold({
      templatesDir: io.templatesDir,
      template: values.template,
      targetDir,
      packageName,
    })
  } catch (err) {
    if (err instanceof ScaffoldError) {
      io.stderr(`${err.message}\n`)
      return 1
    }
    throw err
  }

  const shown = path.relative(io.cwd, targetDir) || "."
  // --include=dev: bot runtimes set NODE_ENV=production, which makes npm skip
  // the test and build tools.
  const steps = ["npm ci --include=dev", "npm test"]
  if (shown !== ".") steps.unshift(`cd ${quoteForShell(shown)}`)
  io.stdout(
    [
      `Created ${packageName} in ${shown} from the ${values.template} template.`,
      "",
      "Next:",
      ...steps.map((step) => `  ${step}`),
      "",
      "Then run it:",
      "  npm run dev:mock   # on your machine, against fixture data",
      "  npm run dev        # inside a Botyard bot",
      "  npm run expose     # inside a bot, from a second shell: publish it as a Bot Page",
      "",
      "See README.md in the app for more.",
      "",
    ].join("\n")
  )
  return 0
}

async function readVersion(): Promise<string> {
  const json: unknown = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"))
  if (typeof json === "object" && json !== null && "version" in json) {
    return String(json.version)
  }
  return "unknown"
}

function quoteForShell(value: string): string {
  if (/^[\w./-]+$/.test(value)) return value
  const escaped = value.replaceAll("'", "'\\''")
  return `'${escaped}'`
}
