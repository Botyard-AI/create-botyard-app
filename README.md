<p align="center">
  <a href="https://botyard.io">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="assets/brand/botyard-lockup-on-dark.svg">
      <img src="assets/brand/botyard-lockup-on-light.svg" alt="Botyard" width="241">
    </picture>
  </a>
</p>

<h1 align="center">create-botyard-app</h1>

<p align="center">
  Build web apps that run inside your <a href="https://botyard.io">Botyard</a> bot
  and are served to your org as <a href="https://botyard.io/features/bot-pages">Bot Pages</a>,
  behind Botyard sign-in.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/create-botyard-app"><img src="https://img.shields.io/npm/v/create-botyard-app?label=create-botyard-app&color=d4622b" alt="npm version"></a>
  <a href="https://github.com/Botyard-AI/create-botyard-app/actions/workflows/ci.yml"><img src="https://github.com/Botyard-AI/create-botyard-app/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://scorecard.dev/viewer/?uri=github.com/Botyard-AI/create-botyard-app"><img src="https://api.scorecard.dev/projects/github.com/Botyard-AI/create-botyard-app/badge" alt="OpenSSF Scorecard"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/github/license/Botyard-AI/create-botyard-app?color=4a5c6a" alt="License: Apache-2.0"></a>
</p>

## Quick start

Create the app and install exactly what its lockfile pins:

```sh
npx create-botyard-app my-app
cd my-app
npm ci --include=dev
npm test
```

`--include=dev` keeps the test and build tools installed even when
`NODE_ENV=production`, as it is inside a Botyard bot.

**On your machine**, run it against fixture data, signed in as a sample user:

```sh
npm run dev:mock
```

**Inside a Botyard bot**, start the app (API and UI with hot reload on
127.0.0.1:8787):

```sh
npm run dev
```

Then, from a second shell in the app directory while it runs, publish it as a
Bot Page and print its URL:

```sh
npm run expose
```

The app runs on Node 22 (22.18 or later) or Node 24: its server is TypeScript
that Node runs directly. The scaffolder itself downloads and installs nothing:
it copies only the templates bundled in its npm package and runs none of your
app's scripts.

You get a Node API and a React UI on one port. The API knows who is viewing
the page and whether they are a member of your org, and it can call the
platform tools assigned to your bot.

## Packages

| Package | Version | What it is for |
| --- | --- | --- |
| [`create-botyard-app`](./packages/create-botyard-app#readme) | [![npm](https://img.shields.io/npm/v/create-botyard-app?label=)](https://www.npmjs.com/package/create-botyard-app) | The `npx` scaffolder. |
| [`@botyard/runtime`](./packages/runtime#readme) | [![npm](https://img.shields.io/npm/v/%40botyard%2Fruntime?label=)](https://www.npmjs.com/package/@botyard/runtime) | Call Botyard platform tools from your app. No credentials in your code, typed errors, never retries. |
| [`@botyard/botpage`](./packages/botpage#readme) | [![npm](https://img.shields.io/npm/v/%40botyard%2Fbotpage?label=)](https://www.npmjs.com/package/@botyard/botpage) | Who is viewing your Bot Page, members-only guards, and links back into Botyard. Adapters for Node `http`, Hono and Next.js. |
| [`@botyard/ui`](./packages/ui#readme) | [placeholder](https://www.npmjs.com/package/@botyard/ui) | React pieces for Bot Pages. **Placeholder only; no usable release yet.** |

The template the scaffolder ships is in [`templates/full-app`](./templates/full-app#readme).
[`examples/`](./examples#readme) holds apps built on the packages as published on npm.

## Learn more

- [Bot Pages](https://botyard.io/features/bot-pages): what Bot Pages are and who they are for.
- [Hosting apps](https://docs.botyard.io/docs/hosting-apps): how a bot serves an app, limits, security and troubleshooting.
- [Botyard docs](https://docs.botyard.io/docs) and [getting started](https://docs.botyard.io/docs/getting-started).
- [botyard.io](https://botyard.io)

## Contributing

This repository is developed by the Botyard-AI team. Issues and discussions are
welcome; pull requests from outside the team are not accepted. See
[CONTRIBUTING.md](./CONTRIBUTING.md). Changes are recorded in
[CHANGELOG.md](./CHANGELOG.md).

## Security

Releases built by this repository's release workflow include
[npm provenance](https://docs.npmjs.com/generating-provenance-statements), so
you can check that a release was built from this repository. Report
vulnerabilities privately; see [SECURITY.md](./SECURITY.md).

## License

[Apache-2.0](./LICENSE). Files generated into your project by
`create-botyard-app` are yours: you may use, modify and license them however you
like, without attribution.
