<div align="center">

<img src="docs/assets/logo-seal.png" alt="Tugra" width="200" />

# Tugra

*Votre sceau sur chaque serveur.*

**PaaS open-core et auto-hébergeable, conçu pour les flottes de serveurs et les agents IA.**

[![GitHub stars](https://img.shields.io/github/stars/SimerayCom/tugra?style=flat&logo=github&label=stars)](https://github.com/SimerayCom/tugra/stargazers)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue)](LICENSE)
[![Release](https://img.shields.io/github/v/release/SimerayCom/tugra?sort=semver&label=release)](https://github.com/SimerayCom/tugra/releases)
[![CI](https://img.shields.io/github/actions/workflow/status/SimerayCom/tugra/ci.yml?branch=main&label=CI)](https://github.com/SimerayCom/tugra/actions/workflows/ci.yml)
[![Image: ghcr.io](https://img.shields.io/badge/image-ghcr.io%2Fsimeraycom%2Ftugra--hub-blue?logo=docker&logoColor=white)](#démarrage-rapide)

[Site web](https://tugra.io) · [Documentation](docs/README.md) · [Publication des versions](docs/RELEASING.md) · [Feuille de route](#feuille-de-route)

[English](README.md) · [Türkçe](README.tr.md) · [Español](README.es.md) · [Deutsch](README.de.md) · **Français** · [Português](README.pt.md) · [简体中文](README.zh.md) · [日本語](README.ja.md)

</div>

---

> **Statut :** bêta. En développement actif ; les API peuvent changer d'une version mineure à l'autre. Vos étoiles, vos issues et vos retours sont les bienvenus.

<div align="center">

<img src="docs/assets/screenshot-app-store.png" alt="Tugra App Store — déploiement en un clic parmi des centaines de modèles d'applications auto-hébergées" width="860" />

<img src="docs/assets/screenshot-dashboard.png" alt="Command Center — les applications, les bases de données et la flotte de chaque équipe en un coup d'œil" width="860" />

<img src="docs/assets/screenshot-app-detail.png" alt="Détail d'une application — déploiement, redémarrage, mise à l'échelle, logs et fichiers pour chaque application" width="420" />&nbsp;<img src="docs/assets/screenshot-databases.png" alt="Bases de données gérées en un clic avec volumes persistants" width="420" />

</div>

## Natif pour les agents, par défaut

Tugra embarque un serveur [MCP](https://modelcontextprotocol.io) natif : pointez Claude, Cursor ou votre propre agent vers votre infrastructure pour l'inspecter, y déployer vos applications, les mettre à l'échelle et les exploiter, avec les mêmes personal access tokens (PAT), les mêmes scopes et la même piste d'audit que l'API REST. Aucun package d'intégration à installer, et aucune valeur secrète n'est jamais renvoyée au modèle.

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

C'est le même endpoint `POST /api/v1/mcp`, avec la même authentification par personal access token, les mêmes scopes et la même liste d'adresses IP autorisées que l'API REST sous-jacente : aucun identifiant supplémentaire à gérer, et aucune valeur secrète déchiffrée n'est jamais renvoyée au modèle. Le catalogue compte **48 outils** : 26 en lecture seule (dont des vues de synthèse de toute la flotte — état, santé, liste des applications — en un seul appel, ainsi qu'un explorateur de fichiers de volumes sandboxé), et 22 outils d'écriture et d'exploitation dont les droits sont délimités par le PAT (déployer · annuler un déploiement en file d'attente · redémarrer · mettre à l'échelle à chaud · faire un rollback · définir des variables d'environnement · créer/étendre un Swarm · actions à l'échelle de la flotte sur un cluster · configuration DNS d'un domaine en un clic). Chaque outil d'écriture réutilise exactement les mêmes contrôles de permissions d'équipe et la même piste d'audit que l'API REST, et les outils irréversibles (dissoudre un Swarm, supprimer une application) exigent une confirmation explicite du nom. OAuth pour les clients tiers figure toujours sur la feuille de route.

## Qu'est-ce que Tugra ?

Tugra est un plan de contrôle open-core et auto-hébergeable pour déployer, superviser et exploiter des applications et des bases de données sur vos propres serveurs — le quotidien de Heroku, Render ou Railway, sans confier votre infrastructure au cloud d'un tiers. Il met l'accent sur la **flotte** : de véritables clusters Docker Swarm répartis sur vos serveurs (et pas seulement une gestion machine par machine), des opérations en masse à l'échelle de la flotte, et un serveur MCP intégré pour une exploitation pilotée par l'IA — le tout sous une licence que vous pouvez réellement lire.

## Pourquoi Tugra

- **Pensé pour la flotte, pas pour une machine isolée** — regroupez vos serveurs en clusters, formez un véritable Docker Swarm entre eux et exécutez une commande sur toute votre flotte en un seul appel d'opérations en masse, au lieu de vous connecter en SSH à chaque machine.
- **Natif pour les agents, aussi** — un serveur MCP intégré expose 48 outils (lecture + écriture/opérations de flotte soumises aux scopes du PAT) via `POST /api/v1/mcp`, avec les mêmes personal access tokens et les mêmes scopes que l'API REST.
- **9 moteurs de bases de données, un seul workflow** — PostgreSQL, MySQL, MariaDB, MongoDB, Redis, KeyDB, Dragonfly, ClickHouse et LibSQL, tous provisionnés de la même manière ; huit disposent de sauvegardes logiques (dump/restore) intégrées (LibSQL, qui n'a pas d'outil de dump, est couvert par les sauvegardes de volumes).
- **Du vrai TLS, de vrais certificats wildcard** — Let's Encrypt automatique pour chaque application via Traefik, plus des certificats wildcard DNS-01 (`*.yourdomain.com`) pour l'ingress en cluster/Swarm — et pas seulement du HTTP-01 pour un domaine unique.
- **Des sauvegardes hors site** — des dumps planifiés vers le disque local ou un stockage compatible S3 (S3/R2/MinIO), chiffrés, avec restauration en un clic.
- **Open-core, pas de l'open-washing** — tout ce qui précède est fourni gratuitement sous AGPL-3.0 dans *ce* dépôt. Pro/Cloud (SSO, export du journal d'audit, marque blanche, facturation multi-tenant) est un module complémentaire distinct, sous une autre licence — rien ici ne vous pousse à passer à une offre payante ni ne bride discrètement ce que vous pouvez faire. Tugra envoie des statistiques d'usage anonymes, activées par défaut — des compteurs agrégés (serveurs, applications, bases de données, déploiements) ainsi que votre version, votre édition et votre OS, sous un identifiant aléatoire ; ni noms, ni IP, ni domaines, ni secrets, et le récepteur ne stocke pas votre IP — et vous pouvez les désactiver à tout moment avec `--no-telemetry` / `TUGRA_TELEMETRY=0` ou dans Settings. La vérification des mises à jour et la détection de l'IP publique sont opt-in et désactivées par défaut.

## Tugra face aux alternatives

Une comparaison côte à côte avec les outils PaaS auto-hébergeables que l'on évalue réellement (données des concurrents vérifiées en 2026-10). `✅` intégré · `~` partiel / limité · `—` aucun équivalent intégré documenté · `🔜` sur la feuille de route de Tugra. Une erreur repérée ? [Ouvrez une issue](https://github.com/SimerayCom/tugra/issues).

| | **Tugra** | Coolify | Dokploy | Portainer | CapRover | Dokku |
|---|---|---|---|---|---|---|
| **Déploiement et build** | | | | | | |
| Tableau de bord web | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| Déploiement depuis Git | ✅ | ✅ | ✅ | ~ | ~ | ✅ |
| Déploiement Docker Compose | ✅ | ✅ | ✅ | ✅ | ~ | ~ |
| Déploiements de preview (une app par pull request) | ✅ | ✅ | ✅ | — | — | ~ |
| Rollbacks | ✅ | ✅ | ✅ | — | ✅ | ~ |
| App Store / modèles en un clic | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| **Données** | | | | | | |
| Moteurs de bases de données gérés | **9** | 8 | 6 | — | — | — |
| Sauvegardes S3 planifiées + restauration | ✅ | ✅ | ✅ | — | — | ~ |
| Sauvegardes des volumes Docker des applications | ✅ | — | ✅ | — | — | — |
| **Domaines et TLS** | | | | | | |
| Domaines personnalisés + SSL automatique | ✅ | ✅ | ✅ | — | ✅ | ✅ |
| Certificats wildcard DNS-01 | ✅ | ~ | — | — | — | ~ |
| **Flotte et haute disponibilité** | | | | | | |
| Clustering multi-nœuds | ✅ Swarm | Individuel¹ | ✅ Swarm | ✅ | ✅ | ~ k3s⁶ |
| HA Raft multi-managers + HA de l'ingress | ✅ | — | — | — | — | — |
| Opérations en masse à l'échelle de la flotte (un seul appel) | ✅ | — | — | — | — | — |
| Patching de l'OS (par serveur + flotte) | ✅ | — | — | — | — | — |
| **Observabilité** | | | | | | |
| Métriques intégrées (CPU/RAM/disque) | ✅ | ~ | ✅ | ~ | — | — |
| Supervision de disponibilité (uptime) + notifications | ✅ | ~ | ✅ | — | — | — |
| Consultation des logs d'applications / conteneurs | ✅ | ✅ | ✅ | ✅ | — | ✅ |
| **Accès et agents** | | | | | | |
| Équipes / RBAC | ✅ | ~ | ✅ | ~⁷ | — | — |
| SSO / OIDC | ✅ (Pro)⁸ | ✅ | ✅ | ~⁷ | — | — |
| Journal d'audit | ✅ | ✅ | ✅ | ~⁷ | — | — |
| MCP / pilotage par agent | ✅ 48 outils⁵ | ✅ | ✅ | — | — | ~² |
| **Confiance et licence** | | | | | | |
| Télémétrie | Anonyme, opt-out (compteurs uniquement) | n/d | n/d | n/d | n/d | n/d |
| Migration vers Tugra (import depuis Coolify) | ✅⁹ | — | — | — | — | — |
| Licence du cœur | AGPL-3.0 | Apache-2.0 | Apache-2.0³ | zlib + BE⁷ | Apache-2.0 + conditions⁴ | MIT |

<sub>¹ Coolify v4 gère les serveurs individuellement (pas de clustering intégré). ² Un projet MCP pour Dokku, tiers et à un stade précoce, et non une version officielle. ³ Le cœur de Dokploy est sous Apache-2.0 ; une licence distincte de type Source-Available couvre son répertoire `proprietary/` réservé à l'édition entreprise (SSO, journaux d'audit, marque blanche) — exactement le même modèle open-core que celui de Tugra. ⁴ Le `LICENSE` de CapRover est Apache-2.0, avec une annexe restreignant la modification et la redistribution des fonctionnalités payantes. ⁵ Tugra, Coolify et Dokploy fournissent tous des serveurs MCP dotés d'outils de lecture et d'écriture, si bien que le pilotage par agent est à parité ; Tugra y ajoute des actions à l'échelle de la flotte (un seul appel sur un cluster), la confirmation par le nom sur les outils destructeurs et le masquage des secrets. ⁶ Dokku ne prend pas en charge Docker Swarm ; son option multi-nœuds est le plugin `scheduler-k3s` (k3s/Kubernetes), une architecture différente. ⁷ Le RBAC, le SSO et les journaux d'audit de Portainer font partie de son édition Business payante. ⁸ Le cœur de Tugra est gratuit et complet (équipes/RBAC, journal d'audit, sauvegardes, supervision, MCP, migrateur, HA multi-nœuds) ; le SSO/OIDC est une fonctionnalité Pro. ⁹ Importe les applications Coolify avec leur configuration et leurs variables d'environnement sous forme de nouvelles ressources Tugra (mode copie) ; un outil d'adoption Docker local, distinct, reprend sur place les conteneurs du même hôte (en conservant leurs volumes nommés). Les **données** des bases Postgres, MySQL, MariaDB, Redis, KeyDB et Dragonfly sont migrées d'un hôte à l'autre grâce à un migrateur en une commande, à coller sur l'hôte Coolify ; les données MongoDB passent par un dump-and-restore guidé (import-from-url), les données LibSQL et celles des **volumes** d'applications par `tar`/`rsync`, et ClickHouse ne dispose pas encore d'outil de migration ([docs/coolify-migration.md](docs/coolify-migration.md)). Les noms de produits sont des marques appartenant à leurs propriétaires respectifs ; Tugra n'est ni affilié à eux ni soutenu par eux.</sub>

## Démarrage rapide

Sur un hôte Linux vierge, **une seule commande** installe les prérequis (git, Docker), clone le dépôt et démarre la stack :

```bash
curl -fsSL https://raw.githubusercontent.com/SimerayCom/tugra/main/scripts/bootstrap.sh | sh
```

<p align="center"><img src="docs/assets/install.png" alt="Installation de Tugra en une commande sur un hôte Ubuntu vierge : prérequis installés, configuration écrite, stack démarrée et en bonne santé, et code de configuration du propriétaire" width="840" /></p>

Vous préférez lire avant d'exécuter (ce qui est judicieux pour tout script auquel vous donnez un accès Docker équivalent à root) ? Clonez le dépôt et lancez vous-même le script d'installation — il se contente d'écrire un `.env` local et d'appeler `docker compose`, installe Docker s'il est absent, et est idempotent (sans risque à relancer) :

```bash
git clone https://github.com/SimerayCom/tugra.git
cd tugra
less scripts/install.sh   # review it first
./scripts/install.sh
```

Le script d'installation génère des secrets robustes dans un `.env` local (une nouvelle exécution les conserve), puis démarre le hub, l'interface web, PostgreSQL et Redis avec `docker compose`. Une fois terminé, ouvrez l'URL **Web UI** affichée (`http://<host-ip>:3001` ; l'URL de base du hub/de l'API est `http://<host-ip>:3000`) et créez le premier compte — il devient le **propriétaire** (owner) de l'instance. Lors d'une nouvelle installation, le script affiche aussi un **code de configuration** à usage unique à saisir lors de la création de ce compte (retrouvez-le avec `grep SETUP_CODE .env`). Suivez ensuite l'assistant de prise en main pour connecter votre premier serveur.

Relancer `./scripts/install.sh` (par exemple après un `git pull`) est sans danger — il conserve vos secrets et ne met à jour que la configuration, ce qui en fait aussi la procédure de mise à jour.

**Production (TLS + un domaine).** La stack expose du HTTP en clair sur les ports de cet hôte pour un démarrage rapide ; placez-la derrière votre propre reverse proxy qui termine le TLS, puis relancez le script avec votre domaine :

```bash
./scripts/install.sh --domain tugra.example.com
```

Dirigez la majeure partie du trafic vers le **service web** (`:3001`) — il relaie lui-même l'API REST et le démarrage OAuth vers le hub — et n'envoyez au **hub** (`:3000`) que les chemins que le service web ne sait pas gérer :

| Préfixe de chemin | → |
|---|---|
| `/agent`, `/terminal` (WebSocket), `/install`, `/webhooks`, `/auth/oauth` | hub `:3000` |
| tout le reste (`/`, `/api/*`) | service web `:3001` |

Remarques :

- **Le TLS n'est pas fourni** — apportez votre propre reverse proxy (Caddy, Traefik, nginx, …). `--domain` définit `COOKIE_SECURE=true` + `HUB_TRUSTED_PROXY=true` pour cette configuration.
- **Verrouillez les ports bruts.** Avec `HUB_TRUSTED_PROXY=true`, le hub prend en compte `X-Forwarded-For` ; les ports bruts `:3000`/`:3001` ne doivent donc être joignables **uniquement** par le proxy. Une nouvelle installation avec `--domain` les lie à `127.0.0.1` (proxy sur le même hôte). Si le proxy tourne sur un autre hôte, définissez `HUB_BIND`/`WEB_BIND` sur l'IP de l'interface privée de cette machine et filtrez les ports avec un pare-feu — les ports publiés par Docker contournent `ufw`.
- **« Sign in with GitHub »** ne fonctionne que dans ce déploiement à origine unique derrière un proxy (le hub et le service web partagent une origine publique afin que le cookie de session soit visible par la SPA) ; il n'est pas disponible dans le démarrage rapide simple à deux ports.

> Les images publiées (`ghcr.io/simeraycom/tugra-*`) arriveront avec la première version taguée. D'ici là, le script d'installation build automatiquement les images à partir de votre copie locale — même commande, aucune modification nécessaire.

**Démarrage rapide MCP.** Une fois Tugra lancé, créez un personal access token (**Settings → API tokens**) et pointez n'importe quel client MCP dessus :

```bash
curl -s http://<web-url>/api/v1/mcp \
  -H "Authorization: Bearer $TUGRA_PAT" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize"}'
```

## Auto-hébergé ou cloud

Tout ce qui figure dans [Pourquoi Tugra](#pourquoi-tugra) ci-dessus est **gratuit et open source pour toujours**, sous AGPL-3.0, auto-hébergé sur vos propres serveurs — aucun plafond artificiel, aucun feature flag prêt à être activé contre paiement. L'édition Community de ce dépôt est le vrai produit, pas une démo bridée.

Les éditions Pro et Cloud (SSO, export du journal d'audit, marque blanche, plan de contrôle managé) sont proposées sous une licence commerciale distincte. Pour une licence non AGPL ou pour tout ce que l'édition Community ne sait pas faire, contactez **license@tugra.io**.

## Architecture

| Composant | Stack |
|---|---|
| Hub (API + cerveau) | NestJS · PostgreSQL (Prisma) · Redis / BullMQ |
| Service web (interface) | Next.js |
| Agent | Go (binaire unique, par serveur) |
| Proxy | Traefik (SSL automatique, y compris wildcard DNS-01) |

Les logs en direct, les métriques et le terminal sont diffusés en streaming via WebSockets. Description détaillée dans [docs/architecture.md](docs/architecture.md).

## Feuille de route

**Livré**

- [x] Protocole Hub ↔ Agent + enrôlement des serveurs (WSS sortant · ed25519 · commandes signées + périmètre de capacités)
- [x] Déploiement depuis Git / Docker Compose / image (Nixpacks · Dockerfile · site statique)
- [x] Reverse proxy + SSL automatique (Traefik · Let's Encrypt, y compris wildcard DNS-01)
- [x] Métriques en direct, logs de build et terminal web (flux WebSocket)
- [x] Bases de données (9 moteurs) avec sauvegardes et restauration (local + hors site S3/R2)
- [x] Clusters multi-serveurs + création de Docker Swarm, opérations en masse sur toute la flotte
- [x] Serveur MCP natif — 48 outils (lecture + écriture/opérations de flotte soumises aux scopes du PAT) + prompts guidés
- [x] App Store — catalogue de modèles en un clic + lanceur en mode Home
- [x] Explorateur de fichiers en lecture seule pour les volumes d'applications (interface web + MCP `list_files`)
- [x] Déploiements de preview (une app par pull request)
- [x] Supervision de disponibilité (HTTP/TCP/métrique) + canaux de notification
- [x] Tâches planifiées (cron) · rollbacks · limites de ressources et health checks
- [x] Projets / environnements · équipes, rôles et invitations · tags · variables partagées
- [x] API publique (OpenAPI) + CLI (`tugra`)
- [x] Patching des serveurs (mises à jour des paquets de l'OS)
- [x] Self-update (versions signées) + prise en main guidée
- [x] Migrateur — adoption de conteneurs Docker locaux + import depuis Coolify (connect · plan · apply · rollback) + migration des données de bases entre hôtes en une commande (Postgres · MySQL · MariaDB · Redis · KeyDB · Dragonfly)

**Prochainement**

- [ ] OAuth MCP pour les clients tiers (enregistrement dynamique des clients, PKCE)
- [ ] Gestionnaire de fichiers — prise en charge de l'écriture (upload / renommage / suppression)
- [ ] Migration en un clic des données ClickHouse et MongoDB, ainsi que des données de volumes d'applications
- [ ] Davantage de sources de migration (Dokploy, CapRover)
- [ ] Application mobile

## Communauté et documentation

- [Documentation complète](docs/README.md) — installation, architecture, API, CLI, sécurité, open-core
- [Issues](https://github.com/SimerayCom/tugra/issues) — rapports de bugs et demandes de fonctionnalités
- [Discussions](https://github.com/SimerayCom/tugra/discussions) — questions, idées, présentations de projets
- [Contribuer](CONTRIBUTING.md) · [Code de conduite](CODE_OF_CONDUCT.md) · [CLA](CLA.md)
- [Politique de sécurité](SECURITY.md)

## Contributeurs

<a href="https://github.com/SimerayCom/tugra/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=SimerayCom/tugra" alt="Contributeurs" />
</a>

## Sponsors

Tugra est développé et maintenu en toute transparence. S'il vous est utile, à vous ou à votre équipe, pensez à [sponsoriser le projet sur GitHub](https://github.com/sponsors/mrcandev) — il n'y a pas encore de palier de sponsoring, vous seriez donc le premier, et chaque contribution aide à préserver l'indépendance du développement.

## Historique des étoiles

[![Star History Chart](https://api.star-history.com/svg?repos=SimerayCom/tugra&type=Date)](https://star-history.com/#SimerayCom/tugra&Date)

## Licence

Tugra repose sur un modèle **open-core** :

- **Cœur** (ce dépôt) — [GNU AGPLv3](LICENSE). Libre d'utilisation, d'auto-hébergement, d'étude et de modification. Si vous exécutez une version modifiée comme service réseau, vous devez partager vos modifications sous la même licence.
- **Agent et CLI** — [MIT](agent/LICENSE). Utilisez-les où vous voulez, sans condition.
- **Tugra Cloud et fonctionnalités Pro** — propriétaires, pas encore publiées (voir [Auto-hébergé ou cloud](#auto-hébergé-ou-cloud)).

**Licence commerciale :** si vous ne pouvez pas vous conformer à l'AGPLv3 (par exemple si vous voulez développer une offre propriétaire ou SaaS au-dessus de Tugra), une licence commerciale est disponible. Contactez **license@tugra.io**. Description détaillée dans [docs/open-core.md](docs/open-core.md).

---

<div align="center"><sub>AGPL-3.0 © Simeray Ltd — voir <a href="LICENSE">LICENSE</a>.</sub></div>
