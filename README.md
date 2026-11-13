# create-botyard-app

Scaffold apps, Bot Pages and MCP servers for [Botyard](https://botyard.io) AI agents.

```sh
npx create-botyard-app my-app
```

> **Status: pre-release.** Nothing is published to npm yet. This repository is
> being bootstrapped; the CLI, templates and libraries land in follow-up PRs.

## What it will contain

| Path | Package | Purpose |
| --- | --- | --- |
| `packages/create-botyard-app` | `create-botyard-app` | The `npx` scaffolder |
| `packages/runtime` | `@botyard/runtime` | Call Botyard tools from an app (botyardd on native bots, the MCP endpoint on OpenClaw bots, a mock in tests) |
| `packages/botpage` | `@botyard/botpage` | The signed-in viewer of a Bot Page, org membership checks, deeplinks |
| `packages/ui` | `@botyard/ui` | Optional React pieces for Bot Pages |
| `templates/` | — | `static`, `next`, `full-app`, `mcp` |

Botyard documentation: [docs.botyard.io](https://docs.botyard.io).

## Contributing

This repository is developed by the Botyard-AI team. Issues and discussions are
welcome; pull requests from outside the team are not accepted. See
[CONTRIBUTING.md](./CONTRIBUTING.md).

## Security

Report vulnerabilities privately; see [SECURITY.md](./SECURITY.md).

## License

[Apache-2.0](./LICENSE). Files generated into your project by
`create-botyard-app` are yours: you may use, modify and license them however you
like, without attribution.
