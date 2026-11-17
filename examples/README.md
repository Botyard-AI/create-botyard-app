# Examples

Apps built the way a Botyard user builds one: scaffolded with the published
`npx create-botyard-app`, and depending on `@botyard/runtime` and
`@botyard/botpage` as published on npm, not on the sources in this
repository. Each one is a standalone npm project with its own lockfile.

| Example | What it shows |
| --- | --- |
| [`quote-desk`](./quote-desk) | A sales quote desk with bot and human approvals, served as a Bot Page. Work in progress. |

Fictional data only. To check an example the way CI does:

```sh
scripts/check-examples.sh examples/quote-desk
```
