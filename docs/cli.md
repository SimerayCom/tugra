# CLI

`@tugra/cli` is the official command-line client (`tugra`) for the Tugra REST API. It's a small,
MIT-licensed client you can use from your terminal or CI.

## Quick start

> **Note:** `@tugra/cli` is published to npm with the first tagged release. Until then, build it from a
> checkout — `pnpm --filter @tugra/cli build` — and run `node packages/cli/dist/index.js` in place of the
> `tugra` command below.

```bash
npm i -g @tugra/cli                            # once published (see note above)
tugra login --hub https://tugra.example.com   # paste a PAT from Settings → API tokens
tugra servers ls
```

Add `--json` to any command for scriptable output.

## Full reference

The complete command list, configuration and token-security notes live in the package README:
**[packages/cli/README.md](../packages/cli/README.md)**.

## API & scopes

The CLI is a thin client over the [REST API](api.md); commands like `tugra apps deploy` need the matching
[scope](api.md#scopes) on your token.
