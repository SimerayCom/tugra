# Out-of-band cloud access (power, rescue, console)

When a server is dead (the operating system hangs, the agent is offline, SSH is gone) the Tugra agent cannot help. For a
server that runs on a cloud VM, Tugra can still act **through the cloud provider's API** with the team's stored
credential: power it on or off, hard-reset it, arm the provider's rescue system and open the provider's console.

Today this works for **Hetzner Cloud**. DigitalOcean and Vultr credentials still provision servers only.

## What you get

| Action | What the provider does | Typed server name |
|---|---|---|
| Power on | Starts the server. | no |
| Shut down | Graceful: asks the operating system to stop (ACPI). | yes |
| Hard reboot | Cuts power and starts again (the provider's `reset`). Unsaved data can be lost. | yes |
| Power off | Cuts power, like pulling the cord. Unsaved data can be lost. | yes |
| Enable rescue | Boots a minimal rescue system on the **next** boot. Returns a one-time root password. The rescue turns itself off after that boot or after 60 minutes. It does not reboot the server. | no |
| Disable rescue | The server boots from its own disk again. | no |
| Open console | The provider's VNC-over-websocket console: a one-minute address plus a VNC password. | no |

The rescue password and the console address and password are shown **once**. Tugra never stores them, never writes them
to the audit log or any log, and cannot show them again. If you lose one, enable rescue again or request a new console.

Where: the **Out-of-band access** card on the server's Maintenance tab (only shown when a cloud link exists, or to
people who can manage the server so they can create it). From a terminal: `tugra servers oob-status | oob-power |
oob-rescue | oob-console | oob-link | oob-unlink` (see the [CLI reference](../../packages/cli/README.md)). From an AI
agent through MCP: `get_server_oob`, `server_power`, `disable_server_rescue`. MCP deliberately has no rescue-enable or
console tool, because their one-time secrets must not enter a model's context.

## Who may do it

- Team permission **`servers:ops`** for every action; **`servers:manage`** to link or unlink.
- API token scope **`deploy`** for every acting route; **`deploy` + `read:secrets`** for the two routes that return a
  secret (enable rescue, console). Any member of the team can read the status.
- Every action is **audited before** the provider is called (`server.oob.power.<action>`, `server.oob.rescue.enable`,
  `server.oob.console`, ...) and a failed call adds a `.failed` entry. Link changes are audited as `server.oob.link` and
  `server.oob.unlink`.
- Shut down, hard reboot and power off need the server's exact name typed (web) or `confirmName` (API, MCP); the CLI asks
  for it, or takes `--yes`.

## How a server gets linked

A link is three things on the server: provider, the provider's server id and the cloud credential used.

- **Provisioned by Tugra** (Servers, New, Hetzner): linked automatically at provision time. Deleting such a server can
  also destroy the VM (opt-in checkbox), as before.
- **An existing server**: open its Out-of-band card, choose **Link to Hetzner**, pick the team's Hetzner credential, then
  the cloud server it runs on. Tugra reads that cloud server first and compares its public IPv4 with the server's. If
  they match, linking is one click. If they do not match, or this server's IP is not known yet (for example behind a
  floating IP), you must type the cloud server's name to confirm it is the same machine, because a wrong link would power
  off the wrong machine. Equivalent CLI: `tugra servers oob-link <id> --credential <credentialId>` lists the candidates,
  add `--cloud-server <id>` to link.
- A hand link is marked `providerManualLink`: **Tugra never destroys a VM it did not create**, so deleting the server in
  Tugra leaves the cloud VM alone. Remove a hand link with **Unlink** (`oob-unlink`). A link made at provision time cannot
  be removed.
- If the credential is later deleted, the server keeps its provider id but loses the credential: the card says so and
  offers the link again.

## The cloud API token

The token is the team's `CloudCredential`, encrypted at rest. It needs **Read & Write** on the Hetzner project. It is
decrypted for one call and dropped; it never appears in a log, an error message or an audit entry. The hub talks to
`https://api.hetzner.cloud/v1` over plain HTTPS (no SDK). Endpoints used, from Hetzner's official API reference:
`GET /servers`, `GET /servers/{id}`, and `POST /servers/{id}/actions/` `poweron`, `poweroff`, `reset`, `shutdown`,
`enable_rescue` (body `{"type":"linux64"}`), `disable_rescue`, `request_console`. Tugra's "hard reboot" is Hetzner's
`reset`; Hetzner's own `reboot` is a soft ACPI reboot and is not used.

## Errors you may see

| Message (code) | Meaning |
|---|---|
| `... rejected the stored API token` (424, `oob_credential_rejected`) | The token was revoked or lacks write access. Update it under Cloud providers. It is a 424 on purpose, never a 401 or 403, so it cannot be mistaken for a Tugra sign-in problem. |
| `another action is already running ...` (409, `oob_locked`) | The provider has the server locked by a running action. Wait a moment. |
| `the server no longer exists at ...` (409, `oob_provider_server_missing`) | The link is stale (VM deleted, or another project). Link it again. |
| `... is rate limiting requests` (429) | Hetzner allows 3600 requests per hour per project. |
| `not linked` (409, `oob_not_linked`) | Link the server first. |
| `confirmation name does not match` (400) | The typed name is not the server's exact name. |

## Limits

- Hetzner **dedicated** servers (Robot) are not covered: that API and its console flow are different.
- The console is a websocket address plus a VNC password for a VNC-over-websocket client, valid for about a minute. A
  built-in browser console is not part of this slice; the card links to the provider's own console as a fallback.
- Rescue turns itself off after one boot or 60 minutes, and the rescue password is only valid for that rescue session.
