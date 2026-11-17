# tugra-cli

The command-line client for [Tugra](https://github.com/SimerayCom/tugra), the self-hostable server
control plane. Talk to your hub's REST API from the terminal or CI — list servers, deploy and restart
apps, tail logs, run backups. MIT-licensed.

## Install

```bash
npm i -g tugra-cli
```

Published to npm with the first tagged release; until then, build from a checkout
(`pnpm --filter tugra-cli build` and run `node packages/cli/dist/index.js`).

## Authenticate

The CLI uses a **personal access token** — mint one in the web UI under **Settings → API tokens**, then:

```bash
tugra login --hub https://tugra.example.com
```

You'll be prompted to paste the token (input is hidden). You can also pass it non-interactively with
`--token <tok>` or the `TUGRA_TOKEN` environment variable. Tokens must start with `tugra_pat_`; the CLI
verifies the hub before saving. The token is never minted by the CLI — it's created in the UI and pasted.

## Configuration

Profiles are stored in `~/.config/tugra/config.json` (honoring `$XDG_CONFIG_HOME`), written with `chmod 600`
because it holds bearer tokens. Manage multiple hubs with named profiles:

```bash
tugra login --hub https://prod.example.com --profile prod
tugra ctx                 # list profiles (active *, hub, masked token)
tugra ctx use prod        # switch the active profile
tugra logout --profile prod   # forget the token locally (does NOT revoke it — revoke in the web UI)
```

## Commands

| Command | Description |
|---|---|
| `tugra login --hub <url> [--token <t>] [--profile <name>]` | Save a hub + token. |
| `tugra logout [--profile <name>]` | Forget the local token (does not revoke). |
| `tugra ctx [use <name>]` | List or switch profiles. |
| `tugra servers ls` | List enrolled servers. |
| `tugra servers reboot <id> [--at <time>] [--yes]` | Reboot a server now, or at a time (`--at` takes an ISO time, a local time like `2026-12-01 03:00`, or `+30m` / `+2h` / `+1d`). Shows what goes down, asks you to type the server name (`--yes` confirms without asking; no terminal and no `--yes` refuses). Needs `deploy`. `server` works for `servers`. |
| `tugra servers reboot-status <id>` | The server's reboot state and the last verification: which containers and domains came back and which did not. |
| `tugra servers reboot-cancel <id>` | Cancel a scheduled reboot (needs `deploy`). |
| `tugra servers oob-status <id>` | The server's cloud link and the provider-side power / rescue state. Works while the agent is offline. |
| `tugra servers oob-power <id> <on\|off\|reboot\|shutdown> [--yes]` | Power a cloud-linked server at the provider: `on`; `off` (hard, like pulling the cord); `reboot` (hard reset); `shutdown` (graceful). `off`, `reboot` and `shutdown` ask you to type the server name (`--yes` confirms without asking; no terminal and no `--yes` refuses). Needs `deploy`. |
| `tugra servers oob-rescue <id> <enable\|disable>` | Enable or disable the provider's rescue system. Enabling prints the one-time root password once (never stored); then reboot the server. Enabling needs `deploy` + `read:secrets`. |
| `tugra servers oob-console <id>` | Request a provider console session: prints the websocket URL and VNC password once (valid about a minute). Needs `deploy` + `read:secrets`. |
| `tugra servers oob-link <id> --credential <id> [--cloud-server <id>] [--confirm-name <name>]` | Link an existing server to its cloud server. With only `--credential` it lists that credential's cloud servers (and which one has this server's public IP). |
| `tugra servers oob-unlink <id>` | Remove a hand-made cloud link (a link Tugra made when it provisioned the server stays). |
| `tugra apps ls` | List applications. |
| `tugra apps deploy <id>` | Trigger a deploy (needs the `deploy` scope). |
| `tugra apps restart <id>` | Restart an app (needs `deploy`). |
| `tugra apps domain <id> <domain> [--credential <id>] [--no-www] [--overwrite] [--dry-run]` | One-click Cloudflare DNS setup for a custom domain (needs `deploy`). |
| `tugra apps logs <id> [--tail <n>]` | Fetch recent app logs. |
| `tugra db ls` | List databases. |
| `tugra backup run <dbId>` | Start a database backup (needs `deploy`). |
| `tugra api <method> <path> [--data <json>]` | Raw authenticated request to any API endpoint (e.g. `tugra api GET /apps`) — the whole REST API from the CLI. |
| `tugra version` | Show CLI + hub version, edition and protocol. |

Add `--json` to any command for raw JSON output (scriptable); omit it for a rendered table.

## Scopes

Each command needs the scope its endpoint requires (e.g. `deploy` for `apps deploy`). See the
[API scopes reference](../../docs/api.md) for the full model.

## Versioning & protocol skew

`tugra version` prints the CLI version alongside the hub's `GET /version` (version, edition, channel,
protocol) and warns if the hub speaks a different agent/CLI protocol than this CLI expects — a signal to
upgrade one side.

## License

MIT — see [LICENSE](LICENSE). Part of the Tugra project; see the [documentation](../../docs/cli.md).
