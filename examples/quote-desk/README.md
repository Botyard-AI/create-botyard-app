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
  page says to check the board for the task. The task is created only once its
  intent is synced to disk; if syncing fails, the app tries again on the next
  pass. The data directory is created and synced at startup, and the app
  refuses to start if that fails. This relies on the disk keeping what it
  reports as synced.
- Quote and settings saves are atomic (write, then rename), not
  power-cut-proof. Only the review-handoff intent waits for durability before
  acting.

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

## Notifications

The app tells people when a quote needs them, with `notify_human`. Each
notice starts its own conversation, so the person has somewhere to answer.

| Who | When |
| --- | --- |
| Finance approvers | A quote in finance review, once the reviewer bot has answered or no answer is coming |
| Business approvers | A quote in business review |
| The quote's owner | Changes were requested, or the quote is approved |

**Setting it up.**

- `QUOTE_DESK_NOTIFY_THREAD`: the id of a conversation of this bot's. New
  notice threads start from it, because `notify_human` needs an origin on
  OpenClaw. Without it, nobody is notified, and the app says so at startup.
- `QUOTE_DESK_PAGE_URL` (optional): the published Bot Page, https. Notices
  then link to the quote. The app can't find its own page URL, so you set it.
- The bot needs `notify_human`. Approvers come from Settings. The owner is
  found by email, which is fine here: a notice grants nothing.

**How it behaves.** Every 30 seconds the app works out which notices are
due and sends the ones it hasn't sent; they're kept in
`data/notifications.json`. A resubmitted quote gets new notices. A failed send
is tried again on the next pass, at most 3 times. A send whose outcome is
unknown isn't repeated, because a missed notice is better than a duplicate. A
save that fails is logged and retried every pass, without resending; only a restart before
the next good save, or a crash between a send and its save, can send a notice
twice. `QUOTE_DESK_PAGE_URL` goes into every notice, so it may not carry a
user, password, query or fragment.

## The mail inbox

Org members can email the bot. Email addresses aren't verified, though, and a
bot may act on whatever it reads. So the app never shows an email to the bot
itself. It asks the member the email claims to be from whether they sent it,
and only their reply, signed in, has the bot read it.

- Every minute the app walks the stored mail (`search_inbound_emails`)
  oldest first, from where it got to, and handles up to 10 emails it hasn't
  handled. Mail received before the inbox first started, or more than a day
  ago, is left alone.
- It skips auto-replies, mail that failed DMARC, and senders who aren't org
  members.
- For the rest it notifies that member (`notify_human`, in a new
  conversation), at most once an hour. More mail from them in that hour is
  covered by the same notice. The notice holds none of the email, only the
  member's own address and when the mail started. If they reply there, the
  bot reads their mail from then on and helps. If they didn't send it,
  nothing happens.
- What was handled is kept in `data/mail.json`. An email that can't be handled
  is tried 3 times, then skipped. A notice whose outcome is unknown isn't sent
  again.

**Limits.** This is a best-effort, low-volume poller for an example.
Production use needs a push or event source for inbound mail, which the
platform doesn't offer yet (platform feedback filed). Mail is announced only
if the platform stores it within 10 minutes of its place in the order. Mail
stored later than that stays in the bot's mailbox but is never announced, so
nobody is asked about it. Very high volume can lag.

**It needs** `QUOTE_DESK_NOTIFY_THREAD` (new conversations start from it, as
for notices), and the tools `search_inbound_emails`, `get_inbound_email` and
`notify_human`. `QUOTE_DESK_MAIL=off` turns it off.

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
