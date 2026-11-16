import { BotPageError, BotPageToolError } from "./errors.ts";
import type { ToolCaller } from "./tools.ts";

export const LIST_NAVIGATION_DESTINATIONS_TOOL = "list_navigation_destinations";
export const GET_IDENTITY_TOOL = "get_identity";
export const DEFAULT_APP_URL = "https://app.botyard.io";

/** Base class for deeplink failures. */
export class DeeplinkError extends BotPageError {
  override name = "DeeplinkError";
  readonly key: string;

  constructor(key: string, message: string) {
    super(message);
    this.key = key;
  }
}

/** The navigation directory has no destination with this key. */
export class UnknownDestinationError extends DeeplinkError {
  override name = "UnknownDestinationError";
}

/** The params given do not match the destination's `required_params` exactly, or a value is unsafe. */
export class DeeplinkParamsError extends DeeplinkError {
  override name = "DeeplinkParamsError";
}

/**
 * The destination exists, but the navigation directory did not say which URL
 * it lives at, so no link can be built.
 *
 * `list_navigation_destinations` does not return route templates (`path`,
 * `search`) yet; Botyard platform task 5822 adds them. Until then every
 * {@link Deeplinks.resolve} call ends here. This package never falls back to
 * a hand-written URL, because one that drifts from the app's real routes
 * sends viewers to a 404.
 */
export class DeeplinkUnavailableError extends DeeplinkError {
  override name = "DeeplinkUnavailableError";
}

/** A navigation directory entry, as far as this package needs it. */
export interface NavigationDestination {
  readonly key: string;
  readonly label: string;
  readonly requiredParams: readonly string[];
  /** Route template such as `/orgs/$orgSlug/bots/$botSlug`, when the directory provides it. */
  readonly path: string | null;
  /**
   * Query-param templates such as `[{ name: "tab", value: "compute" }]`, in the
   * order the directory gives them. A value may be a `$param` placeholder.
   */
  readonly search: readonly NavigationSearchParam[];
}

/** One query param of a destination's `search` template. */
export interface NavigationSearchParam {
  readonly name: string;
  readonly value: string;
}

export interface DeeplinksOptions {
  /** Botyard app origin. Default `https://app.botyard.io`. Must be https. */
  appUrl?: string;
  /** The bot's org slug. Default: read once from `get_identity`. */
  orgSlug?: string;
  /** How long directory entries are cached. Default 10 minutes. */
  ttlMs?: number;
  /** Per-call timeout passed to the tool caller. Default 10 s. */
  timeoutMs?: number;
  /** Clock, for tests. */
  now?: () => number;
}

const ORG_PARAM = "orgSlug";
const LITERAL_SEGMENT = /^[A-Za-z0-9._~-]+$/;
const PARAM_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : null;
}

/**
 * Read a destination's `search`. The directory sends a list of `{ name, value }`
 * pairs (an object would have its keys masked by OpenClaw when a name looks
 * like a secret). A plain object is tolerated. `undefined` means none;
 * anything else unreadable is `null`.
 */
function parseSearch(raw: unknown): NavigationSearchParam[] | null {
  if (raw === undefined || raw === null) return [];
  if (Array.isArray(raw)) {
    const params: NavigationSearchParam[] = [];
    for (const item of raw) {
      if (!isRecord(item) || typeof item["name"] !== "string" || typeof item["value"] !== "string") return null;
      params.push({ name: item["name"], value: item["value"] });
    }
    return params;
  }
  if (isRecord(raw)) {
    const params: NavigationSearchParam[] = [];
    for (const name of Object.keys(raw).sort()) {
      const value = raw[name];
      if (typeof value !== "string") return null;
      params.push({ name, value });
    }
    return params;
  }
  return null;
}

function parseDestination(entry: unknown): NavigationDestination | null {
  if (!isRecord(entry) || typeof entry["key"] !== "string") return null;
  const requiredParams = stringArray(entry["required_params"]) ?? stringArray(entry["params"]) ?? [];
  const search = parseSearch(entry["search"]);
  // An unreadable search template makes the whole route unusable: building
  // the link without it could open the wrong tab or entity.
  const path = typeof entry["path"] === "string" && search !== null ? entry["path"] : null;
  return {
    key: entry["key"],
    label: typeof entry["label"] === "string" ? entry["label"] : entry["key"],
    requiredParams,
    path,
    search: search ?? [],
  };
}

