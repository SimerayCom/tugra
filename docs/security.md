# Security

An overview of Tugra's security model, with links to the authoritative details. To **report a
vulnerability**, see the [security policy](../SECURITY.md) — please don't open a public issue.

## Security model

- **Signed agent protocol.** The agent dials out to the hub over WSS (no inbound ports); the hub signs
  every command with an ed25519 key that the agent pins, and rejects anything unsigned. Each server is
  granted a capability set the agent enforces fail-closed. See [architecture](architecture.md).
- **Fail-closed secrets.** `HUB_SIGNING_KEY` is required in production (the hub won't boot without it
  outside dev/test). Stored secrets (env vars, credentials, DB connection strings) are encrypted at rest
  with `SECRETS_ENCRYPTION_KEY`.
- **API access control.** Personal access tokens are scoped; secret values are gated behind `read:secrets`.
  The instance owner can disable PAT access entirely (`apiEnabled`) or restrict it to an IP allowlist
  (`apiAllowedIps`). Details in the [API docs](api.md).
- **Two-factor auth & sessions.** TOTP 2FA with recovery codes; httpOnly session cookies with CSRF
  protection; `COOKIE_SECURE` + `HUB_TRUSTED_PROXY` for correct handling behind a TLS reverse proxy.
- **SSRF protection.** Outbound targets (notifications, registries, git sources, monitors, update checks)
  block private/loopback/link-local addresses by default; LAN targets require an explicit opt-in
  (`NOTIFY_ALLOW_PRIVATE_TARGETS`).
- **Registration gating.** After the first owner is created, sign-ups are closed unless the owner enables
  them or issues an invite.

## Self-update security

The one-click / auto self-update runs through a deliberately minimal `tugra-updater` sidecar with a fixed
command set; the hub verifies the release manifest's ed25519 signature and refuses downgrades/channel-skips
before queueing anything. The sidecar's docker-socket surface is documented in
[SECURITY.md](../SECURITY.md); the publisher/signing side (how the signed manifest is produced) is in
[Releasing](RELEASING.md).

## Editions & licensing boundary

The proprietary Pro/Cloud layer lives outside this repository; the edition is a build-time signal, not a
runtime toggle. See [Open-core & editions](open-core.md).

## Supported versions

Tugra is in early development — only the latest `main` receives security fixes. See the
[security policy](../SECURITY.md) for the current support statement.
