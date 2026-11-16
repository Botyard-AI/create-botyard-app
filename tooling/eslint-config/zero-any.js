// Local to create-botyard-app; NOT part of the monorepo copy. This layer turns
// the Botyard code-review standard's "no any" gate (including any laundered
// through type escapes) into lint errors, so CI enforces it instead of a
// reviewer's grep. It needs type information, so it is a function of the
// package directory that holds the tsconfig.json.
//
// What the copied base config already covers (typescript-eslint strict):
//   - no-explicit-any: an `any` written in source.
//   - ban-ts-comment: `@ts-ignore` and `@ts-nocheck` are banned, and
//     `@ts-expect-error` needs a written reason.
//   - no-non-null-assertion: the `x!` escape.
//
// What this layer adds:
//   - no-unsafe-*: an `any` that arrives without being written, e.g. from
//     `JSON.parse`, `response.json()` or an untyped library, and then flows into
//     typed code. Narrow it from `unknown` instead.
//   - no-unsafe-type-assertion: a cast that claims more than the compiler
//     knows (`x as Foo` from a wider type, or `as unknown as Foo`).
//   - no-unnecessary-type-assertion and no-unnecessary-condition: casts and
//     defensive branches (`?? fallback`, `?.`, `if (x)`) for cases the types say
//     can never happen. They exist only to paper over a type that is wrong
//     upstream.
//   - switch-exhaustiveness-check: a `switch` over a closed union must handle
//     every member, so a new member breaks the build rather than falling
//     through to a silent default.
//
// Usage, in a package's eslint.config.js:
//   import { node, tseslint } from "@botyard/eslint-config/node"
//   import { zeroAny } from "@botyard/eslint-config/zero-any"
//   export default tseslint.config(
//     { ignores: ["dist"] },
//     ...node,
//     ...zeroAny(import.meta.dirname)
//   )

/**
 * @param {string} tsconfigRootDir The directory holding the package's tsconfig.json.
 * @returns {import("typescript-eslint").ConfigArray}
 */
export function zeroAny(tsconfigRootDir) {
  return [
    {
      files: ["**/*.{ts,tsx}"],
      languageOptions: {
        parserOptions: {
          projectService: true,
          tsconfigRootDir,
        },
      },
      rules: {
        "@typescript-eslint/no-explicit-any": ["error", { fixToUnknown: false }],
        "@typescript-eslint/no-unsafe-argument": "error",
        "@typescript-eslint/no-unsafe-assignment": "error",
        "@typescript-eslint/no-unsafe-call": "error",
        "@typescript-eslint/no-unsafe-member-access": "error",
        "@typescript-eslint/no-unsafe-return": "error",
        "@typescript-eslint/no-unsafe-type-assertion": "error",
        "@typescript-eslint/no-unnecessary-type-assertion": "error",
        "@typescript-eslint/no-unnecessary-condition": "error",
        "@typescript-eslint/switch-exhaustiveness-check": [
          "error",
          { considerDefaultExhaustiveForUnions: false },
        ],
      },
    },
  ]
}
