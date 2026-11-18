// The workforce tools the reviewer handoff uses, each answer parsed: a board
// the reviewer bot gets its tasks on, the tasks themselves, and the files the
// reviewer attaches to them.
import type { ToolCaller } from "@botyard/runtime"
import {
  isRecord,
  items,
  list,
  num,
  record,
  str,
  strOrNull,
  type Rec,
} from "../../shared/narrow.ts"

/** The columns the handoff needs, by id. A board may have more. */
export const REVIEW_COLUMNS = [
  { id: "review", name: "Review" },
  { id: "approved", name: "Approved" },
  { id: "changes-requested", name: "Changes requested" },
] as const

export type ReviewColumn = (typeof REVIEW_COLUMNS)[number]["id"]

const column = (v: unknown, p: string) => {
  const c = record(v, p)
  return { id: str(c, "id", p, 80), name: str(c, "name", p) }
}

/** list_my_workforces: the boards this bot is a member of. */
export async function myBoards(tools: ToolCaller) {
  const at = "list_my_workforces"
  const r = record(await tools.call(at, {}), at)
  return items(r, "boards", at, 1000, (v, p) => {
    const b = record(v, p)
    return {
      slug: str(b, "slug", p, 63),
      name: str(b, "name", p),
      columns: items(b, "columns", p, 100, column),
    }
  })
}

export type Board = Awaited<ReturnType<typeof myBoards>>[number]

/** The review columns a board lacks. */
export function missingColumns(board: Board): string[] {
  const ids = new Set(board.columns.map((c) => c.id))
  return REVIEW_COLUMNS.filter((c) => !ids.has(c.id)).map((c) => `${c.name} (${c.id})`)
}

/** get_workforce_members: the board's bot members. */
export async function boardBots(tools: ToolCaller, slug: string) {
  const at = "get_workforce_members"
  const r = record(await tools.call(at, { slug }), at)
  return items(r, "members", at, 10_000, (v, p) => {
    const m = record(v, p)
    return { id: str(m, "bot_id", p, 80), name: str(m, "bot_name", p) }
  })
}

/** The review board's name. Board names are unique in an org. */
export const REVIEW_BOARD_NAME = "Quote desk reviews"

/** create_workforce: a board with just the review columns. Returns its slug. */
export async function createReviewBoard(tools: ToolCaller): Promise<string> {
  const at = "create_workforce"
  const r = record(
    await tools.call(at, {
      name: REVIEW_BOARD_NAME,
      description:
        "Finance reviews from the Quote desk. The reviewer bot moves each task to Approved " +
        "or Changes requested and attaches verdict.json.",
      columns: REVIEW_COLUMNS.map((c) => ({ id: c.id, name: c.name })),
    }),
    at
  )
  return str(r, "slug", at, 63)
}

/** A task as the handoff tracks it. */
const task = (r: Rec, at: string) => ({
  id: str(r, "id", at, 80),
  number: num(r, "number", at),
  column_id: str(r, "column_id", at, 80),
})

export type TaskRef = ReturnType<typeof task>

/** create_task: the review task, assigned to the reviewer bot. */
export async function createReviewTask(
  tools: ToolCaller,
  input: { board: string; title: string; description: string; reviewerBotId: string }
): Promise<TaskRef> {
  const at = "create_task"
  const r = await tools.call(at, {
    workforce_slug: input.board,
    title: input.title,
    column_id: "review",
    description: input.description,
    assignee_bot_ids: [input.reviewerBotId],
    tags: ["quote-desk", "finance-review"],
  })
  return task(record(r, at), at)
}

/** get_task: the task's current column. */
export async function readTask(tools: ToolCaller, board: string, number: number): Promise<TaskRef> {
  const at = "get_task"
  return task(record(await tools.call(at, { workforce_slug: board, task_number: number }), at), at)
}

/** One file attached to a task. `download_url` is a presigned link: a secret. */
const taskFile = (v: unknown, p: string) => {
  const f = record(v, p)
  return {
    id: str(f, "id", p, 80),
    filename: str(f, "filename", p, 500),
    content_length: num(f, "content_length", p),
    /** SHA-256 of the content, hex, as the platform recorded it. */
    content_hash: str(f, "content_hash", p, 128),
    /**
     * The bot that first uploaded the file, set by the platform from the
     * caller's identity. Null for a person's or an API key's upload.
     */
    uploaded_by_bot_id: strOrNull(f, "uploaded_by_bot_id", p, 80),
    download_url: str(f, "download_url", p, 8000),
  }
}

export type TaskFile = ReturnType<typeof taskFile>

/** list_task_files, filtered to one filename. The tool answers a list, or `{ result: list }`. */
export async function taskFilesNamed(
  tools: ToolCaller,
  board: string,
  taskId: string,
  filename: string
): Promise<TaskFile[]> {
  const at = "list_task_files"
  const answer = await tools.call(at, {
    workforce_slug: board,
    task_id: taskId,
    path_prefix: filename,
  })
  const files = isRecord(answer)
    ? list(answer["result"], `${at}.result`, 1000)
    : list(answer, at, 1000)
  return files
    .map((v, i) => taskFile(v, `${at}[${String(i)}]`))
    .filter((f) => f.filename === filename)
}
