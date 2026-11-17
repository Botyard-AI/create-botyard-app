// Small helpers for narrowing untrusted JSON to typed values without casts.
// Each throws ParseError with a path, e.g. "lines[2].qty: must be a number".

export class ParseError extends Error {
  override name = "ParseError"
}

export type Rec = Readonly<Record<string, unknown>>

export function isRecord(value: unknown): value is Rec {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function record(value: unknown, at: string): Rec {
  if (!isRecord(value)) throw new ParseError(`${at}: must be an object`)
  return value
}

export function str(r: Rec, key: string, at: string, max = 200): string {
  const v = r[key]
  if (typeof v !== "string" || v.length > max) {
    throw new ParseError(`${at}.${key}: must be a string of at most ${String(max)} characters`)
  }
  return v
}

export function strOrNull(r: Rec, key: string, at: string, max = 200): string | null {
  return r[key] === null || r[key] === undefined ? null : str(r, key, at, max)
}

export function num(r: Rec, key: string, at: string): number {
  const v = r[key]
  if (typeof v !== "number" || !Number.isFinite(v))
    throw new ParseError(`${at}.${key}: must be a number`)
  return v
}

export function bool(r: Rec, key: string, at: string): boolean {
  const v = r[key]
  if (typeof v !== "boolean") throw new ParseError(`${at}.${key}: must be true or false`)
  return v
}

export function oneOf<T extends string>(r: Rec, key: string, values: readonly T[], at: string): T {
  const v = r[key]
  const match = values.find((x) => x === v)
  if (match === undefined) throw new ParseError(`${at}.${key}: must be one of ${values.join(", ")}`)
  return match
}

export function list(value: unknown, at: string, max: number): readonly unknown[] {
  if (!Array.isArray(value)) throw new ParseError(`${at}: must be a list`)
  if (value.length > max) throw new ParseError(`${at}: at most ${String(max)} items`)
  return value
}

/** A list field parsed item by item, with each item's path. */
export function items<T>(
  r: Rec,
  key: string,
  at: string,
  max: number,
  parse: (value: unknown, at: string) => T
): T[] {
  return list(r[key], `${at}.${key}`, max).map((v, i) => parse(v, `${at}.${key}[${String(i)}]`))
}

export function strings(r: Rec, key: string, at: string, max: number): string[] {
  return items(r, key, at, max, (v, p) => {
    if (typeof v !== "string") throw new ParseError(`${p}: must be a string`)
    return v
  })
}
