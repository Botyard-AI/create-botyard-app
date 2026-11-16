import { Deeplinks, type DeeplinksOptions } from "./deeplinks.ts";
import { BotPageAuthError, BotPageConfigError } from "./errors.ts";
import type { RequestLike } from "./headers.ts";
import {
  parseBotShadowAddress,
  trustedForwardedUser,
  type IdentityFailureReason,
  type IdentitySource,
  type ViewerIdentity,
} from "./identity.ts";
import { isLoopbackAddress } from "./loopback.ts";
import { MemberDirectory, type MemberDirectoryOptions } from "./members.ts";
import type { ToolCaller } from "./tools.ts";

interface ViewerBase {
  readonly subject: string;
  /** Identity source that vouched for the viewer, or `dev-viewer` for the dev override. */
  readonly source: string;
}

/** A viewer found in the bot's org through `list_org_members`. */
export interface MemberViewer extends ViewerBase {
  readonly kind: "member";
  readonly viewerType: "user";
  readonly userId: string;
  readonly email: string | null;
  readonly name: string | null;
  /** Org role id, e.g. `owner`, `admin`, `member`, `viewer`. */
  readonly role: string | null;
  /** Always `null` for now: `list_org_members` does not return avatars yet. */
  readonly avatarUrl: string | null;
}

/**
 * An identified person who is not in the org's member list: someone added
 * after the cache was filled, or a subject the directory does not know.
 */
export interface UnknownViewer extends ViewerBase {
  readonly kind: "unknown";
  readonly viewerType: "user" | "unknown";
  readonly email: string | null;
}

/**
 * A Botyard bot viewing its own page. Bots are never org members, so the
 * member directory is not consulted and `requireMember` refuses them.
 */
export interface BotViewer extends ViewerBase {
  readonly kind: "bot";
  readonly viewerType: "bot";
  /** The bot id (also the `subject`). */
  readonly botId: string;
}

export type Viewer = MemberViewer | UnknownViewer | BotViewer;

export interface Logger {
  warn(message: string): void;
}

export interface BotPageOptions {
  /** Calls Botyard platform tools. Pass the `@botyard/runtime` client, or any {@link ToolCaller}. */
  tools: ToolCaller;
  /** How viewers are identified. Default {@link trustedForwardedUser}. */
  identity?: IdentitySource;
  /** Member cache settings. */
  members?: MemberDirectoryOptions;
  /** Deeplink settings. */
  deeplinks?: DeeplinksOptions;
  /**
   * Local development only: act as this viewer (an email or user id) when a
   * request carries no identity. Default: the `BOTYARD_DEV_VIEWER` env var.
   *
   * Refused at startup when `NODE_ENV` is `production`. At request time it
   * applies only when the server is known to listen on loopback: either the
   * request's socket is bound to loopback (Node, Hono on Node) or {@link bind}
   * names a loopback host.
   */
  devViewer?: string;
  /**
   * The host the app listens on, for runtimes where requests carry no socket
   * (Next, edge-style handlers). Node apps can let `guardListen` or
   * `listenLoopback` from `@botyard/botpage/node` record it instead.
   */
  bind?: string;
  /** Environment to read `NODE_ENV` and `BOTYARD_DEV_VIEWER` from. Default `process.env`. */
  env?: Readonly<Record<string, string | undefined>>;
  /** Where warnings go. Default `console`. */
  logger?: Logger;
}

export interface RequireMemberOptions {
  /** Allow only these org roles (e.g. `["owner", "admin"]`). Default: any member. */
  roles?: readonly string[];
}

export interface BotPage {
  /**
   * Identify the viewer and enrich them from the org directory. Resolves
   * `null` when no viewer could be identified.
   * @throws {BotPageToolError} the member directory is unavailable.
   */
  viewer(req: RequestLike): Promise<Viewer | null>;
  /**
   * Like {@link viewer}, but resolves only for org members (optionally with
   * one of `roles`).
   * @throws {BotPageAuthError} 401 when no viewer is identified, 403 when
   *   the viewer is not a member or lacks the role.
   * @throws {BotPageToolError} the member directory is unavailable.
   */
  requireMember(req: RequestLike, options?: RequireMemberOptions): Promise<MemberViewer>;
  /** Deep links into the Botyard app. */
  readonly deeplinks: Deeplinks;
  /** The cached org member directory. */
  readonly members: MemberDirectory;
  /** Record the address the server is bound to; warns when it is not loopback. */
  noteBind(address: string): void;
}

export const DEV_VIEWER_SOURCE = "dev-viewer";

/** Loopback IPs, or a Unix socket / Windows pipe path, which no other host can reach. */
function isLocalBind(address: string): boolean {
  return isLoopbackAddress(address) || address.startsWith("/") || address.startsWith("\\\\");
}

