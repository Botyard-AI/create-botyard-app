# create-botyard-app

Scaffold an app that runs inside a [Botyard](https://botyard.io) bot and is
served to your org as a Bot Page.

```sh
npx create-botyard-app my-app
cd my-app
npm install
npm test
npm run dev
```

Node 22 or newer.

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
- It never overwrites a file. If it fails part-way, it removes what it wrote.
- The package has no dependencies and no install scripts.

## License

Apache-2.0
