// The rules a package README must meet to render correctly on npm, which
// shows it away from this repository. Pure: text in, problems out. Used by
// check-readmes.mjs; cases in readme-rules.test.mjs.
//
// The grammar is deliberately narrow. Every destination form npm renders is
// either checked or rejected, so an unchecked form can never pass silently:
// - Markdown inline destinations `](dest)`, for links and images alike;
// - reference definitions `[label]: dest`;
// - HTML <img>, <a> and <source> attributes, in any quoting style;
// - <picture>/<source> are rejected outright: npm strips them.

const REPO_RAW = "https://raw.githubusercontent.com/Botyard-AI/create-botyard-app/"
const PINNED_RAW =
  /^https:\/\/raw\.githubusercontent\.com\/Botyard-AI\/create-botyard-app\/[0-9a-f]{40}\//

/** The header image every package README starts with, before its H1. */
export const HEADER_ICON = "/assets/brand/botyard-app-icon-navy.svg"

const ATTRIBUTE = /([A-Za-z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g

function attributes(tag) {
  const found = new Map()
  for (const m of tag.matchAll(ATTRIBUTE)) found.set(m[1].toLowerCase(), m[2] ?? m[3] ?? m[4])
  return found
}

function destinationProblem(url, what) {
  if (url.startsWith("#") && what === "link") return null
  if (!url.startsWith("https://")) return `${what} is not an absolute https URL: ${url}`
  if (url.startsWith(REPO_RAW) && !PINNED_RAW.test(url))
    return `${what} from this repository is not pinned to a commit SHA: ${url}`
  return null
}

/**
 * Problems with one README's text; an empty list means it passes.
 * @param {string} text
 * @returns {string[]}
 */
export function readmeProblems(text) {
  const problems = []
  const add = (problem) => problem && problems.push(problem)

  // Code blocks, code spans and HTML comments are not rendered as links.
  const prose = text
    .replace(/^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?^ {0,3}\1[^\n]*$/gm, "")
    .replace(/`[^`\n]*`/g, "")
    .replace(/<!--[\s\S]*?-->/g, "")

  if (/<(picture|source)\b/i.test(prose)) add("uses <picture>/<source>, which npm strips")

  // Every inline destination, whether it belongs to a link or an image: the
  // closing `](` is unambiguous even when a badge image sits inside a link.
  for (const m of prose.matchAll(/\]\(\s*(?:<([^>\n]*)>|([^\s)]+))/g)) {
    const url = m[1] ?? m[2]
    const isImage = /!\[[^\]]*$/.test(prose.slice(Math.max(0, m.index - 200), m.index))
    add(destinationProblem(url, isImage ? "image" : "link"))
  }
  // Reference definitions serve reference-style links and images alike.
  for (const m of prose.matchAll(/^ {0,3}\[[^\]\n]+\]:\s*(?:<([^>\n]*)>|(\S+))/gm))
    add(destinationProblem(m[1] ?? m[2], "reference"))

  for (const m of prose.matchAll(/<(img|a)\b([^>]*)>/gi)) {
    const tag = m[1].toLowerCase()
    const attrs = attributes(m[2])
    if (tag === "img") {
      const src = attrs.get("src")
      if (src === undefined) add(`<img> without a readable src: ${m[0]}`)
      else add(destinationProblem(src, "image"))
      if (attrs.has("srcset")) add(`<img srcset> is not supported here: ${m[0]}`)
    } else if (attrs.has("href")) {
      add(destinationProblem(attrs.get("href"), "link"))
    }
  }

  // The canonical header, checked on its own so badges cannot stand in for it.
  const h1 = prose.search(/^# /m)
  const header = h1 === -1 ? "" : prose.slice(0, h1)
  const hasIcon = [...header.matchAll(/<img\b([^>]*)>/gi)].some((m) => {
    const src = attributes(m[1]).get("src") ?? ""
    return PINNED_RAW.test(src) && src.endsWith(HEADER_ICON)
  })
  if (h1 === -1) add("has no `# ` heading")
  else if (!hasIcon) add(`has no pinned ${HEADER_ICON} header image before its heading`)

  return problems
}
