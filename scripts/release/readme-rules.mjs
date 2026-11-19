// The rules a package README must meet to render correctly on npm, which
// shows it away from this repository. Pure: text in, problems out. Used by
// check-readmes.mjs; cases in readme-rules.test.mjs.
//
// The README is rendered with marked (GFM), and the rules run on the rendered
// HTML, so they see what a reader sees: code blocks, indented ones included,
// come out as escaped text and never count as an image or a link.
// - every <img src> and <a href> must be an absolute https URL with a host;
//   images from this repository must be pinned to a commit;
// - <picture>, <source>, srcset and an <img> without a src are rejected:
//   npm strips the first three, and the last cannot be checked;
// - the pinned app-icon header must render before the first heading,
//   whatever badges follow it.

import { marked } from "marked"

const REPO_RAW_HOST = "raw.githubusercontent.com"
const REPO_RAW_PATH = "/Botyard-AI/create-botyard-app/"
const PINNED_PATH = /^\/Botyard-AI\/create-botyard-app\/[0-9a-f]{40}\//

/** The header image every package README starts with, before its first heading. */
export const HEADER_ICON = "/assets/brand/botyard-app-icon-navy.svg"

const ATTRIBUTE = /([A-Za-z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g
const ENTITIES = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">" }

function decode(value) {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|quot|apos|lt|gt);/gi, (_, e) => {
    const lower = e.toLowerCase()
    if (lower.startsWith("#x")) return String.fromCodePoint(parseInt(lower.slice(2), 16))
    if (lower.startsWith("#")) return String.fromCodePoint(parseInt(lower.slice(1), 10))
    return ENTITIES[lower]
  })
}

function attributes(tag) {
  const found = new Map()
  for (const m of tag.matchAll(ATTRIBUTE))
    found.set(m[1].toLowerCase(), decode(m[2] ?? m[3] ?? m[4]))
  return found
}

/** @returns {URL | null} the URL when it is absolute https with a host. */
function httpsUrl(value) {
  try {
    const url = new URL(value)
    return url.protocol === "https:" && url.hostname !== "" ? url : null
  } catch {
    return null
  }
}

function isPinnedRepoImage(url) {
  return url.hostname === REPO_RAW_HOST && PINNED_PATH.test(url.pathname)
}

function destinationProblem(value, what) {
  if (what === "link" && value.startsWith("#")) return null
  const url = httpsUrl(value)
  if (!url) return `${what} is not an absolute https URL with a host: ${value}`
  if (
    url.hostname === REPO_RAW_HOST &&
    url.pathname.startsWith(REPO_RAW_PATH) &&
    !isPinnedRepoImage(url)
  )
    return `${what} from this repository is not pinned to a commit SHA: ${value}`
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
  const html = marked.parse(text, { gfm: true, async: false }).replace(/<!--[\s\S]*?-->/g, "")

  if (/<(picture|source)\b/i.test(html)) add("uses <picture>/<source>, which npm strips")

  for (const m of html.matchAll(/<(img|a)\b([^>]*)>/gi)) {
    const attrs = attributes(m[2])
    if (m[1].toLowerCase() === "img") {
      const src = attrs.get("src")
      if (src === undefined) add(`<img> without a readable src: ${m[0]}`)
      else add(destinationProblem(src, "image"))
      if (attrs.has("srcset")) add(`<img srcset> is not supported here: ${m[0]}`)
    } else if (attrs.has("href")) {
      add(destinationProblem(attrs.get("href"), "link"))
    }
  }

  // The canonical header, checked on its own so badges cannot stand in for it.
  const heading = html.search(/<h[1-6]\b/i)
  if (heading === -1) {
    add("has no heading")
  } else {
    const hasIcon = [...html.slice(0, heading).matchAll(/<img\b([^>]*)>/gi)].some((m) => {
      const url = httpsUrl(attributes(m[1]).get("src") ?? "")
      return (
        url !== null &&
        isPinnedRepoImage(url) &&
        url.pathname.replace(PINNED_PATH, "/") === HEADER_ICON
      )
    })
    if (!hasIcon) add(`has no pinned ${HEADER_ICON} header image before its first heading`)
  }

  return problems
}
