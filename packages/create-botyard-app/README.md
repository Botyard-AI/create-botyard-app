<p align="center">
  <a href="https://botyard.io"><img src="https://raw.githubusercontent.com/Botyard-AI/create-botyard-app/a516c25401316d616bc1a3209026a39539bf2427/assets/brand/botyard-app-icon-navy.svg" alt="Botyard" width="96"></a>
</p>

# create-botyard-app

Scaffold an app that runs inside a [Botyard](https://botyard.io) bot and is
served to your org as a [Bot Page](https://botyard.io/features/bot-pages).

<p align="center">
  <a href="https://www.npmjs.com/package/create-botyard-app"><img src="https://img.shields.io/npm/v/create-botyard-app?color=d4622b" alt="npm version"></a>
  <a href="https://docs.npmjs.com/generating-provenance-statements"><img src="https://img.shields.io/badge/npm-provenance-4a5c6a" alt="Published with npm provenance"></a>
  <a href="https://github.com/Botyard-AI/create-botyard-app/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/create-botyard-app?color=4a5c6a" alt="License: Apache-2.0"></a>
</p>

```sh
npx create-botyard-app my-app
cd my-app
npm ci --include=dev
npm test
```

`--include=dev` keeps the test and build tools installed even when
`NODE_ENV=production`, as it is inside a Botyard bot.

Then, on your machine, `npm run dev:mock` serves the app against fixture data,
signed in as a sample user. Inside a Botyard bot, `npm run dev` starts it on
127.0.0.1:8787; run `npm run expose` from a second shell in the app directory
to publish it as a Bot Page. The app's README covers the rest.

The scaffolder runs on Node 22 or newer. The app it creates runs on Node 22
(22.18 or later) or Node 24.

## Options

```
create-botyard-app <directory> [options]

  -t, --template <name>  Template to use (default: full-app)
      --name <name>      npm package name (default: the directory name)
      --list-templates   List the bundled templates
  -v, --version          Print the version
  -h, --help             Print this help
```

`<directory>` must not exist yet, or be empty. Missing parent directories are
created. The app's `package.json` name, and the Bot Page name in its
`botyard.json`, come from `--name` or the directory name, which must then be a
valid npm package name.

## What it does, and does not do

- It copies **only the templates bundled in this package**. It does not fetch
  anything from the network, clone a repository or run a remote script.
- It does **not** install dependencies or run any of the app's scripts. You
  run `npm install` yourself, after reading what it will install.
- It never overwrites or deletes anything. If it fails part-way, it leaves
  what it created and lists the paths it created. That list records what the
  run did, not what is there now: another process may have replaced a path
  or added files inside one, so check before removing anything. Another
  process renaming directories in the target's path while it runs can make
  it fail, and in rare cases leave new files where that process pointed.
- The package has no dependencies and no install scripts.

## Links

- [Source](https://github.com/Botyard-AI/create-botyard-app/tree/main/packages/create-botyard-app) and [changelog](https://github.com/Botyard-AI/create-botyard-app/blob/main/CHANGELOG.md)
- [Report an issue](https://github.com/Botyard-AI/create-botyard-app/issues). Security reports go privately, see [SECURITY.md](https://github.com/Botyard-AI/create-botyard-app/blob/main/SECURITY.md).
- [Bot Pages](https://botyard.io/features/bot-pages) and [Hosting apps](https://docs.botyard.io/docs/hosting-apps) in the Botyard docs
- [botyard.io](https://botyard.io)

## License

Apache-2.0
