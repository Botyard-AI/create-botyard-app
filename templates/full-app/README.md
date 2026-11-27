# Botyard app

A web app that runs inside your [Botyard](https://botyard.io) bot and is
served to your org as a Bot Page: a Node API and a React UI on one port,
behind Botyard sign-in.

```sh
npm ci --include=dev   # exactly what package-lock.json pins, test and build tools included
npm test
```

Outside a bot, `npm run dev:mock` serves the app against fixture data. Inside
a bot, start it with hot reload on 127.0.0.1:8787:

```sh
npm run dev
```

Then, from a second shell in this directory while it runs, publish it as a
Bot Page and print its URL:

```sh
npm run expose
```

Node 22 (22.18 or later) or Node 24: the server is TypeScript that Node runs directly.

## Scripts

| Script | What it does |
| --- | --- |
| `npm run dev` | Starts the server with Vite as middleware: UI hot reload, API restarts on change. |
| `npm run dev:mock` | The same, outside a bot: Botyard tools come from `fixtures/dev.json`, and you are signed in as `ada@example.com`. |
| `npm run build` | Builds the UI into `dist/client`. |
| `npm start` | Serves the API and the built UI (`NODE_ENV=production`). The UI is read into memory at startup: restart after a rebuild. Linux only (as in a bot): it checks each file through `/proc`, and refuses to start without it. |
| `npm run expose` | Publishes the running app as a Bot Page through the `expose_botpage` tool. Add `-- --persistent` to keep it until revoked; otherwise it expires after two hours. |
| `npm run trace` | Prints recent requests and errors from `data/trace.jsonl`. See [When the app misbehaves](#when-the-app-misbehaves). |
| `npm test` | Tests against the mock runtime: no bot needed. |
| `npm run typecheck`, `npm run lint`, `npm run format` | TypeScript, ESLint and Prettier. |

To keep the app running after your session ends, run `npm start` as a bot
service and expose it with `--persistent`.

## How it fits together

- **`botyard.json`** names the Bot Page and the port. `PORT` overrides the port.
- **`server/`** is a plain `node:http` server.
  - `app.ts` holds the routes. Add yours to `api`.
  - `index.ts` starts the app with `listenLoopback`, which refuses anything but `127.0.0.1`.
- **Who is viewing.** The Bot Page proxy signs the viewer in and tells the app
  who they are. `@botyard/botpage` checks them against your org's members:
  - `GET /api/me` returns the viewer, or `null`.
  - `GET /api/hello` shows the members-only guard, `requireMember`.
- **Calling Botyard.** `@botyard/runtime` calls Botyard tools through the bot
  the app runs in: `call("list_org_members")`. Your code holds no credentials.
  - `GET /api/health` says the process answers; `GET /api/ready` says what it
    needs works (see below).
  - `log.ts`, `trace.ts` and `ready.ts` are the logging, the short-term
    trace and the readiness checks.
- **`src/`** is the UI: React 19, Tailwind CSS v4 and
  [shadcn/ui](https://ui.shadcn.com). Add components with
  `npx shadcn@latest add <name>`.
  - The badge in the header (`src/components/viewer-badge.tsx`) shows the viewer from `/api/me`.
- **`test/`** runs the API against `@botyard/runtime`'s mock transport, with
  the same fixtures as `dev:mock`.

## Blocks

Blocks are ready-made pieces of a Botyard app, such as a member picker: a
React component, the server code behind it and its tests. They come from
the Botyard registry at `https://blocks.botyard.io`, which `components.json`
already lists as `@botyard`. To see what is there, and to add one by its
name from that list (here `greeting`, a small sample):

```sh
npx shadcn@latest search @botyard
npx shadcn@latest add @botyard/greeting
```

shadcn writes the block's files into `src/`, `server/` and `test/`, and
installs any npm packages it needs. Then:

- Follow the note shadcn prints after adding a block. If the block has API
  routes, the note says how to add them to `api` in `server/app.ts`.
- Review what changed in `package-lock.json`, as for any new package.
- Run `npm test`: the block's tests are in `test/`.

## Security notes

- **Dependencies.** `package-lock.json` pins every package, including
  transitive ones, by version and integrity hash. When the app was created,
  every third-party version in it had been public for at least 3 days. Use
  `npm ci` to install exactly that. `.npmrc` sets `ignore-scripts=true`, so no
  dependency's install script runs. Review what changes in the lockfile when
  you add or upgrade a package.
- The app must listen on `127.0.0.1`. The viewer header is trusted only because
  the Bot Page proxy sets it and reaches the app over loopback.
- Use `requireMember` on every route that returns org data.
- `BOTYARD_DEV_VIEWER` (used by `dev:mock`) is refused when
  `NODE_ENV=production` and ignored unless the server listens on loopback.

## When the app misbehaves

Work through these in order. Each step narrows down where the problem is.

1. **Is it running?** `curl -s http://127.0.0.1:8787/api/health` answers
   `{"ok":true}` while the process is up. No answer: it is not running, or
   is on another port. Start it, or read its output for why it stopped.
2. **Is it ready?** `curl -s http://127.0.0.1:8787/api/ready` checks what the
   app needs: that Botyard answers through the bot (`runtime`) and, with
   `npm start`, that the built UI loaded (`ui`). A 503 names the failed
   check and how it failed (`timeout`, or the error's name). Add a check to
   `readyChecks` in `server/index.ts` for anything your app loads or
   connects to, such as a store.
3. **What happened?** `npm run trace` prints the recent requests and errors.
   - `npm run trace -- --errors` shows only warnings and errors, with stacks.
   - A 500 answers `{"error":"internal_error","requestId":"…"}`.
     `npm run trace -- --id <requestId>` shows that request and its error.
   - `npm run trace -- --json` prints raw lines, for `jq`.
4. **Did it start?** The first line the server prints is
   `"event":"startup"`, with the app, port, transport, `NODE_ENV` and
   version. If it stops at startup instead, the `startup_failed` line and
   the message after it say why: a bad `botyard.json` or `PORT`, no Botyard
   transport, the port in use, or no build.

What the logs hold:

- Every log line is one JSON object, on stdout (errors on stderr). A bot
  service keeps them; `data/trace.jsonl` keeps the recent ones too.
- A request line has the request id, method, path without the query string,
  status, duration and the kind of viewer (`person`, `bot` or `none`), never
  their email.
- The `x-forwarded-user`, `cookie` and `authorization` headers never reach a
  log line, and their values are blanked out wherever they appear.
- Anything that looks like an email address or a Bearer or Basic credential
  is blanked out too, in every line. A thrown value that is not an `Error` is
  logged as its type only.
- `data/trace.jsonl` is capped at 1 MiB. Before it would grow past that, it
  becomes `trace.1.jsonl`, replacing the previous one. Nothing serves it over
  HTTP: read it on the bot's disk. `TRACE_FILE` moves it: the name must end in
  `.jsonl`, and inside the app it must stay under `data/`.
- `data/` is also where stores belong. `npm start` serves only `dist/client`,
  and `vite.config.ts` keeps `data/` out of what `npm run dev` serves.

The server stops cleanly on SIGTERM or Ctrl-C: it stops taking connections,
lets requests in flight finish (up to 10 seconds), closes hot-reload
connections, then exits. An error that
nothing catches is logged, and the server exits with code 1, so a bot service
restarts it.

## Troubleshooting

**`vitest: not found`, `vite: not found` or `tsc: not found` after
installing.** `NODE_ENV=production` is set in your shell; Botyard bot
runtimes set it. With it, npm skips devDependencies, which hold the test,
build and lint tools. Install them anyway:

```sh
npm ci --include=dev
```

The scripts set `NODE_ENV` themselves (`dev` and `dev:mock` to
`development`, `start` to `production`), so you only need `--include=dev`
when installing.

**Every `/api` call fails after the page has been open for about an
hour.** The Bot Page proxy signs the viewer in for about an hour. After
that, loading the page signs them in again, but a `fetch()` from an open
page gets a 401 from the proxy. Call the API with `apiFetch` from
`src/lib/api-fetch.ts`, as `src/lib/api.ts` does: it recognises that 401
and does what `configureApiFetch` in `src/main.tsx` says.

- `"reload"` (the default) reloads the page, which signs the viewer in
  again. Anything typed on the page is lost.
- `"prompt"` shows a banner with a Reload button instead. Use it when the
  app has forms. The banner is `<SessionExpiredBanner />` in `src/App.tsx`.

If a reload does not sign the viewer back in, the app shows the banner
rather than reloading again within the same minute.
