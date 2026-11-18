# Quote desk demo script (about 20 minutes)

Fictional data only: Dunder Mifflin paper, Schrute Farms B&B.

**Cast**

- **The host bot** runs the app (`npm start` as a bot service) and publishes it
  as a Bot Page.
- **The reviewer bot** is a second bot that advises finance on each quote.
- **The rep** is whoever drives the app, and owns the quote.
- **Finance** and **Business** are the people picked in Settings. One person
  may hold both roles, and may also be the rep.

**What it shows**

- A person working in the Bot Page, with Botyard sign-in.
- The app calling Botyard tools through its bot.
- A handoff to another bot over a workforce board.
- Notices that open a conversation with the right person.
- Mail to the bot, picked up only after the sender confirms, signed in.
- A PDF of the quote, downloaded by a person and sent by the bot.

## Before the call (the host bot)

1. Build the app (`npm ci && npm run build`).
2. Start it as a service with `NODE_ENV=production` and
   `QUOTE_DESK_NOTIFY_THREAD`, the id of a conversation of the host bot's.
   Add `QUOTE_DESK_FILE_HOSTS`, the storage hosts of the platform's file
   links. Publish it with `npm run expose`, then set `QUOTE_DESK_PAGE_URL` to
   the printed URL and restart, so that notices link to the quote.
3. In **Settings**:
   - pick the Finance and Business approvers;
   - pick the reviewer bot;
   - click **Create review board**, or pick a board the host bot is on.
4. Ask the reviewer bot to join the board. The handoff panel has the request to
   copy. Give the reviewer bot a schedule over `list_my_tasks`, as described in
   the README under "The reviewer bot's side".
5. Click **Reset demo** if earlier quotes are in the way.

---

## 1. The rep builds the quote

On **Build quote**:

| Field | Value |
|---|---|
| Customer | Schrute Farms B&B |
| Territory, region | Scranton, Northeast |
| Delivery | Standard (€45) |
| Payment terms | **Net 60** |
| Line | Copy paper A4, 80 gsm, qty **100** (tier price €20.40) |
| Order discount | **8%**, reason "competitor match" |

The owner is you, from your Botyard sign-in.

**Point out:** live pricing updates as you type.

- Subtotal is €2,040, the discount is −€163.20 and the total is €1,921.80.
- Margin is **24.3%**, which is under the 25% floor.
- There are two flags: margin below the floor, and a discount of 14.3% that is
  over the 10% escalation level.

Click **Submit for approval**.

## 2. The quote goes to the reviewer bot

In **Quotes & approvals**, open the quote. The handoff panel shows a task on
the review board, assigned to the reviewer bot, and how long it has waited.
The task holds the brief: lines, margin against the floor, terms, credit and
the territory budget.

The reviewer bot answers on its next scheduled check. It attaches
`verdict.json` to the task and moves the task to **Changes requested**, for
example:

- "Margin 24.3% is under the 25% floor. Max 3% order discount."
- "Net 60 is not justified at this margin. Counter: Net 45."

The app reads the verdict and shows it on the quote as a **recommendation**.
Finance gets a notice: a new conversation asking them to record the reviewer
step.

## 3. Finance records the reviewer step

Finance opens the link from the notice. On the **Reviewer bot** card, they
read the recommendation and click **Request changes**, with a note.

The quote goes back to **Draft**, and the rep gets a notice that changes were
requested.

> "The bot did the analysis. A person decided what it means."

## 4. The rep revises and resubmits

Open the quote and click **Edit draft**, then change:

- order discount to **3%**, reason "multi-year paper contract";
- payment terms to **Net 45**.

Live pricing now shows a total of €2,023.80 and a margin of **28.2%**, with no
flags. Click **Submit for approval**. The reviewer bot gets a new task and
recommends approval.

## 5. Finance signs off

Finance gets a new notice. On the **Reviewer bot** card, they click
**Confirm reviewer bot's approval**. On the **Finance** card, they click
**Approve**. The quote moves to **Business review**, and Business gets a
notice.

## 6. Business signs off

Business clicks **Approve** on the **Business** card. The status becomes
**Approved**, and the rep gets a notice to send the quote to the customer.

## 7. The PDF (about 2 minutes)

**In the browser.** Click **PDF** on the quote. The file holds what the
customer may see: lines, prices, delivery, terms and totals. It shows no cost,
margin or approval notes. Before approval it is marked as a draft.

**From the bot.** In the conversation the approval notice opened, the rep asks
the host bot: "send me the PDF of <quote id>". The bot runs
`npm run pdf -- <quote id>` in the app's directory and sends the printed file
with `send_files`.

**Expected:** the same PDF arrives in that conversation, without the draft
mark. The app never sends it on its own: the bot sends it when asked. The HTTP
route stays members-only.

## 8. Mail to the bot (about 3 minutes)

A member, for example the rep, emails the host bot's Botyard address from the
address their Botyard account uses. Any subject and text will do: "Please
quote 50 boxes of A4 for Schrute Farms."

**Expected, within about two minutes:**

- The member gets a notice in a new conversation. It asks whether they sent
  mail to the bot, and holds only their own address and the time. It contains
  nothing from the email.
- They reply there, signed in: "yes, that was me". Only then does the bot read
  their mail from that time on, and help.
- Mail from an address that isn't an org member's gets no notice. Neither do
  auto-replies.

## 9. Closing (about 1 minute)

- Click **Record send (demo)**. The email is recorded, never delivered: the
  address is on a `.invalid` domain. Then click **Mark signed (mock)**.
- On **Quarter close**, Scranton's committed value goes up and its headroom
  goes down.

> "From draft to signed in one place, with finance in the loop."

---

## Fallbacks

- **The reviewer bot is slow.** Finance can record the reviewer step at any
  time without a recommendation: **Approve** or **Request changes** on the
  Reviewer bot card.
- **The handoff panel says a step is missing**, for example the reviewer isn't
  on the board. It says what to fix. Until it is fixed, the quote goes to
  people.
- **No mail notice arrives.** The inbox checks every minute and needs the
  tools `search_inbound_emails`, `get_inbound_email` and `notify_human`. Check
  the service log, and that `QUOTE_DESK_MAIL` isn't `off`.
- **No notices arrive.** Check that `QUOTE_DESK_NOTIFY_THREAD` is set and that
  the approvers are picked in Settings. The service log says "nobody to tell"
  when no one is.
- **Anything else.** Click **Reset demo** and start again.

## What changed from the original demo

The original demo took shortcuts. This rebuild removes them:

- **Who clicks is checked.** Botyard sign-in identifies the viewer, and only
  the people picked in Settings can approve.
- **The reviewer bot is reached through a workforce board.** No second bot
  relays for it. Its verdict is advice that a person confirms.
- **No tool prefixes, bot paths or member snapshots are hard-coded.** The SDK
  finds the bot's tools and the org's members.
- **The customer email is still recorded, not sent.** This is a demo.