function defaultEnv(): Readonly<Record<string, string | undefined>> {
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  return proc?.env ?? {};
}

function nonLoopbackWarning(address: string): string {
  return (
    `@botyard/botpage: the server is bound to ${address}, not loopback. ` +
    "x-forwarded-user is unsigned, so anything that can reach this port can claim to be any viewer. " +
    "Listen on 127.0.0.1; Bot Pages reach the app over loopback."
  );
}

/**
 * Set up viewer identity, guards and deeplinks for one Bot Page app. Create
 * one per process and share it: the member cache lives on it.
 */
export function createBotPage(options: BotPageOptions): BotPage {
  const env = options.env ?? defaultEnv();
  const logger = options.logger ?? console;
  const identity = options.identity ?? trustedForwardedUser();
  const members = new MemberDirectory(options.tools, options.members);
  const deeplinks = new Deeplinks(options.tools, options.deeplinks);

  const devViewer = (options.devViewer ?? env["BOTYARD_DEV_VIEWER"] ?? "").trim() || null;
  if (devViewer !== null && env["NODE_ENV"] === "production") {
    throw new BotPageConfigError(
      "@botyard/botpage: the dev viewer override (devViewer / BOTYARD_DEV_VIEWER) is refused when NODE_ENV=production.",
    );
  }

  let bind: string | null = null;
  const warned = new Set<string>();
  const warnOnce = (key: string, message: string): void => {
    if (warned.has(key)) return;
    warned.add(key);
    logger.warn(message);
  };
  const noteBind = (address: string): void => {
    bind = address;
    if (!isLocalBind(address)) warnOnce(`bind:${address}`, nonLoopbackWarning(address));
  };
  if (options.bind !== undefined) noteBind(options.bind);

  const servedOnLoopback = (req: RequestLike): boolean => {
    const local = req.socket?.localAddress;
    if (local !== undefined) return isLoopbackAddress(local);
    return bind !== null && isLocalBind(bind);
  };

  const identify = async (req: RequestLike): Promise<ViewerIdentity | IdentityFailureReason> => {
    const result = await identity.identify(req);
    if (result.ok) return result;
    if (devViewer === null || result.reason !== "missing") return result.reason;
    if (!servedOnLoopback(req)) {
      warnOnce(
        "dev-off-loopback",
        "@botyard/botpage: ignoring the dev viewer override because the server is not known to listen on loopback. " +
          "Listen on 127.0.0.1 (and use guardListen/listenLoopback, or pass `bind`).",
      );
      return result.reason;
    }
    const botId = parseBotShadowAddress(devViewer);
    if (botId !== null) {
      return { ok: true, viewerType: "bot", subject: botId, botId, email: null, audience: null, source: DEV_VIEWER_SOURCE };
    }
    return {
      ok: true,
      subject: devViewer,
      viewerType: "unknown",
      email: devViewer.includes("@") ? devViewer : null,
      audience: null,
      source: DEV_VIEWER_SOURCE,
    };
  };

  const resolve = async (req: RequestLike): Promise<Viewer | IdentityFailureReason> => {
    const who = await identify(req);
    if (typeof who === "string") return who;
    if (who.viewerType === "bot") {
      return { kind: "bot", viewerType: "bot", subject: who.subject, botId: who.botId, source: who.source };
    }
    const member = await members.lookup(who.subject);
    if (member === null) {
      return { kind: "unknown", subject: who.subject, viewerType: who.viewerType, email: who.email, source: who.source };
    }
    return {
      kind: "member",
      subject: who.subject,
      viewerType: "user",
      source: who.source,
      userId: member.userId,
      email: member.email,
      name: member.name,
      role: member.role,
      avatarUrl: member.avatarUrl,
    };
  };

  return {
    async viewer(req) {
      const result = await resolve(req);
      return typeof result === "string" ? null : result;
    },
    async requireMember(req, requireOptions = {}) {
      const result = await resolve(req);
      if (typeof result === "string") {
        throw new BotPageAuthError("unauthenticated", `No viewer identified (${result}).`, result);
      }
      if (result.kind !== "member") {
        const who = result.kind === "bot" ? "A bot" : "The viewer";
        throw new BotPageAuthError("not_a_member", `${who} is not a member of this organization.`);
      }
      const roles = requireOptions.roles;
      if (roles !== undefined && (result.role === null || !roles.includes(result.role))) {
        throw new BotPageAuthError("role_not_allowed", `This page requires one of the roles: ${roles.join(", ")}.`);
      }
      return result;
    },
    deeplinks,
    members,
    noteBind,
  };
}
