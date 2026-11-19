# @botyard/eslint-config (private)

ESLint 10 flat configs for this repository and for the templates that
`create-botyard-app` generates. It is a private workspace package: nothing here
is published.

| Entry          | Source                       | What it is                                                                                                                                                                      |
| -------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `./base`       | Monorepo copy                | js recommended, typescript-eslint strict + stylistic, core rules, SonarJS cherry-picks, eslint-config-prettier.                                                                 |
| `./node`       | Monorepo copy                | `base` plus Node globals.                                                                                                                                                       |
| `./react`      | Monorepo copy (ahead: see below) | `base` plus React hooks, Fast Refresh and browser globals. Unused today; it is here for the templates.                                                                         |
| `./zero-any`   | Local                        | The code-review "no `any`" gate, including any laundered through type escapes: the type-aware `no-unsafe-*` rules, unsafe and unnecessary assertions, unnecessary conditions and exhaustive `switch`. Takes the package directory. |
| `./javascript` | Local                        | ESLint recommended rules and Node globals for plain `.js`/`.mjs` files, which the monorepo configs do not lint.                                                                |

## Using it

A TypeScript package:

```js
// eslint.config.js
import { javascript } from "@botyard/eslint-config/javascript"
import { node, tseslint } from "@botyard/eslint-config/node"
import { zeroAny } from "@botyard/eslint-config/zero-any"

export default tseslint.config(
  { ignores: ["dist"] },
  ...node,
  ...zeroAny(import.meta.dirname),
  ...javascript
)
```

Add `"@botyard/eslint-config": "workspace:*"` and `eslint` to the package's
`devDependencies`. `zeroAny` needs type information, so every linted `.ts` file
must be in the package's `tsconfig.json` (extend `../../tsconfig.base.json`).

A React template uses `reactConfig` from `./react` instead of `node`. A template
that is generated outside this workspace cannot depend on a private package, so
the scaffolder copies these files into the generated app.

Any per-file override needs a comment explaining why, as in the monorepo.
Prefer an `eslint-disable-next-line <rule>` with the reason on the line above
to a file-wide override.

## Re-syncing from the monorepo

`base.js`, `node.js` and `react.js` are byte-for-byte copies of
`packages/eslint-config/*.js` in `Botyard-AI/botyard`, below a header naming the
commit they were read at. Prettier skips them so they stay identical.

1. Fetch the monorepo's `main` and note the commit.
2. For each file, replace everything below the header with
   `git show <commit>:packages/eslint-config/<file>.js`, and update the header's
   commits (`git log -1 <commit> -- packages/eslint-config/<file>.js` gives the
   last change).
3. Match the dependency ranges in `package.json` to the monorepo's
   `packages/eslint-config/package.json`, within this repository's 3-day
   `minimumReleaseAge`.
4. Run `pnpm run lint` and fix what the new rules find.

`react.js` is ahead of the monorepo for now. It moved to ESLint 10 first and
drops `eslint-plugin-react` (no ESLint 10 support) and its only rule,
`react/no-multi-comp` (task 5834). Re-sync it once the monorepo takes the same
change.