/** Tools that return a list may arrive bare or wrapped as `{ result: [...] }`. */
function unwrapList(tool: string, response: unknown): unknown[] {
  if (Array.isArray(response)) return response;
  if (isRecord(response) && Array.isArray(response["result"])) return response["result"];
  throw new BotPageToolError(tool, "response is not a list");
}

function isUnsafeSegment(value: string): boolean {
  return value.length === 0 || value.includes("/") || value.includes("\\") || value === "." || value === "..";
}

function isPrintable(value: string): boolean {
  return value.trim().length > 0 && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
}

/**
 * Build a URL for a destination from its templates. Exported for tests and
 * for apps that already hold a directory entry; most apps call
 * {@link Deeplinks.resolve}.
 */
export function buildDeeplink(
  destination: NavigationDestination,
  orgSlug: string,
  params: Readonly<Record<string, string>>,
  appUrl: string = DEFAULT_APP_URL,
): string {
  const { key } = destination;
  if (destination.path === null) {
    throw new DeeplinkUnavailableError(
      key,
      `Cannot build a link to "${key}": list_navigation_destinations does not return route paths yet ` +
        "(Botyard platform task 5822). No hand-written URL is used instead.",
    );
  }
  const required = new Set(destination.requiredParams);
  const given = Object.keys(params);
  const missing = [...required].filter((name) => !(name in params)).sort();
  const unexpected = given.filter((name) => !required.has(name)).sort();
  if (missing.length > 0 || unexpected.length > 0) {
    throw new DeeplinkParamsError(
      key,
      `"${key}" expects params [${[...required].sort().join(", ")}]; ` +
        `missing [${missing.join(", ")}], unexpected [${unexpected.join(", ")}].`,
    );
  }
  if (isUnsafeSegment(orgSlug)) {
    throw new DeeplinkParamsError(key, `org slug must be a single path segment (got ${JSON.stringify(orgSlug)}).`);
  }

  const segments = destination.path.split("/");
  if (segments[0] !== "" || segments[1] !== "orgs" || segments[2] !== `$${ORG_PARAM}`) {
    throw new DeeplinkUnavailableError(key, `"${key}" has an unexpected route template: ${destination.path}`);
  }
  const path = segments
    .map((segment, index) => {
      if (index === 0) return "";
      if (!segment.startsWith("$")) {
        if (!LITERAL_SEGMENT.test(segment)) {
          throw new DeeplinkUnavailableError(key, `"${key}" has an unexpected route segment: ${segment}`);
        }
        return segment;
      }
      const name = segment.slice(1);
      if (!PARAM_NAME.test(name) || (name !== ORG_PARAM && !required.has(name))) {
        throw new DeeplinkUnavailableError(key, `"${key}" uses an undeclared route param: ${segment}`);
      }
      const value = name === ORG_PARAM ? orgSlug : (params[name] ?? "");
      if (isUnsafeSegment(value)) {
        throw new DeeplinkParamsError(
          key,
          `param "${name}" must be a non-empty single path segment (got ${JSON.stringify(value)}).`,
        );
      }
      return encodeURIComponent(value);
    })
    .join("/");

  // Appended in the order the directory gives (it sorts them), so the URL
  // matches the one emit_navigation resolves.
  const search = new URLSearchParams();
  for (const { name, value: template } of destination.search) {
    let value = template;
    if (template.startsWith("$")) {
      const param = template.slice(1);
      if (!required.has(param)) {
        throw new DeeplinkUnavailableError(key, `"${key}" uses an undeclared search param: ${template}`);
      }
      value = params[param] ?? "";
      if (!isPrintable(value)) {
        throw new DeeplinkParamsError(key, `param "${param}" must be non-empty printable text.`);
      }
    }
    search.append(name, value);
  }
  const query = search.toString();
  return new URL(query ? `${path}?${query}` : path, appUrl).toString();
}

