<p align="center">
  <a href="https://botyard.io"><img src="https://raw.githubusercontent.com/Botyard-AI/create-botyard-app/f52b7e38493a4218d32789d0d08060c47edee504/assets/brand/botyard-app-icon-navy.svg" alt="Botyard" width="96"></a>
</p>

# @botyard/runtime

Call [Botyard](https://botyard.io) platform tools from an app running inside a
Botyard bot. One `call()`, typed errors, and no credentials in your code.

<p align="center">
  <a href="https://www.npmjs.com/package/@botyard/runtime"><img src="https://img.shields.io/npm/v/%40botyard%2Fruntime?color=d4622b" alt="npm version"></a>
  <a href="https://docs.npmjs.com/generating-provenance-statements"><img src="https://img.shields.io/badge/npm-provenance-4a5c6a" alt="Published with npm provenance"></a>
  <a href="https://github.com/Botyard-AI/create-botyard-app/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/%40botyard%2Fruntime?color=4a5c6a" alt="License: Apache-2.0"></a>
</p>

```sh
npm install @botyard/runtime
```

```ts
import { call, getIdentity } from "@botyard/runtime";

const me = await getIdentity();
// { bot: { id, slug, name }, org: { id, slug }, transport: "botyardd" | "mcp" | "mock" }

const { members } = await call<{ members: { name: string }[] }>("list_org_members");
```

Requires Node.js 22 or newer. ESM only. No runtime dependencies.

## Calling tools

```ts
call<T = unknown>(tool: string, args?: Record<string, unknown>, opts?: CallOptions): Promise<T>

interface CallOptions {
  timeoutMs?: number;   // whole-call deadline, default 60 000
  signal?: AbortSignal; // cancel the call
}
```

- **`tool` is the canonical, unprefixed name**, for example `list_org_members`.
  The runtime looks it up in the bot's live tool list: the exact name, or else
  the one tool named `<prefix>__list_org_members`. Nothing hardcodes an org or
  server prefix. If two prefixed tools match, it throws rather than guess.
- **The result** is the tool's `structuredContent` when it has one, else its
  text parsed as JSON, else the text itself.
- **Nothing is retried.** A call is sent at most once.

`ToolCaller` is the one-method interface (`{ call }`) to accept in your own
code, so tests can pass a mock in its place.

## Errors

Every error extends `BotyardError`, which carries `tool` and `transport`.

| Error | Meaning | Retry? |
| --- | --- | --- |
| `InvalidInputError` | Refused before the tool ran: bad arguments, schema mismatch. | No. Fix the input. |
| `UnknownToolError` (an `InvalidInputError`) | No such tool is assigned to this bot. | No. |
| `ToolError` | The tool ran and reported an error. `message` is its text; `content` holds the raw blocks. | Depends on the tool. |
| `OutcomeUnknownError` | The request may have reached the tool, but no answer came back (timeout, abort, dropped connection). | **Never automatically.** The tool may have run. Check the effect first. |
| `TransportError` | Botyard was not reachable, or refused the request before any tool ran. | Yes, it is safe to. |

```ts
import { call, OutcomeUnknownError, ToolError } from "@botyard/runtime";

try {
  await call("create_task", { workforce_slug: "ops", title: "Restock" });
} catch (err) {
  if (err instanceof OutcomeUnknownError) {
    // Don't call again blindly: look for the task first.
  } else if (err instanceof ToolError) {
    console.error("Botyard said no:", err.message);
  } else {
    throw err;
  }
}
```

## Transports

The runtime picks one when it is created:

1. **An explicit choice**: `createRuntime({ transport })`, or the
   `BOTYARD_RUNTIME_TRANSPORT` env (`botyardd`, `mcp` or `mock`).
2. **`botyardd`**, when the native runtime daemon's socket exists
   (`$BOTYARD_SOCKET`, else `$BOTYARD_HOME/daemon.sock`, else
   `~/.botyard/daemon.sock`). Calls run
   `botyardd tools call --input - <name>` with the arguments on stdin.
3. **`mcp`**, when `MCP_PROXY_PORT` is set (OpenClaw bots): MCP over HTTP to
   the bot bridge's loopback proxy at `http://127.0.0.1:$MCP_PROXY_PORT/mcp`.
   `BOTYARD_RUNTIME_MCP_URL` overrides the URL, but only with a loopback URL
   (`127.0.0.0/8`, `::1` or `localhost`). To use another host, pass `mcpUrl`
   to `createRuntime()` in application code.

If none of them applies, it throws a `TransportError` that lists every signal
it checked. **The mock is never chosen automatically.**

| botyardd exit | Error |
| --- | --- |
| 0 | none |
| 2 | `InvalidInputError` |
| 3 | `ToolError` |
| 4 | `OutcomeUnknownError` |
| 1 | `TransportError` (`UnknownToolError` for an unassigned tool) |
| other, or killed | `OutcomeUnknownError` |

## Testing with the mock

```ts
import { createRuntime, ToolError } from "@botyard/runtime";

const runtime = createRuntime({
  transport: "mock",
  mock: {
    identity: { id: "bot-1", slug: "quote-desk", org_slug: "acme" },
    tools: {
      list_org_members: { result: { members: [{ name: "Ada" }] } },
      create_task: (args) => ({ id: 7, title: args["title"] }),
      delete_task: { error: { kind: "tool", message: "not allowed" } },
    },
  },
});

await runtime.call("list_org_members"); // { members: [{ name: "Ada" }] }
```

A mock transport records its calls. Create one with `createMockTransport()`,
pass it as `transport`, then assert on `.calls`. Error kinds are `tool`,
`invalid_input`, `outcome_unknown` and `transport`.

For local development without code changes, put fixtures in a JSON file and
set `BOTYARD_RUNTIME_TRANSPORT=mock` and
`BOTYARD_RUNTIME_MOCK_FIXTURES=./fixtures.json`:

```json
{
  "identity": { "id": "bot-1", "slug": "quote-desk", "org_id": "org-1", "org_slug": "acme" },
  "tools": {
    "list_org_members": { "result": { "members": [{ "name": "Ada" }] } }
  }
}
```

## More API

- `createRuntime(options?)` returns a `Runtime`: `call`, `getIdentity`,
  `listTools`, `resolveToolName`, `transportKind` and `transportReason`.
- `defaultRuntime()` returns the process-wide `Runtime`, created from
  `process.env` on first use. The top-level `call` and `getIdentity` use it.
  Pass it where a `ToolCaller` is expected, for example
  `createBotPage({ tools: defaultRuntime() })` in `@botyard/botpage`.
- `getIdentity()` reads the `get_identity` tool. If that tool is not assigned,
  it falls back to the pod's `BOTYARD_BOT_ID`, `BOTYARD_ORG_ID` and
  `BOTYARD_ORG_SLUG`.

## Security

- **This package never handles a credential.** On a native bot the
  `botyardd` daemon holds the bot's identity; on an OpenClaw bot the bridge
  authenticates each request it proxies. Your app sends no token and reads
  none.
- **It never touches the identity broker or `/run/botyard-identity`.** On
  OpenClaw bots the provisioner deliberately keeps the broker's token out of
  the runtime user's reach, so that only the bridge can obtain the bot's
  identity. The SDK does not route around that boundary, even where the token
  happens to be readable (for example as root on a privileged bot).
- **Arguments go to `botyardd` on stdin, never in argv**, where other users
  could read them through `ps`. Error messages never include arguments.
- **Tool traffic stays on the machine unless your code says otherwise.** An MCP
  URL taken from the environment must be loopback, so a poisoned environment
  cannot send tool arguments and results to another host. Only an explicit
  `mcpUrl` passed by application code may point elsewhere.
- **Responses are bounded.** Success bodies are capped at 32 MiB and error
  bodies at 4 KiB; the rest is cancelled, and the call's deadline covers every
  read.
- The MCP transport refuses URLs with embedded credentials and does not follow
  redirects.

## Links

- [Source](https://github.com/Botyard-AI/create-botyard-app/tree/main/packages/runtime) and [changelog](https://github.com/Botyard-AI/create-botyard-app/blob/main/CHANGELOG.md)
- [Report an issue](https://github.com/Botyard-AI/create-botyard-app/issues). Security reports go privately, see [SECURITY.md](https://github.com/Botyard-AI/create-botyard-app/blob/main/SECURITY.md).
- [Bot Pages](https://botyard.io/features/bot-pages) and [Hosting apps](https://docs.botyard.io/docs/hosting-apps) in the Botyard docs
- [botyard.io](https://botyard.io)

## License

Apache-2.0
