import { readHeader, type RequestLike } from "./headers.ts"
import { isLoopbackAddress } from "./loopback.ts"

/**
 * What kind of principal is viewing the page. `unknown` means the identity
 * source cannot tell: `x-forwarded-user` carries an email or an id with no
 * type. A signed viewer assertion says `user` or `bot` explicitly.
 */
export type ViewerType = "user" | "bot" | "unknown"

interface IdentityBase {
  readonly ok: true
  /**
   * The audience the credential was issued for (a Bot Page exposure id) when
   * the source verified one, else `null`. Unsigned sources never set it.
   */
  readonly audience: string | null
  /** Which identity source vouched for the subject, e.g. `trusted-forwarded-user`. */
  readonly source: string
}

/** A person, or a principal the source cannot classify. */
export interface PersonIdentity extends IdentityBase {
  readonly viewerType: "user" | "unknown"
  /** Stable subject: an email address or a Botyard user id. */
  readonly subject: string
  /** The viewer's email when the source knows it, else `null`. */
  readonly email: string | null
}

/**
 * A Botyard bot viewing its own page (the only bot the proxy lets in).
 * Bots have no mailbox and are never org members.
 */
export interface BotIdentity extends IdentityBase {
  readonly viewerType: "bot"
  /** The bot id; also the `subject`, as in a signed viewer assertion. */
  readonly subject: string
  readonly botId: string
  readonly email: null
}

/** Who the request says the viewer is, before any directory lookup. */
export type ViewerIdentity = PersonIdentity | BotIdentity

/**
 * Why a source could not identify the viewer. A closed set, so guards and
 * logs can switch on it:
 *
 * - `missing`: the request carries no credential for this source.
 * - `malformed`: the credential is present but unreadable (repeated header,
 *   bad characters, undecodable token).
 * - `untrusted_peer`: the request did not come through the Bot Page tunnel.
 * - `invalid_signature`, `expired`, `not_yet_valid`, `wrong_audience`,
 *   `wrong_type`, `replayed`: reserved for signed viewer assertions.
 * - `untrusted_issuer`: the credential is well formed, but its signer is not
 *   the trusted issuer (for example, a certificate chain that does not anchor
 *   in the trust bundle, or the wrong workload identity).
 * - `key_unavailable`: the trust material (keys or trust bundle) could not
 *   be loaded.
 */
export type IdentityFailureReason =
  | "missing"
  | "malformed"
  | "untrusted_peer"
  | "invalid_signature"
  | "expired"
  | "not_yet_valid"
  | "wrong_audience"
  | "wrong_type"
  | "replayed"
  | "untrusted_issuer"
  | "key_unavailable"

export interface IdentityFailure {
  readonly ok: false
  readonly reason: IdentityFailureReason
  readonly source: string
}

export type IdentityResult = ViewerIdentity | IdentityFailure

/**
 * A strategy for identifying the viewer of a request.
 *
 * Today the only platform signal is the unsigned `x-forwarded-user` header
 * ({@link trustedForwardedUser}). When Botyard ships signed, page-scoped
 * viewer assertions, a verifying source plugs in here and the rest of the
 * app is unchanged.
 *
 * Sources fail closed: a missing, forged or malformed credential is an
 * {@link IdentityFailure}, never an exception and never a fallback to a
 * weaker source. Throw only for programming errors.
 */
export interface IdentitySource {
  readonly name: string
  identify(req: RequestLike): IdentityResult | Promise<IdentityResult>
}

/** The only identity header the Bot Page proxy sets. Every other one is not real. */
export const FORWARDED_USER_HEADER = "x-forwarded-user"

const MAX_SUBJECT_LENGTH = 320
// Printable, no whitespace, no comma: a comma means the header was repeated
// and joined, and an email or user id never contains one. Matching control
// characters is the point here, so no-control-regex does not apply.
// eslint-disable-next-line no-control-regex
const SUBJECT_PATTERN = /^[^\s,\u0000-\u001f\u007f]+$/u

/**
 * Parse an `x-forwarded-user` value into a subject, or `null` when it is
 * repeated, oversized or malformed.
 */
export function parseForwardedUser(raw: string | readonly string[]): string | null {
  let value: string
  if (typeof raw === "string") {
    value = raw
  } else {
    if (raw.length !== 1) return null
    value = raw[0] ?? ""
  }
  const subject = value.trim()
  if (subject.length === 0 || subject.length > MAX_SUBJECT_LENGTH) return null
  return SUBJECT_PATTERN.test(subject) ? subject : null
}

export interface TrustedForwardedUserOptions {
  /**
   * Refuse the header (`untrusted_peer`) when the request's TCP peer is known
   * and is not loopback. The Bot Page tunnel connects from inside the bot over
   * 127.0.0.1, so anything else reaching the app could forge the header. Has
   * no effect when the request carries no socket (a Web `Request`).
   * Default `true`.
   */
  requireLoopbackPeer?: boolean
}

export const TRUSTED_FORWARDED_USER_SOURCE = "trusted-forwarded-user"

// Botyard signs bots in with a shadow address, `bot+<bot-id>@bots.botyard.internal`
// (auth/src/spiffe-session.ts). It is not a mailbox, and the domain is
// non-routable, so no human account can hold one.
const BOT_SHADOW_ADDRESS = /^bot\+([a-z0-9][a-z0-9-]*)@bots\.botyard\.internal$/iu

/**
 * The bot id in a bot session's shadow address
 * (`bot+<bot-id>@bots.botyard.internal`), or `null` for any other subject.
 */
export function parseBotShadowAddress(subject: string): string | null {
  const match = BOT_SHADOW_ADDRESS.exec(subject)
  return match?.[1]?.toLowerCase() ?? null
}

/**
 * Identify the viewer from `x-forwarded-user`, which the Bot Page proxy sets
 * to the signed-in viewer's email (or their id when there is no email). It is
 * the only identity the proxy forwards: Authorization, cookies, Referer and
 * `?token=` are stripped before the request reaches the bot.
 *
 * The header is **not signed**, hence the name: it is trustworthy only
 * because the proxy overwrites it and the app is reachable only through the
 * proxy. That holds only while the app listens on 127.0.0.1.
 *
 * A bot's shadow address (`bot+<bot-id>@bots.botyard.internal`) becomes a
 * {@link BotIdentity} whose subject is the bot id, with no email, which is
 * the shape a signed viewer assertion will produce. Anything else is a
 * {@link PersonIdentity} of type `unknown`, and an `@` makes the subject its
 * email.
 */
export function trustedForwardedUser(options: TrustedForwardedUserOptions = {}): IdentitySource {
  const requireLoopbackPeer = options.requireLoopbackPeer ?? true
  const source = TRUSTED_FORWARDED_USER_SOURCE
  return {
    name: source,
    identify(req) {
      const raw = readHeader(req, FORWARDED_USER_HEADER)
      if (raw === null) return { ok: false, reason: "missing", source }
      const peer = req.socket?.remoteAddress
      if (requireLoopbackPeer && peer !== undefined && !isLoopbackAddress(peer)) {
        return { ok: false, reason: "untrusted_peer", source }
      }
      const subject = parseForwardedUser(raw)
      if (subject === null) return { ok: false, reason: "malformed", source }
      const botId = parseBotShadowAddress(subject)
      if (botId !== null) {
        return {
          ok: true,
          viewerType: "bot",
          subject: botId,
          botId,
          email: null,
          audience: null,
          source,
        }
      }
      return {
        ok: true,
        viewerType: "unknown",
        subject,
        email: subject.includes("@") ? subject : null,
        audience: null,
        source,
      }
    },
  }
}