function normalizeAppUrl(appUrl: string): string {
  let url: URL;
  try {
    url = new URL(appUrl);
  } catch {
    throw new BotPageError(`appUrl is not a URL: ${appUrl}`);
  }
  if (url.protocol !== "https:") throw new BotPageError(`appUrl must be https: ${appUrl}`);
  return url.origin;
}

/**
 * Deep links into the Botyard app, resolved through the platform's
 * navigation directory (`list_navigation_destinations`). Keys and their
 * required params come from that directory; nothing is hand-written.
 */
export class Deeplinks {
  readonly #tools: ToolCaller;
  readonly #appUrl: string;
  readonly #ttlMs: number;
  readonly #timeoutMs: number;
  readonly #now: () => number;
  readonly #cache = new Map<string, { destination: NavigationDestination | null; expiresAt: number }>();
  #orgSlug: Promise<string> | null;

  constructor(tools: ToolCaller, options: DeeplinksOptions = {}) {
    this.#tools = tools;
    this.#appUrl = normalizeAppUrl(options.appUrl ?? DEFAULT_APP_URL);
    this.#ttlMs = options.ttlMs ?? 10 * 60_000;
    this.#timeoutMs = options.timeoutMs ?? 10_000;
    this.#now = options.now ?? Date.now;
    this.#orgSlug = options.orgSlug === undefined ? null : Promise.resolve(options.orgSlug);
  }

  /** The directory entry for `key`, or `null` if there is none. */
  async destination(key: string): Promise<NavigationDestination | null> {
    const cached = this.#cache.get(key);
    if (cached !== undefined && cached.expiresAt > this.#now()) return cached.destination;
    let response: unknown;
    try {
      response = await this.#tools.call(
        LIST_NAVIGATION_DESTINATIONS_TOOL,
        { query: key },
        { timeoutMs: this.#timeoutMs },
      );
    } catch (error) {
      throw new BotPageToolError(LIST_NAVIGATION_DESTINATIONS_TOOL, "call failed", { cause: error });
    }
    const destination =
      unwrapList(LIST_NAVIGATION_DESTINATIONS_TOOL, response)
        .map(parseDestination)
        .find((entry) => entry?.key === key) ?? null;
    this.#cache.set(key, { destination, expiresAt: this.#now() + this.#ttlMs });
    return destination;
  }

  /**
   * An absolute `https://app.botyard.io/...` URL for directory destination
   * `key`, with `params` filling exactly its `required_params`.
   *
   * @throws {UnknownDestinationError} no destination has this key.
   * @throws {DeeplinkParamsError} params are missing, unexpected or unsafe.
   * @throws {DeeplinkUnavailableError} the directory does not expose the
   *   destination's route template (true for every key until Botyard
   *   platform task 5822 ships).
   * @throws {BotPageToolError} a platform tool call failed.
   */
  async resolve(key: string, params: Readonly<Record<string, string>> = {}): Promise<string> {
    const destination = await this.destination(key);
    if (destination === null) {
      throw new UnknownDestinationError(
        key,
        `No navigation destination "${key}". Call list_navigation_destinations to see valid keys.`,
      );
    }
    return buildDeeplink(destination, await this.#resolveOrgSlug(), params, this.#appUrl);
  }

  #resolveOrgSlug(): Promise<string> {
    this.#orgSlug ??= this.#fetchOrgSlug().catch((error: unknown) => {
      this.#orgSlug = null;
      throw error;
    });
    return this.#orgSlug;
  }

  async #fetchOrgSlug(): Promise<string> {
    let response: unknown;
    try {
      response = await this.#tools.call(GET_IDENTITY_TOOL, {}, { timeoutMs: this.#timeoutMs });
    } catch (error) {
      throw new BotPageToolError(GET_IDENTITY_TOOL, "call failed", { cause: error });
    }
    const slug = isRecord(response) ? response["org_slug"] : undefined;
    if (typeof slug !== "string" || slug.length === 0) {
      throw new BotPageToolError(GET_IDENTITY_TOOL, "response has no org_slug");
    }
    return slug;
  }
}
