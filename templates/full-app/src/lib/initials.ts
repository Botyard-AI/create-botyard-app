/** Up to two initials for an avatar fallback: "Ada Lovelace" → "AL". */
export function initials(name: string): string {
  const parts = name.split(/[\s@._-]+/).filter((p) => p.length > 0)
  return (
    parts
      .slice(0, 2)
      .map((p) => p.charAt(0).toUpperCase())
      .join("") || "?"
  )
}
