/** The greeting for a viewer, by name when we know it. */
export function greeting(name: string | null): string {
  const trimmed = name?.trim()
  return trimmed ? `Hello, ${trimmed}!` : "Hello!"
}
