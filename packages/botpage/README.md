<p align="center">
  <a href="https://botyard.io"><img src="https://raw.githubusercontent.com/Botyard-AI/create-botyard-app/f52b7e38493a4218d32789d0d08060c47edee504/assets/brand/botyard-app-icon-navy.svg" alt="Botyard" width="96"></a>
</p>

# @botyard/botpage

Viewer identity, membership guards and deep links for web apps served as
[Botyard](https://botyard.io) Bot Pages.

<p align="center">
  <a href="https://www.npmjs.com/package/@botyard/botpage"><img src="https://img.shields.io/npm/v/%40botyard%2Fbotpage?color=d4622b" alt="npm version"></a>
  <a href="https://docs.npmjs.com/generating-provenance-statements"><img src="https://img.shields.io/badge/npm-provenance-4a5c6a" alt="Published with npm provenance"></a>
  <a href="https://github.com/Botyard-AI/create-botyard-app/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/%40botyard%2Fbotpage?color=4a5c6a" alt="License: Apache-2.0"></a>
</p>

A Bot Page is a web server inside your bot that Botyard publishes at
`https://<slug>.botyard.tech` behind sign-in. This package answers "who is
looking at my page, and are they in my org?" and builds links back into the
Botyard app.

```sh
npm install @botyard/botpage
```

Node 22 or newer. ESM only.

## Quick start (Node `http`)

```ts
import { createServer } from "node:http";
import { createBotPage } from "@botyard/botpage";
import { listenLoopback, requireMember } from "@botyard/botpage/node";

const botpage = createBotPage({ tools }); // tools: see "Calling platform tools"

const server = createServer(
  requireMember(botpage, (req, res, viewer) => {
    res.end(`Hello, ${viewer.name ?? viewer.email}`);
  }),
);

await listenLoopback(server, 3000, { botpage }); // refuses anything but 127.0.0.1
```

Then publish port 3000 as a Bot Page from your bot (`expose_botpage`).

## How viewer identity works

The Bot Page proxy signs the viewer in, then forwards the request to your app
with **one** identity header: `x-forwarded-user`, set to the viewer's email
(or their id when they have no email). It strips everything else that could
carry a credential: `Authorization`, cookies set by Botyard, `Referer` and a
`?token=` query parameter. Headers such as `x-user-email` or
`x-botyard-user-name` are never set by Botyard; this package ignores them.

`viewer(req)` reads `x-forwarded-user` and looks the subject up in your org
through the `list_org_members` platform tool, matching email
(case-insensitively) or user id:

```ts
const viewer = await botpage.viewer(req);
// null                                  no viewer identified
// { kind: "member", userId, email, name, role, avatarUrl, ... }
// { kind: "unknown", subject, email, ... }   identified, not in the member list
// { kind: "bot", botId, ... }                 your bot, viewing its own page
```

- **`avatarUrl` is always `null` for now.** `list_org_members` does not return
  avatars yet; the field is there so your UI can use one when it does.
- A bot viewing its own page arrives with a shadow address,
  `bot+<bot-id>@bots.botyard.internal`, which is not a mailbox. It resolves to
  `{ kind: "bot", viewerType: "bot", botId, subject: botId }`, with no email
  and no directory lookup. `requireMember` refuses it.
- The member list is cached per process (default 60 s, `members.ttlMs`) with
  one in-flight refresh at a time. An unknown subject never forces a refetch.
  When a refresh fails, the platform is not called again for 5 s
  (`members.retryAfterMs`), with or without a cached list.
- During an outage the previous list keeps authorizing for at most
  `members.maxStaleMs` (default 5 minutes) past its TTL, so a removed or
  demoted member loses access within `ttlMs + maxStaleMs` of the last
  successful fetch. Past that, or with no list at all, calls throw
  `BotPageToolError` and the adapters answer 503.

### Listen on 127.0.0.1

`x-forwarded-user` is **not signed**. It can be trusted only because the
proxy overwrites it and the proxy reaches your app over loopback. If your app
listens on `0.0.0.0`, anything that can reach that port can claim to be any
viewer. So:

- Bind to `127.0.0.1`. `listenLoopback()` refuses other hosts; `guardListen()`
  warns when a server you started yourself is bound wider.
- With a Node socket available, `trustedForwardedUser` ignores the header
  (`untrusted_peer`) when the TCP peer is not loopback.

### Pluggable identity source

The header strategy is `trustedForwardedUser()`, the default. Identity is a
strategy you can replace:

```ts
import { createBotPage, type IdentitySource } from "@botyard/botpage";

const source: IdentitySource = {
  name: "my-source",
  identify(req) {
    // return { ok: true, viewerType: "user" | "unknown", subject, email, audience, source }
    //     or { ok: true, viewerType: "bot", subject: botId, botId, email: null, audience, source }
    // or     { ok: false, reason: "missing" | "malformed" | ..., source }
  },
};
createBotPage({ tools, identity: source });
```

Botyard plans signed, page-scoped viewer assertions. When they ship, a
verifying source will be added in a minor release and switching to it will be
a one-line change. Sources fail closed: a bad credential is a failure with a
`reason`, never a fallback to a weaker source.

### Guards

`requireMember(req, { roles? })` resolves the member, or throws
`BotPageAuthError`:

| Status | `code` | When |
| --- | --- | --- |
| 401 | `unauthenticated` | No viewer identified (`reason` says why). |
| 403 | `not_a_member` | The viewer is not in the org's member list. |
| 403 | `role_not_allowed` | The member's role is not in `roles`. |

The adapters turn these into JSON responses, plus 503
`directory_unavailable` when the member list cannot be fetched.

### Dev viewer override

For local development without the proxy, act as a fixed viewer when a request
carries no identity:

```sh
BOTYARD_DEV_VIEWER=you@example.com node server.js
```

(or `createBotPage({ devViewer: "you@example.com" })`). It is:

- **refused at startup** when `NODE_ENV=production`;
- **ignored**, with a warning, unless the server is known to listen on
  loopback: the request's socket is bound to loopback, or `bind` /
  `guardListen` / `listenLoopback` recorded a loopback address;
- never used when the request carries a credential, even a malformed one.

## Deep links into Botyard

```ts
const url = await botpage.deeplinks.resolve("bots-botSlug", { botSlug: "my-bot" });
// https://app.botyard.io/orgs/<your-org>/bots/my-bot
```

Keys and their required params come from the platform's navigation directory
(the `list_navigation_destinations` tool). URLs are never hand-written. The
org comes from `get_identity`. Params must match the destination's
`required_params` exactly.

The directory returns each destination's route template (`path`, `search`),
and `resolve()` fills it in. When it cannot build a safe link, for example
because the directory has no template for that key or the template has an
unexpected shape, it throws `DeeplinkUnavailableError` rather than guess a
URL. Catch it and leave the link out.

Errors: `UnknownDestinationError`, `DeeplinkParamsError`,
`DeeplinkUnavailableError` (all extend `DeeplinkError`), and
`BotPageToolError` when a tool call fails. Set `deeplinks.appUrl` to point at
another Botyard environment (https only).

## Adapters

### Hono (`hono` is an optional peer dependency)

```ts
import { Hono } from "hono";
import { viewerMiddleware, type BotPageEnv } from "@botyard/botpage/hono";

const app = new Hono<BotPageEnv>();
app.use("/api/*", viewerMiddleware(botpage, { require: "member" }));
app.get("/api/me", (c) => c.json(c.get("viewer")));
```

On `@hono/node-server` the Node socket is used for the loopback checks.

### Next.js App Router

Uses only Web `Request`/`Response`, so it imports nothing from `next`.

```ts
// app/api/me/route.ts
import { withMember } from "@botyard/botpage/next";
export const GET = withMember(botpage, (req, ctx, viewer) => Response.json(viewer));

// middleware.ts
import { NextResponse } from "next/server";
import { memberGuard } from "@botyard/botpage/next";
const guard = memberGuard(botpage);
export async function middleware(req: Request) {
  return (await guard(req)) ?? NextResponse.next();
}
export const config = { runtime: "nodejs" };
```

Start Next with `-H 127.0.0.1`. Next requests carry no socket, so pass
`bind: "127.0.0.1"` to `createBotPage` if you use the dev viewer override.

### Node `http`

`withViewer`, `requireMember`, `guardListen` and `listenLoopback` from
`@botyard/botpage/node`.

## Calling platform tools

`createBotPage({ tools })` takes any object with this shape:

```ts
interface ToolCaller {
  call<T = unknown>(tool: string, args?: Record<string, unknown>,
    opts?: { timeoutMs?: number; signal?: AbortSignal }): Promise<T>;
}
```

Tool names are canonical and unprefixed (`list_org_members`,
`list_navigation_destinations`, `get_identity`). Inside a bot, pass the
`@botyard/runtime` client, which satisfies it:

```ts
import { defaultRuntime } from "@botyard/runtime";
import { createBotPage } from "@botyard/botpage";

const botpage = createBotPage({ tools: defaultRuntime() });
```

## Links

- [Source](https://github.com/Botyard-AI/create-botyard-app/tree/main/packages/botpage) and [changelog](https://github.com/Botyard-AI/create-botyard-app/blob/main/CHANGELOG.md)
- [Report an issue](https://github.com/Botyard-AI/create-botyard-app/issues). Security reports go privately, see [SECURITY.md](https://github.com/Botyard-AI/create-botyard-app/blob/main/SECURITY.md).
- [Bot Pages](https://botyard.io/features/bot-pages) and [Hosting apps](https://docs.botyard.io/docs/hosting-apps) in the Botyard docs
- [botyard.io](https://botyard.io)

## License

Apache-2.0
