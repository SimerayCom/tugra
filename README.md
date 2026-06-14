<div align="center">

<img src="docs/assets/logo-seal.png" alt="Tugra" width="120" />

# Tugra

**Your seal on every server.**

Self-hostable platform to deploy, monitor, back up & orchestrate your servers — one premium control plane. A Coolify / Dokploy / CasaOS alternative, from a Raspberry Pi to a fleet.

[Website](https://tugra.io) · [Docs](https://tugra.io/docs) · [Roadmap](#roadmap)

</div>

---

> **Status:** Early development. Things will change fast and break often. Stars and feedback are welcome — production use is not recommended yet.

## What is Tugra?

Tugra is a single control plane for your servers. Connect a machine — a $50 Raspberry Pi or a rack of bare-metal — and deploy apps, watch live metrics and logs, take backups, and manage the whole fleet from one place.

Two modes, one platform:

- **Pro / PaaS mode** — deploy from Git, Docker Compose, or images; reverse proxy + automatic SSL; databases; live logs and a web terminal. The Coolify/Dokploy experience, with better polish.
- **Home mode** — a friendly self-host OS with a one-click app store, like CasaOS, for homelabbers and beginners.

## Why Tugra?

- **One pane of glass** — deploy, monitor, back up and orchestrate without stitching five tools together.
- **Lightweight agent** — a single Go binary on each server. No heavy footprint.
- **Premium, calm UI** — built to be a joy to use, dark-first, WCAG AA.
- **Yours** — self-hosted by default; your data stays on your machines.

## Architecture

| Component | Stack |
|---|---|
| Hub (API + brain) | NestJS · PostgreSQL (Prisma) · Redis / BullMQ |
| Web | Next.js |
| Agent | Go (single binary, per server) |
| Mobile | Flutter |
| Proxy | Traefik (automatic SSL) |

Live logs, metrics and the terminal stream over WebSockets.

## Roadmap

- [ ] Hub ↔ Agent protocol + server enrollment
- [ ] Deploy from Git / Compose / image
- [ ] Reverse proxy + automatic SSL
- [ ] Live metrics, logs, web terminal
- [ ] Backups & restore
- [ ] App store (Home mode)
- [ ] Mobile app
- [ ] Migrator (import from Coolify / Dokploy)

## License

Tugra uses an **open-core** model:

- **Core** (this repository) — [GNU AGPLv3](LICENSE). Free to use, self-host, study and modify. If you run a modified version as a network service, you must share your changes under the same license.
- **Agent & CLI** — [MIT](agent/LICENSE). Use them anywhere, no strings attached.
- **Tugra Cloud & Pro features** — proprietary, hosted and maintained by us.

**Commercial license:** If you cannot comply with the AGPLv3 (e.g. you want to build a proprietary or SaaS offering on top of Tugra), a commercial license is available. Contact **license@tugra.io**.

## Contributing

Contributions are welcome — please read [CONTRIBUTING.md](CONTRIBUTING.md) first. All contributors must sign the [CLA](CLA.md) so the project can be dual-licensed.

## Security

Found a vulnerability? Please **do not** open a public issue — see [SECURITY.md](SECURITY.md).
