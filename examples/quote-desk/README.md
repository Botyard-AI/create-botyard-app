# Botyard app

A web app that runs inside your [Botyard](https://botyard.io) bot and is
served to your org as a Bot Page: a Node API and a React UI on one port,
behind Botyard sign-in.

```sh
npm ci           # installs exactly what package-lock.json pins
npm test
npm run dev        # inside a bot: API + UI with hot reload on 127.0.0.1:8787
npm run expose     # publish it as a Bot Page and print the URL
```

Node 22.18 or newer: the server is TypeScript that Node runs directly.

## Scripts

| Script | What it does |
| --- | --- |
| `npm run dev` | Starts the server with Vite as middleware: UI hot reload, API restarts on change. |
| `npm run dev:mock` | The same, outside a bot: Botyard tools come from `fixtures/dev.json`, and you are signed in as `ada@example.com`. |
| `npm run build` | Builds the UI into `dist/client`. |
| `npm start` | Serves the API and the built UI (`NODE_ENV=production`). The UI is read into memory at startup: restart after a rebuild. Linux only (as in a bot): it checks each file through `/proc`, and refuses to start without it. |
| `npm run expose` | Publishes the running app as a Bot Page through the `expose_botpage` tool. Add `-- --persistent` to keep it until revoked; otherwise it expires after two hours. |
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
- **`src/`** is the UI: React 19, Tailwind CSS v4 and
  [shadcn/ui](https://ui.shadcn.com). Add components with
  `npx shadcn@latest add <name>`.
  - The badge in the header (`src/components/viewer-badge.tsx`) shows the viewer from `/api/me`.
- **`test/`** runs the API against `@botyard/runtime`'s mock transport, with
  the same fixtures as `dev:mock`.

## The reviewer bot

Each quote in finance review has two steps: the reviewer bot's and a finance
approver's. The reviewer bot only **advises**. The app hands it a task on a
workforce board, reads its recommendation back and shows it on the quote. A
finance approver records the reviewer step, confirming the recommendation or
deciding otherwise. Nothing the bot writes decides a quote by itself.

**Setting it up (Settings, owners and admins).**

1. Pick the reviewer bot.
2. Pick a review board. The board needs the columns `review`, `approved` and
   `changes-requested`. With the `create_workforce` tool assigned to this
   bot, **Create review board** makes one. Without it, Settings says so, and
   you pick a board this bot is already on.
3. The reviewer bot must be a member of the board. No tool adds another bot to
   a board, so the reviewer joins it itself (`join_workforce`). Until it does,
   the quote page says who to ask, with the request to copy. No other bot
   may be on the board: any bot on it could answer for the reviewer.
4. Optional: a **handoff thread**, the id of a conversation of this bot's. When
   it is set, each handoff also nudges the reviewer bot there
   (`send_message_to_bot`). When it is not, nothing is sent.
5. Set `QUOTE_DESK_FILE_HOSTS` to the host names the platform's file download
   links use, comma-separated. The app reads `verdict.json` only from these.

**What happens to a quote.** Every 10 seconds the app checks the quotes
waiting for the reviewer bot:

- It checks the board, its columns and the reviewer's membership before every
  handoff, then creates a task in `review`, assigned to the reviewer bot. The
  task holds the brief: the lines, margin against the floor, terms, the
  customer's credit and the territory budget.
- It reads the task with `get_task`, at first after 15 seconds, then less
  often, up to every 5 minutes. Only quotes in finance review are checked.
- When the task is in `approved` or `changes-requested`, the app reads
  `verdict.json` from it and shows it on the quote as the reviewer bot's
  recommendation. The task is not read again after that.
- The task is created only once per submission. The app saves its intent
  first. If it stops between the create and saving the task (a crash, a full
  disk), it never creates the task again: the quote goes to people, and the
  page says to check the board for the task. State files are synced to disk
  on every write; where the filesystem can't sync a directory, a power cut at
  the wrong moment could still cost the intent, and a second task appear.

The quote page shows the task, its column, and how long it has waited.

**When no recommendation is coming.** If the board isn't set, isn't there,
lacks a column, the reviewer isn't on it or another bot is, the task
disappears, the reviewer in Settings changes mid-review, or the verdict can't
be read or isn't the reviewer's, the page says why and since when. A finance
approver records the reviewer step without a recommendation; they can do so
at any time anyway. Nothing else stops working.

**The reviewer bot's side.** The reviewer needs `list_my_tasks`, `get_task`,
`update_task`, `upload_task_files` and `join_workforce`. Being assigned a task
does not wake a bot, so give the reviewer a schedule, for example every 15
minutes:

> Check `list_my_tasks` for tasks tagged `quote-desk` in the Review column.
> For each, follow the "How to answer" steps in its description.

Its answer, attached to the task as `verdict.json` before it moves the task:

```json
{
  "quote_id": "Q-2026-0201",
  "decision": "approve",
  "note": "One or two sentences for the approval card.",
  "analysis": "Optional: a longer analysis for the quote history."
}
```

`decision` is `approve` with the Approved column and `reject` with Changes
requested. Any other field, a mismatched decision or quote, or an empty note
sends the quote to people instead.

**Reading `verdict.json`.** The download link is presigned: it is a credential.
The app never logs it, stores it or shows it. It reads the link only over
https, from a host in `QUOTE_DESK_FILE_HOSTS`, with no redirects. The file may
be at most 16 KiB and must arrive within 10 seconds. Errors say which host
failed, never the link.

**Whose verdict it is.** Only the reviewer the task was assigned to can
answer it. The app checks three things:

- The platform must attribute `verdict.json` to that reviewer bot.
- The bytes the app reads must match the SHA-256 the platform lists for the
  file.
- No other bot may be on the board.

The recommendation is shown under that reviewer's name, even if Settings has
changed since.

**Why it's only advice.** Two things are out of the app's reach:

- New boards are open to the whole org, and the app can't check or change
  that.
- When a file is overwritten, the platform keeps the first uploader's name.

So anyone who can write to the board's tasks could replace the reviewer's
`verdict.json` and still have it read as the reviewer's. That is why a person
confirms every recommendation. Keep the review board restricted to the
reviewer and this bot all the same.

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
