<div align="center">

<img src="docs/assets/logo-seal.png" alt="Tugra" width="200" />

# Tugra

*Dein Siegel auf jedem Server.*

**Open-Core-PaaS zum Selbsthosten, gebaut für Flotten und KI-Agenten.**

[![GitHub stars](https://img.shields.io/github/stars/SimerayCom/tugra?style=flat&logo=github&label=stars)](https://github.com/SimerayCom/tugra/stargazers)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue)](LICENSE)
[![Release](https://img.shields.io/github/v/release/SimerayCom/tugra?sort=semver&label=release)](https://github.com/SimerayCom/tugra/releases)
[![CI](https://img.shields.io/github/actions/workflow/status/SimerayCom/tugra/ci.yml?branch=main&label=CI)](https://github.com/SimerayCom/tugra/actions/workflows/ci.yml)
[![Image: ghcr.io](https://img.shields.io/badge/image-ghcr.io%2Fsimeraycom%2Ftugra--hub-blue?logo=docker&logoColor=white)](#schnellstart)

[Website](https://tugra.io) · [Dokumentation](docs/README.md) · [Releases veröffentlichen](docs/RELEASING.md) · [Roadmap](#roadmap)

[English](README.md) · [Türkçe](README.tr.md) · [Español](README.es.md) · **Deutsch** · [Français](README.fr.md) · [Português](README.pt.md) · [简体中文](README.zh.md) · [日本語](README.ja.md)

</div>

---

> **Status:** Beta. In aktiver Entwicklung; APIs können sich zwischen Minor-Releases ändern. Sterne, Issues und Feedback sind herzlich willkommen.

<div align="center">

<img src="docs/assets/screenshot-app-store.png" alt="Tugra App Store — Ein-Klick-Deployment aus Hunderten von Vorlagen für selbst gehostete Apps" width="860" />

<img src="docs/assets/screenshot-dashboard.png" alt="Command Center — Apps, Datenbanken und Flotte aller Teams auf einen Blick" width="860" />

<img src="docs/assets/screenshot-app-detail.png" alt="App-Details — Deployen, Neustarten, Skalieren, Logs und Dateien pro App" width="420" />&nbsp;<img src="docs/assets/screenshot-databases.png" alt="Verwaltete Datenbanken per Ein-Klick mit persistenten Volumes" width="420" />

</div>

## Standardmäßig agentennativ

Tugra liefert einen nativen [MCP](https://modelcontextprotocol.io)-Server mit — richte Claude, Cursor oder deinen eigenen Agenten auf deine Infrastruktur, damit er sie einsehen, deployen, skalieren und betreiben kann, mit denselben Personal-Access-Tokens, Scopes und demselben Audit-Trail wie die REST API. Kein separates Integrationspaket, und es werden dem Modell nie Secret-Werte zurückgegeben.

```bash
# List every tool the server exposes
curl -s https://your-tugra-host/api/v1/mcp \
  -H "Authorization: Bearer $TUGRA_PAT" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'

# Ask it something real: what's actually deployed right now?
curl -s https://your-tugra-host/api/v1/mcp \
  -H "Authorization: Bearer $TUGRA_PAT" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"list_applications","arguments":{}}}'
```

Es ist derselbe `POST /api/v1/mcp`-Endpunkt mit derselben Personal-Access-Token-Authentifizierung, denselben Scopes und derselben IP-Allowlist wie bei der darunterliegenden REST API — es gibt keine separaten Zugangsdaten zu verwalten, und entschlüsselte Secret-Werte werden dem Modell nie zurückgegeben. Der Katalog umfasst **48 Tools**: 26 schreibgeschützte (darunter Flotten-Status-, Health- und App-Listen-Zusammenfassungen mit einem Aufruf sowie ein Datei-Browser für Volumes in einer Sandbox) plus 22 PAT-gebundene Mutations-/Ops-Tools (deployen · einen eingereihten Deploy abbrechen · neu starten · live skalieren · zurückrollen · Env setzen · einen Swarm bilden/erweitern · flottenweite Aktionen über einen Cluster · DNS-Einrichtung für Domains mit einem Klick). Jedes Mutations-Tool verwendet exakt dieselben Team-Berechtigungsprüfungen und denselben Audit-Trail wie die REST API, und die unumkehrbaren Aktionen (einen Swarm auflösen, eine App entfernen) erfordern eine ausdrückliche Bestätigung per Namenseingabe. OAuth für Drittanbieter-Clients steht noch auf der Roadmap.

## Was ist Tugra?

Tugra ist eine selbst hostbare Open-Core-Steuerungsebene zum Deployen, Überwachen und Betreiben von Apps und Datenbanken auf deinen eigenen Servern — der Alltag von Heroku, Render oder Railway, ohne deine Infrastruktur der Cloud eines anderen zu überlassen. Der Schwerpunkt liegt auf der **Flotte**: echte Docker-Swarm-Cluster über deine Server hinweg (nicht nur die Verwaltung einer Maschine nach der anderen), flottenweite Bulk-Operationen und ein integrierter MCP-Server für KI-gesteuerten Betrieb — alles unter einer Lizenz, die du tatsächlich lesen kannst.

## Warum Tugra

- **Flotte zuerst, nicht Einzelmaschine** — fasse Server zu Clustern zusammen, bilde darüber einen echten Docker Swarm und führe mit einem einzigen Bulk-Ops-Aufruf einen Befehl auf deiner gesamten Flotte aus, statt dich auf jeder Maschine einzeln per SSH einzuloggen.
- **Auch agentennativ** — ein integrierter MCP-Server stellt 48 Tools bereit (lesen + PAT-gebundene Mutations-/Flotten-Ops) über `POST /api/v1/mcp`, abgesichert durch dieselben Personal-Access-Tokens wie die REST API.
- **9 Datenbank-Engines, ein Workflow** — PostgreSQL, MySQL, MariaDB, MongoDB, Redis, KeyDB, Dragonfly, ClickHouse und LibSQL, alle auf dieselbe Weise bereitgestellt; acht davon haben integrierte logische Dump-/Restore-Backups (LibSQL, das kein Dump-Tool hat, wird durch die Volume-Backups abgedeckt).
- **Echtes TLS, echte Wildcards** — automatisches Let's Encrypt pro App über Traefik, dazu DNS-01-Wildcard-Zertifikate (`*.yourdomain.com`) für Cluster-/Swarm-Ingress — nicht nur HTTP-01 für einzelne Domains.
- **Backups, die das Haus verlassen** — geplante Dumps auf lokale Festplatte oder S3-kompatiblen Speicher (S3/R2/MinIO), verschlüsselt, mit Wiederherstellung per Klick.
- **Open-Core, nicht Open-Washing** — alles oben Genannte wird kostenlos unter AGPL-3.0 in *diesem* Repository ausgeliefert. Pro/Cloud (SSO, Audit-Log-Export, Whitelabel, mandantenfähige Abrechnung) ist ein separat lizenziertes Add-on — nichts hier drängt dich zum Upgrade oder beschränkt heimlich, was du tun kannst. Tugra sendet anonyme Nutzungsstatistiken, standardmäßig aktiviert — aggregierte Zähler (Server, Apps, Datenbanken, Deploys) plus deine Version, Edition und dein Betriebssystem, unter einer zufälligen ID; keine Namen, IPs, Domains oder Secrets, und der Empfänger speichert deine IP nicht — und du kannst sie jederzeit mit `--no-telemetry` / `TUGRA_TELEMETRY=0` oder in den Einstellungen abschalten. Update-Prüfungen und die Erkennung der öffentlichen IP sind Opt-in und standardmäßig deaktiviert.

## Wie sich Tugra im Vergleich schlägt

Ein direkter Vergleich mit den selbst hostbaren PaaS-Tools, die Leute tatsächlich evaluieren (Konkurrenzdaten geprüft 2026-10). `✅` integriert · `~` teilweise / eingeschränkt · `—` kein dokumentiertes integriertes Äquivalent · `🔜` auf Tugras Roadmap. Einen Fehler entdeckt? [Eröffne ein Issue](https://github.com/SimerayCom/tugra/issues).

| | **Tugra** | Coolify | Dokploy | Portainer | CapRover | Dokku |
|---|---|---|---|---|---|---|
| **Deployment & Build** | | | | | | |
| Web-UI-Dashboard | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| Deployment aus Git | ✅ | ✅ | ✅ | ~ | ~ | ✅ |
| Docker-Compose-Deployment | ✅ | ✅ | ✅ | ✅ | ~ | ~ |
| Preview-Deployments (PR-Apps) | ✅ | ✅ | ✅ | — | — | ~ |
| Rollbacks | ✅ | ✅ | ✅ | — | ✅ | ~ |
| App Store / Ein-Klick-Vorlagen | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| **Daten** | | | | | | |
| Verwaltete Datenbank-Engines | **9** | 8 | 6 | — | — | — |
| Geplante S3-Backups + Wiederherstellung | ✅ | ✅ | ✅ | — | — | ~ |
| Docker-Volume-Backups für Apps | ✅ | — | ✅ | — | — | — |
| **Domains & TLS** | | | | | | |
| Eigene Domains + automatisches SSL | ✅ | ✅ | ✅ | — | ✅ | ✅ |
| DNS-01-Wildcard-Zertifikate | ✅ | ~ | — | — | — | ~ |
| **Flotte & HA** | | | | | | |
| Multi-Node-Clustering | ✅ Swarm | Einzeln¹ | ✅ Swarm | ✅ | ✅ | ~ k3s⁶ |
| Multi-Manager-Raft-HA + Ingress-HA | ✅ | — | — | — | — | — |
| Flottenweite Bulk-Operationen (ein Aufruf) | ✅ | — | — | — | — | — |
| OS-Patching (pro Server + Flotte) | ✅ | — | — | — | — | — |
| **Observability** | | | | | | |
| Integrierte Metriken (CPU/RAM/Festplatte) | ✅ | ~ | ✅ | ~ | — | — |
| Uptime-Monitore + Benachrichtigungen | ✅ | ~ | ✅ | — | — | — |
| App-/Container-Log-Viewer | ✅ | ✅ | ✅ | ✅ | — | ✅ |
| **Zugriff & Agent** | | | | | | |
| Teams / RBAC | ✅ | ~ | ✅ | ~⁷ | — | — |
| SSO / OIDC | ✅ (Pro)⁸ | ✅ | ✅ | ~⁷ | — | — |
| Audit-Log | ✅ | ✅ | ✅ | ~⁷ | — | — |
| MCP / Agentensteuerung | ✅ 48 Tools⁵ | ✅ | ✅ | — | — | ~² |
| **Vertrauen & Lizenz** | | | | | | |
| Telemetrie | Anonym, Opt-out (nur Zähler) | k. A. | k. A. | k. A. | k. A. | k. A. |
| Einwanderung (Import aus Coolify) | ✅⁹ | — | — | — | — | — |
| Kernlizenz | AGPL-3.0 | Apache-2.0 | Apache-2.0³ | zlib + BE⁷ | Apache-2.0 + Bedingungen⁴ | MIT |

<sub>¹ Coolify v4 verwaltet Server einzeln (kein integriertes Clustering). ² Ein früher Dokku-MCP-Ansatz eines Drittanbieters, kein offizielles Release. ³ Der Kern von Dokploy steht unter Apache-2.0; eine separate Source-Available-Lizenz deckt das Enterprise-Verzeichnis `proprietary/` ab (SSO, Audit-Logs, Whitelabel) — dieselbe Open-Core-Form, die auch Tugra verwendet. ⁴ Die `LICENSE` von CapRover ist Apache-2.0 mit einem Anhang, der die Änderung/Weiterverbreitung kostenpflichtiger Funktionen einschränkt. ⁵ Tugra, Coolify und Dokploy liefern alle MCP-Server mit Lese- und Schreib-Tools aus, die Agentensteuerung ist also gleichauf; Tugra ergänzt flottenweite Aktionen (ein Aufruf über einen Cluster), Namensbestätigung bei destruktiven Tools und Secret-Schwärzung. ⁶ Dokku unterstützt Docker Swarm nicht; seine Multi-Node-Option ist das Plugin `scheduler-k3s` (k3s/Kubernetes), eine andere Architektur. ⁷ RBAC, SSO und Audit-Logs von Portainer sind Teil der kostenpflichtigen Business Edition. ⁸ Tugras Kern ist kostenlos und voll funktionsfähig (Teams/RBAC, Audit-Log, Backups, Monitoring, MCP, Migrator, Multi-Node-HA); SSO/OIDC ist ein Pro-Feature. ⁹ Importiert Coolify-Apps samt Konfiguration/Env als neue Tugra-Ressourcen (Copy-Modus); ein separater lokaler Docker-Adopter übernimmt Container auf demselben Host an Ort und Stelle (unter Beibehaltung ihrer benannten Volumes). Die Datenbank-**Daten** von Postgres, MySQL, MariaDB, Redis, KeyDB und Dragonfly wandern hostübergreifend mit einem Ein-Befehl-Migrator, den du auf dem Coolify-Host einfügst; MongoDB-Daten wandern per geführtem Dump-und-Restore (import-from-url), LibSQL- und App-**Volume**-Daten per `tar`/`rsync`, und für ClickHouse gibt es noch kein Migrationstool ([docs/coolify-migration.md](docs/coolify-migration.md)). Produktnamen sind Marken ihrer jeweiligen Inhaber; Tugra ist weder mit ihnen verbunden noch von ihnen unterstützt.</sub>

## Schnellstart

Auf einem frischen Linux-Host installiert **ein Befehl** die Voraussetzungen (git, Docker), klont das Repo und fährt den Stack hoch:

```bash
curl -fsSL https://raw.githubusercontent.com/SimerayCom/tugra/main/scripts/bootstrap.sh | sh
```

<p align="center"><img src="docs/assets/install.png" alt="Tugra-Installation mit einem Befehl auf einem frischen Ubuntu-Host: Voraussetzungen installiert, Konfiguration geschrieben, der Stack startet fehlerfrei, und der Setup-Code für den Owner" width="840" /></p>

Du möchtest lesen, bevor du ausführst (sinnvoll bei jedem Skript, dem du quasi Root-Zugriff auf Docker gibst)? Klone das Repo und führe den Installer selbst aus — er schreibt nur eine lokale `.env`, ruft `docker compose` auf, installiert Docker, falls es fehlt, und ist idempotent (sicher wiederholbar):

```bash
git clone https://github.com/SimerayCom/tugra.git
cd tugra
less scripts/install.sh   # review it first
./scripts/install.sh
```

Der Installer erzeugt starke Secrets in einer lokalen `.env` (bei erneutem Ausführen bleiben sie erhalten) und startet dann Hub, Web-UI, PostgreSQL und Redis mit `docker compose`. Wenn er fertig ist, öffne die ausgegebene **Web-UI**-URL (`http://<host-ip>:3001`; die Hub-/API-Basis ist `http://<host-ip>:3000`) und lege das erste Konto an — es wird zum **Owner** der Instanz. Bei einer frischen Installation gibt der Installer außerdem einen einmaligen **Setup-Code** aus, der beim Anlegen dieses Kontos einzugeben ist (mit `grep SETUP_CODE .env` kannst du ihn wiederfinden). Folge anschließend dem Onboarding-Assistenten, um deinen ersten Server zu verbinden.

Das erneute Ausführen von `./scripts/install.sh` (z. B. nach `git pull`) ist sicher — es behält deine Secrets und aktualisiert nur die Konfiguration und dient somit zugleich als Upgrade-Pfad.

**Produktion (TLS + eine Domain).** Der Stack liefert zum schnellen Start reines HTTP auf den Ports dieses Hosts; stelle ihn hinter deinen eigenen Reverse Proxy, der TLS terminiert, und führe das Skript erneut mit deiner Domain aus:

```bash
./scripts/install.sh --domain tugra.example.com
```

Leite den Großteil des Traffics an das **Web** (`:3001`) — es leitet die REST API und den OAuth-Start für dich an den Hub weiter — und schicke nur die Pfade, die das Web nicht verarbeiten kann, an den **Hub** (`:3000`):

| Pfadpräfix | → |
|---|---|
| `/agent`, `/terminal` (WebSocket), `/install`, `/webhooks`, `/auth/oauth` | Hub `:3000` |
| alles andere (`/`, `/api/*`) | Web `:3001` |

Hinweise:

- **TLS ist nicht enthalten** — bring deinen eigenen Reverse Proxy mit (Caddy, Traefik, nginx, …). `--domain` setzt für dieses Setup `COOKIE_SECURE=true` + `HUB_TRUSTED_PROXY=true`.
- **Sperre die rohen Ports ab.** Mit `HUB_TRUSTED_PROXY=true` beachtet der Hub `X-Forwarded-For`, daher dürfen die rohen Ports `:3000`/`:3001` **nur** den Proxy erreichen. Eine frische `--domain`-Installation bindet sie an `127.0.0.1` (Proxy auf demselben Host). Läuft der Proxy auf einem anderen Host, setze `HUB_BIND`/`WEB_BIND` auf die IP der privaten Schnittstelle dieser Maschine und schütze die Ports per Firewall — von Docker veröffentlichte Ports umgehen `ufw`.
- **„Sign in with GitHub"** funktioniert nur in diesem Single-Origin-Proxy-Deployment (Hub und Web teilen sich einen öffentlichen Origin, damit das Session-Cookie für die SPA sichtbar ist); im einfachen Schnellstart mit zwei Ports ist es nicht verfügbar.

> Veröffentlichte Images (`ghcr.io/simeraycom/tugra-*`) erscheinen mit dem ersten getaggten Release. Bis dahin baut der Installer automatisch aus deinem Checkout — derselbe Befehl, keine Änderungen nötig.

**MCP-Schnellstart.** Sobald Tugra läuft, erzeuge ein Personal Access Token (**Settings → API tokens**) und richte einen beliebigen MCP-Client darauf:

```bash
curl -s http://<web-url>/api/v1/mcp \
  -H "Authorization: Bearer $TUGRA_PAT" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize"}'
```

## Selbst gehostet vs. Cloud

Alles unter [Warum Tugra](#warum-tugra) oben ist **für immer kostenlos und Open Source**, unter AGPL-3.0, selbst gehostet auf deinen eigenen Servern — keine künstliche Obergrenze, kein Feature-Flag, das darauf wartet, gegen Geld umgelegt zu werden. Die Community Edition in diesem Repository ist das echte Produkt, keine verkrüppelte Demo.

Die Editionen Pro und Cloud (SSO, Audit-Log-Export, Whitelabel, verwaltete Steuerungsebene) werden unter einer separaten kommerziellen Lizenz angeboten. Für eine Nicht-AGPL-Lizenz oder etwas, das Community nicht kann, kontaktiere **license@tugra.io**.

## Architektur

| Komponente | Stack |
|---|---|
| Hub (API + Gehirn) | NestJS · PostgreSQL (Prisma) · Redis / BullMQ |
| Web | Next.js |
| Agent | Go (einzelnes Binary, pro Server) |
| Proxy | Traefik (automatisches SSL, inkl. DNS-01-Wildcard) |

Live-Logs, Metriken und das Terminal werden über WebSockets gestreamt. Die vollständige Aufschlüsselung findest du in [docs/architecture.md](docs/architecture.md).

## Roadmap

**Ausgeliefert**

- [x] Hub ↔ Agent-Protokoll + Server-Registrierung (ausgehendes WSS · ed25519 · signierte Befehle + Capability-Scope)
- [x] Deployment aus Git / Docker Compose / Image (Nixpacks · Dockerfile · statische Website)
- [x] Reverse Proxy + automatisches SSL (Traefik · Let's Encrypt, inkl. DNS-01-Wildcard)
- [x] Live-Metriken, Build-Logs & Web-Terminal (WebSocket-Streams)
- [x] Datenbanken (9 Engines) mit Backups & Wiederherstellung (lokal + S3/R2 extern)
- [x] Multi-Server-Cluster + Docker-Swarm-Bildung, Bulk-Operationen über die Flotte
- [x] Nativer MCP-Server — 48 Tools (lesen + PAT-gebundene Mutations-/Flotten-Ops) + geführte Prompts
- [x] App Store — Ein-Klick-Vorlagenkatalog + Home-Mode-Launcher
- [x] Schreibgeschützter Datei-Browser für App-Volumes (Web-UI + MCP `list_files`)
- [x] Preview-Deployments (pro Pull Request)
- [x] Uptime-Monitoring (HTTP/TCP/Metrik) + Benachrichtigungskanäle
- [x] Geplante Aufgaben (Cron) · Rollbacks · Ressourcenlimits & Health-Checks
- [x] Projekte / Umgebungen · Teams, Rollen & Einladungen · Tags · gemeinsame Variablen
- [x] Öffentliche API (OpenAPI) + CLI (`tugra`)
- [x] Server-Patching (OS-Paket-Updates)
- [x] Selbst-Update (signierte Releases) + geführtes Onboarding
- [x] Migrator — lokale Docker-Container übernehmen + Import aus Coolify (verbinden · planen · anwenden · zurückrollen) + hostübergreifende DB-Datenmigration mit einem Befehl (Postgres · MySQL · MariaDB · Redis · KeyDB · Dragonfly)

**Als Nächstes**

- [ ] MCP-OAuth für Drittanbieter-Clients (dynamische Client-Registrierung, PKCE)
- [ ] Dateimanager — Schreibunterstützung (Hochladen / Umbenennen / Löschen)
- [ ] Ein-Klick-Migration für ClickHouse- und MongoDB-Daten sowie App-Volume-Daten
- [ ] Weitere Migrationsquellen (Dokploy, CapRover)
- [ ] Mobile App

## Community & Dokumentation

- [Vollständige Dokumentation](docs/README.md) — Installation, Architektur, API, CLI, Sicherheit, Open-Core
- [Issues](https://github.com/SimerayCom/tugra/issues) — Fehlerberichte & Feature-Wünsche
- [Discussions](https://github.com/SimerayCom/tugra/discussions) — Fragen, Ideen, Show-and-Tell
- [Mitwirken](CONTRIBUTING.md) · [Verhaltenskodex](CODE_OF_CONDUCT.md) · [CLA](CLA.md)
- [Sicherheitsrichtlinie](SECURITY.md)

## Mitwirkende

<a href="https://github.com/SimerayCom/tugra/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=SimerayCom/tugra" alt="Mitwirkende" />
</a>

## Sponsoren

Tugra wird offen entwickelt und gepflegt. Wenn es dir oder deinem Team nützt, ziehe in Betracht, [das Projekt auf GitHub zu sponsern](https://github.com/sponsors/mrcandev) — es gibt noch keine Sponsoren-Stufe, du wärst also der Erste, und jeder Beitrag hilft, die Entwicklung unabhängig zu halten.

## Star-Verlauf

[![Star History Chart](https://api.star-history.com/svg?repos=SimerayCom/tugra&type=Date)](https://star-history.com/#SimerayCom/tugra&Date)

## Lizenz

Tugra verwendet ein **Open-Core**-Modell:

- **Core** (dieses Repository) — [GNU AGPLv3](LICENSE). Frei nutzbar, selbst hostbar, einsehbar und veränderbar. Wenn du eine modifizierte Version als Netzwerkdienst betreibst, musst du deine Änderungen unter derselben Lizenz teilen.
- **Agent & CLI** — [MIT](agent/LICENSE). Nutze sie überall, ohne Bedingungen.
- **Tugra Cloud & Pro-Features** — proprietär, noch nicht veröffentlicht (siehe [Selbst gehostet vs. Cloud](#selbst-gehostet-vs-cloud)).

**Kommerzielle Lizenz:** Wenn du die AGPLv3 nicht einhalten kannst (z. B. weil du ein proprietäres Angebot oder ein SaaS-Angebot auf Basis von Tugra aufbauen möchtest), ist eine kommerzielle Lizenz erhältlich. Kontaktiere **license@tugra.io**. Die vollständige Aufschlüsselung findest du in [docs/open-core.md](docs/open-core.md).

---

<div align="center"><sub>AGPL-3.0 © Simeray Ltd — siehe <a href="LICENSE">LICENSE</a>.</sub></div>
