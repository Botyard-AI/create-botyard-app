# Blocks

Blocks are pieces of a Botyard app that you add to an app made by
`create-botyard-app`: a React component, the server code behind it, and its
tests. They are published as a [shadcn registry](https://ui.shadcn.com/docs/registry)
at `https://blocks.botyard.io`, so an app adds one with:

```sh
npx shadcn@latest add @botyard/<block>
```

shadcn fetches `https://blocks.botyard.io/r/<block>.json`, writes the block's
files into the app and installs its npm dependencies. `npx shadcn@latest
search @botyard` lists the blocks. For `@botyard/` to resolve, the app's
`components.json` lists the registry, as the `full-app` template does:

```json
"registries": { "@botyard": "https://blocks.botyard.io/r/{name}.json" }
```

An app made before create-botyard-app 0.1.3 needs that line added by hand,
and one made before 0.1.2 also needs `"paths": { "@/*": ["./src/*"] }` in
its root `tsconfig.json`.

The sources are in `registry/`: `registry.json` lists the blocks, and
`registry/blocks/<block>/` holds each block's files. `greeting` is a small
sample that shows the layout.

## Add a block

1. Put the files under `registry/blocks/<block>/`, written as they will be in
   the app. They import the app's code with the `@/` alias (`@/lib/utils`,
   `@/components/ui/card`) and with relative paths elsewhere.
2. Add an item to `registry/registry.json`:

   ```json
   {
     "name": "greeting",
     "type": "registry:block",
     "title": "Greeting",
     "description": "One sentence on what it does.",
     "files": [
       { "path": "registry/blocks/greeting/components/greeting.tsx", "type": "registry:component" },
       {
         "path": "registry/blocks/greeting/server/greeting.ts",
         "type": "registry:file",
         "target": "~/server/greeting.ts"
       },
       {
         "path": "registry/blocks/greeting/test/greeting.test.ts",
         "type": "registry:file",
         "target": "~/test/greeting.test.ts"
       }
     ]
   }
   ```

   - Components (`registry:component`, `registry:ui`, `registry:hook`,
     `registry:lib`) go where the app's `components.json` says, under `src/`.
   - Anything else is a `registry:file` with a `target`; `~` is the app's root.
     Server code goes under `~/server/`, tests under `~/test/` (UI tests under
     `~/test/ui/`), so the app's `npm test` runs them.
   - shadcn cannot edit files that are already in the app, such as
     `server/app.ts`. If a block has API routes, export the handlers, and say
     in the `description` how to add them to `api` in `server/app.ts`.

3. Run `pnpm run build` and `pnpm run check:blocks`.

### Rules for dependencies

`node scripts/check-blocks.ts` refuses a registry that breaks these
(`scripts/blocks/rules.ts`):

- **npm dependencies are exact versions**, `"<name>@<x.y.z>"` in
  `dependencies` or `devDependencies`, such as `"dependencies": ["zod@4.1.12"]`. Each version must have been public on
  npm for at least 3 days, and nothing the block adds to the lockfile may
  have an install script.
- **`registryDependencies` name only `@botyard/` blocks.** shadcn/ui's own
  components, such as `button`, list their npm dependencies without versions,
  so shadcn would install whatever is newest. A block that needs one ships its
  own copy as another `@botyard` block, with exact dependencies.
- A dependency the template already has must be at the template's version.
- **Files stay in the block's place.** A `target` is under `~/server/`,
  `~/src/` or `~/test/`, with no `..`. A block never writes `package.json`,
  `.npmrc`, `.env` or anything outside the app.
- **Only the plain fields.** shadcn's `envVars` (writes `.env`), `css` and
  `cssVars` (edit the app's stylesheet) and anything else not in
  `scripts/blocks/rules.ts` are refused until we decide to support them.

Exact versions pin a block's *direct* dependencies only. In a user's app,
shadcn runs `npm install <name>@<version>` and npm resolves their
dependencies afresh, outside the 3-day rule. Review the lockfile change after
adding a block, as the app's README says for any new package.

## Test a block

```sh
pnpm install
pnpm run build                 # the CLI, and the registry in registry/dist
pnpm run check:blocks          # every block
pnpm run check:blocks greeting # one block
```

CI runs the same check in the `ci` job, so a block that breaks a generated app
fails CI. For each block, `scripts/check-blocks.ts`:

1. Generates an app with the CLI built from this commit.
2. Checks that the app's `components.json` names
   `https://blocks.botyard.io/r/{name}.json`, then serves the built registry,
   `registry/dist` (what `registry.yml` publishes), on `127.0.0.1` and points
   the app there: the same URL with only the host changed.
3. Adds the block's npm dependencies to the app's `package.json` and locks them
   with `scripts/lock-template.sh --app`: third-party versions as of 3 days
   ago, no install scripts.
4. Runs `npm ci`, then `shadcn add @botyard/<block>`.
5. Checks that `shadcn search @botyard` lists the block.
6. Runs the app's `lint`, `format:check`, `typecheck`, `test` and `build`.

shadcn installs a block's npm dependencies with a plain `npm install`, which
ignores the 3-day rule, so the local server leaves them out of the block. Step
3 has already installed them under the rules. `npm`, `pnpm`, `yarn` and `bun`
are replaced by stubs that fail if shadcn runs them anyway.

During a release bump the CLI built in CI pins one of our packages at a
version that is not on npm yet (see [releasing.md](./releasing.md)), so the
generated app cannot install. In CI only (`BOTYARD_ALLOW_UNPUBLISHED_BUMP=1`),
the check then puts that package back to the published version the app's
lockfile locks, says so in a notice, and checks the block against it.
Anywhere else, and in the publish workflow, a mismatch is an error.

## Publish

`.github/workflows/registry.yml` publishes `main` to `https://blocks.botyard.io`.
Start it by hand: **Actions → Publish blocks → Run workflow** on `main`.

1. **build** (read-only, no secrets) runs `pnpm run build` and
   `pnpm run check:blocks` without the release-bump exception, then uploads
   `registry/dist`. A block that fails, or a `main` whose CLI cannot be built,
   is not published.
2. **publish** waits for approval in the `blocks-publish` environment (`main`
   only, a maintainer other than whoever started it). It then deploys exactly
   that artifact with `wrangler deploy` (`registry/wrangler.jsonc`), as the
   static assets of the `botyard-blocks` Cloudflare Worker, and checks that
   `https://blocks.botyard.io` serves every file it deployed.

The Worker serves static files only and has no code. Its hostname is managed
by Terraform in the Botyard monorepo (`infra/blocks-registry`), not here. The
`blocks-publish` environment holds:

| Name | Kind | What |
| --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | secret | Can deploy the `botyard-blocks` Worker and nothing else |
| `CLOUDFLARE_ACCOUNT_ID` | variable | The Cloudflare account |

A publish replaces the whole registry with what is on `main`. To withdraw a
block, remove it from `registry.json` and publish again.
