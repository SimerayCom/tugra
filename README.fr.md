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

> **Statut :** bêta. En développement actif ; les API peuvent changer entre deux versions mineures. Les étoiles, les tickets et les retours sont les bienvenus.

<div align="center">

<img src="docs/assets/screenshot-app-store.png" alt="Tugra App Store — déploiement en un clic parmi des centaines de modèles d'applications auto-hébergées" width="860" />

<img src="docs/assets/screenshot-dashboard.png" alt="Centre de commande — les applications, bases de données et la flotte de chaque équipe en un coup d'œil" width="860" />

<img src="docs/assets/screenshot-app-detail.png" alt="Détail d'une application — déploiement, redémarrage, mise à l'échelle, journaux et fichiers pour chaque application" width="420" />&nbsp;<img src="docs/assets/screenshot-databases.png" alt="Bases de données gérées en un clic avec volumes persistants" width="420" />

</div>

## Natif pour les agents, par défaut

Tugra embarque un serveur [MCP](https://modelcontextprotocol.io) natif — pointez Claude, Cursor ou votre propre agent vers votre infrastructure pour l'inspecter, y déployer, la mettre à l'échelle et l'exploiter, avec les mêmes personal-access tokens, les mêmes portées et la même piste d'audit que l'API REST. Aucun paquet d'intégration séparé, et aucune valeur secrète n'est jamais renvoyée au modèle.

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

C'est le même point d'accès `POST /api/v1/mcp`, avec la même authentification par personal-access token, les mêmes portées et la même liste d'adresses IP autorisées que l'API REST sous-jacente — aucun identifiant supplémentaire à gérer, et aucune valeur secrète déchiffrée n'est jamais renvoyée au modèle. Le catalogue compte **48 outils** : 26 en lecture seule (dont des synthèses d'état, de santé et de liste d'applications de toute la flotte en un seul appel, ainsi qu'un explorateur de fichiers de volumes en bac à sable), plus 22 outils de modification et d'exploitation limités par PAT (déployer · annuler un déploiement en file d'attente · redémarrer · mettre à l'échelle en direct · revenir en arrière · définir des variables d'environnement · former/étendre un swarm · actions à l'échelle de la flotte sur un cluster · configuration DNS d'un domaine en un clic). Chaque outil de modification réutilise exactement les mêmes contrôles de permissions d'équipe et la même piste d'audit que l'API REST, et les outils irréversibles (dissoudre un swarm, supprimer une application) exigent une confirmation explicite par le nom. OAuth pour les clients tiers figure toujours dans la feuille de route.

## Qu'est-ce que Tugra ?

Tugra est un plan de contrôle open-core et auto-hébergeable pour déployer, superviser et exploiter des applications et des bases de données sur vos propres serveurs — le quotidien de Heroku, Render ou Railway, sans confier votre infrastructure au cloud de quelqu'un d'autre. Il met l'accent sur la **flotte** : de véritables clusters Docker Swarm répartis sur vos serveurs (et pas seulement une gestion machine par machine), des opérations groupées à l'échelle de la flotte, et un serveur MCP intégré pour une exploitation pilotée par l'IA — le tout sous une licence que vous pouvez réellement lire.

## Pourquoi Tugra

- **La flotte d'abord, pas la machine isolée** — regroupez vos serveurs en clusters, formez un véritable Docker Swarm entre eux et exécutez une commande sur toute votre flotte en un seul appel d'opérations groupées, au lieu de vous connecter en SSH à chaque machine.
- **Aussi natif pour les agents** — un serveur MCP intégré expose 48 outils (lecture + modification/opérations de flotte limitées par PAT) via `POST /api/v1/mcp`, avec les mêmes personal-access tokens et les mêmes portées que l'API REST.
- **9 moteurs de bases de données, un seul flux de travail** — PostgreSQL, MySQL, MariaDB, MongoDB, Redis, KeyDB, Dragonfly, ClickHouse et LibSQL, tous provisionnés de la même manière ; huit disposent de sauvegardes logiques (dump/restore) intégrées (LibSQL, qui n'a pas d'outil de dump, est couvert par les sauvegardes de volumes).
- **Du vrai TLS, de vrais certificats wildcard** — Let's Encrypt automatique pour chaque application via Traefik, plus des certificats wildcard DNS-01 (`*.yourdomain.com`) pour l'ingress en cluster/Swarm — et pas seulement du HTTP-01 pour un domaine unique.
- **Des sauvegardes qui quittent les lieux** — des dumps planifiés vers le disque local ou un stockage compatible S3 (S3/R2/MinIO), chiffrés, avec restauration en un clic.
- **Open-core, pas de l'open-washing** — tout ce qui précède est fourni gratuitement sous AGPL-3.0 dans *ce* dépôt. Pro/Cloud (SSO, export du journal d'audit, marque blanche, facturation multi-tenant) est un module complémentaire distinct, sous une autre licence — rien ici ne vous presse de passer à l'offre payante ni ne plafonne discrètement ce que vous pouvez faire. Tugra envoie des statistiques d'usage anonymes, activées par défaut — des compteurs agrégés (serveurs, applications, bases de données, déploiements) ainsi que votre version, votre édition et votre OS, sous un identifiant aléatoire ; ni noms, ni IP, ni domaines, ni secrets, et le récepteur ne stocke pas votre IP — et vous pouvez les désactiver à tout moment avec `--no-telemetry` / `TUGRA_TELEMETRY=0` ou dans les Paramètres. La vérification des mises à jour et la détection de l'IP publique sont opt-in et désactivées par défaut.

## Comparaison de Tugra

Une comparaison côte à côte avec les outils PaaS auto-hébergeables que les gens évaluent réellement (données des concurrents vérifiées en 2026-10). `✅` intégré · `~` partiel / limité · `—` aucun équivalent intégré documenté · `🔜` dans la feuille de route de Tugra. Une erreur repérée ? [Ouvrez un ticket](https://github.com/SimerayCom/tugra/issues).

| | **Tugra** | Coolify | Dokploy | Portainer | CapRover | Dokku |
|---|---|---|---|---|---|---|
| **Déploiement et build** | | | | | | |
| Tableau de bord web | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| Déploiement depuis Git | ✅ | ✅ | ✅ | ~ | ~ | ✅ |
| Déploiement Docker Compose | ✅ | ✅ | ✅ | ✅ | ~ | ~ |
| Déploiements de prévisualisation (applications de PR) | ✅ | ✅ | ✅ | — | — | ~ |
| Retours en arrière (rollbacks) | ✅ | ✅ | ✅ | — | ✅ | ~ |
| Boutique d'applications / modèles en un clic | ✅ | ✅ | ✅ | ✅ | ✅ | — |
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
| Opérations groupées à l'échelle de la flotte (un seul appel) | ✅ | — | — | — | — | — |
| Mises à jour de l'OS (par serveur + flotte) | ✅ | — | — | — | — | — |
| **Observabilité** | | | | | | |
| Métriques intégrées (CPU/RAM/disque) | ✅ | ~ | ✅ | ~ | — | — |
| Moniteurs de disponibilité + notifications | ✅ | ~ | ✅ | — | — | — |
| Visualiseur de journaux d'applications / conteneurs | ✅ | ✅ | ✅ | ✅ | — | ✅ |
| **Accès et agents** | | | | | | |
| Équipes / RBAC | ✅ | ~ | ✅ | ~⁷ | — | — |
| SSO / OIDC | ✅ (Pro)⁸ | ✅ | ✅ | ~⁷ | — | — |
| Journal d'audit | ✅ | ✅ | ✅ | ~⁷ | — | — |
| MCP / contrôle par agent | ✅ 48 outils⁵ | ✅ | ✅ | — | — | ~² |
| **Confiance et licence** | | | | | | |
| Télémétrie | Anonyme, opt-out (compteurs uniquement) | n/d | n/d | n/d | n/d | n/d |
| Migration entrante (import depuis Coolify) | ✅⁹ | — | — | — | — | — |
| Licence du cœur | AGPL-3.0 | Apache-2.0 | Apache-2.0³ | zlib + BE⁷ | Apache-2.0 + conditions⁴ | MIT |

<sub>¹ Coolify v4 gère les serveurs individuellement (pas de clustering intégré). ² Un projet MCP Dokku tiers, à un stade précoce, et non une version officielle. ³ Le cœur de Dokploy est sous Apache-2.0 ; une licence distincte de type Source-Available couvre son répertoire entreprise `proprietary/` (SSO, journaux d'audit, marque blanche) — exactement le même modèle open-core que celui de Tugra. ⁴ Le `LICENSE` de CapRover est Apache-2.0 avec une annexe restreignant la modification et la redistribution des fonctionnalités payantes. ⁵ Tugra, Coolify et Dokploy fournissent tous des serveurs MCP avec des outils de lecture et d'écriture, si bien que le contrôle par agent est à parité ; Tugra y ajoute des actions à l'échelle de la flotte (un seul appel sur un cluster), la confirmation par le nom sur les outils destructeurs et l'occultation des secrets. ⁶ Dokku ne prend pas en charge Docker Swarm ; son option multi-nœuds est le plugin `scheduler-k3s` (k3s/Kubernetes), une architecture différente. ⁷ Le RBAC, le SSO et les journaux d'audit de Portainer font partie de son édition Business payante. ⁸ Le cœur de Tugra est gratuit et complet (équipes/RBAC, journal d'audit, sauvegardes, supervision, MCP, migrateur, HA multi-nœuds) ; le SSO/OIDC est une fonctionnalité Pro. ⁹ Importe les applications Coolify ainsi que leur configuration et leurs variables d'environnement sous forme de nouvelles ressources Tugra (mode copie) ; un adoptant Docker local distinct reprend sur place les conteneurs du même hôte (en conservant leurs volumes nommés). Les **données** des bases Postgres, MySQL, MariaDB, Redis, KeyDB et Dragonfly se déplacent d'un hôte à l'autre grâce à un migrateur en une commande que vous collez sur l'hôte Coolify ; les données MongoDB se déplacent par un dump-and-restore guidé (import-from-url), les données LibSQL et les données de **volumes** d'applications par `tar`/`rsync`, et ClickHouse n'a pas encore d'outil de migration ([docs/coolify-migration.md](docs/coolify-migration.md)). Les noms de produits sont des marques déposées de leurs propriétaires respectifs ; Tugra n'est ni affilié à eux ni approuvé par eux.</sub>

## Démarrage rapide

Sur un hôte Linux vierge, **une seule commande** installe les prérequis (git, Docker), clone le dépôt et lance la pile :

```bash
curl -fsSL https://raw.githubusercontent.com/SimerayCom/tugra/main/scripts/bootstrap.sh | sh
```

<p align="center"><img src="docs/assets/install.png" alt="Installation de Tugra en une commande sur un hôte Ubuntu vierge : prérequis installés, configuration écrite, pile démarrant en bonne santé, et code de configuration du propriétaire" width="840" /></p>

Vous préférez lire avant d'exécuter (ce qui est sensé pour tout script auquel vous confiez un accès Docker quasi root) ? Clonez le dépôt et lancez vous-même l'installateur — il se contente d'écrire un `.env` local et d'appeler `docker compose`, installe Docker s'il est absent, et est idempotent (sans risque à relancer) :

```bash
git clone https://github.com/SimerayCom/tugra.git
cd tugra
less scripts/install.sh   # review it first
./scripts/install.sh
```

L'installateur génère des secrets robustes dans un `.env` local (une nouvelle exécution les conserve), puis démarre le hub, l'interface web, PostgreSQL et Redis avec `docker compose`. Une fois terminé, ouvrez l'URL **Web UI** affichée (`http://<host-ip>:3001` ; la base du hub/de l'API est `http://<host-ip>:3000`) et créez le premier compte — il devient le **propriétaire** de l'instance. Lors d'une nouvelle installation, l'installateur affiche aussi un **code de configuration** à usage unique à saisir lors de la création de ce compte (retrouvez-le avec `grep SETUP_CODE .env`). Suivez ensuite l'assistant d'accueil pour connecter votre premier serveur.

Relancer `./scripts/install.sh` (par exemple après un `git pull`) est sans danger — il conserve vos secrets et ne met à jour que la configuration, ce qui en fait aussi la procédure de mise à niveau.

**Production (TLS + un domaine).** La pile fournit du HTTP en clair sur les ports de cet hôte pour un démarrage rapide ; placez-la derrière votre propre reverse proxy qui termine le TLS et relancez avec votre domaine :

```bash
./scripts/install.sh --domain tugra.example.com
```

Dirigez la majeure partie du trafic vers le **web** (`:3001`) — il fait suivre pour vous l'API REST et le démarrage OAuth vers le hub — et n'envoyez au **hub** (`:3000`) que les chemins que le web ne sait pas gérer :

| Préfixe de chemin | → |
|---|---|
| `/agent`, `/terminal` (WebSocket), `/install`, `/webhooks`, `/auth/oauth` | hub `:3000` |
| tout le reste (`/`, `/api/*`) | web `:3001` |

Remarques :

- **Le TLS n'est pas fourni** — apportez votre propre reverse proxy (Caddy, Traefik, nginx, …). `--domain` définit `COOKIE_SECURE=true` + `HUB_TRUSTED_PROXY=true` pour cette configuration.
- **Verrouillez les ports bruts.** Avec `HUB_TRUSTED_PROXY=true`, le hub tient compte de `X-Forwarded-For` ; les ports bruts `:3000`/`:3001` ne doivent donc être joignables que par le proxy. Une nouvelle installation avec `--domain` les lie à `127.0.0.1` (proxy sur le même hôte). Si le proxy tourne sur un autre hôte, définissez `HUB_BIND`/`WEB_BIND` sur l'IP de l'interface privée de cette machine et filtrez les ports avec un pare-feu — les ports publiés par Docker contournent `ufw`.
- **« Sign in with GitHub »** ne fonctionne que dans ce déploiement à origine unique derrière un proxy (le hub et le web partagent une origine publique afin que le cookie de session soit visible par la SPA) ; il n'est pas disponible dans le démarrage rapide simple à deux ports.

> Les images publiées (`ghcr.io/simeraycom/tugra-*`) arriveront avec la première version taguée. D'ici là, l'installateur construit automatiquement à partir de votre copie locale — même commande, aucune modification nécessaire.

**Démarrage rapide MCP.** Une fois Tugra lancé, créez un personal access token (**Settings → API tokens**) et pointez n'importe quel client MCP dessus :

```bash
curl -s http://<web-url>/api/v1/mcp \
  -H "Authorization: Bearer $TUGRA_PAT" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize"}'
```

## Auto-hébergé ou cloud

Tout ce qui figure dans [Pourquoi Tugra](#pourquoi-tugra) ci-dessus est **gratuit et open source pour toujours**, sous AGPL-3.0, auto-hébergé sur vos propres serveurs — aucun plafond artificiel, aucun indicateur de fonctionnalité prêt à être activé contre paiement. L'édition Community de ce dépôt est le vrai produit, pas une démo bridée.

Les éditions Pro et Cloud (SSO, export du journal d'audit, marque blanche, plan de contrôle managé) sont proposées sous une licence commerciale distincte. Pour une licence non AGPL ou pour tout ce que l'édition Community ne sait pas faire, contactez **license@tugra.io**.

## Architecture

| Composant | Stack |
|---|---|
| Hub (API + cerveau) | NestJS · PostgreSQL (Prisma) · Redis / BullMQ |
| Web | Next.js |
| Agent | Go (binaire unique, par serveur) |
| Proxy | Traefik (SSL automatique, y compris wildcard DNS-01) |

Les journaux en direct, les métriques et le terminal sont diffusés par WebSockets. Description complète dans [docs/architecture.md](docs/architecture.md).

## Feuille de route

**Livré**

- [x] Protocole Hub ↔ Agent + enrôlement des serveurs (WSS sortant · ed25519 · commandes signées + portée des capacités)
- [x] Déploiement depuis Git / Docker Compose / image (Nixpacks · Dockerfile · site statique)
- [x] Reverse proxy + SSL automatique (Traefik · Let's Encrypt, y compris wildcard DNS-01)
- [x] Métriques en direct, journaux de build et terminal web (flux WebSocket)
- [x] Bases de données (9 moteurs) avec sauvegardes et restauration (local + hors site S3/R2)
- [x] Clusters multi-serveurs + formation de Docker Swarm, opérations groupées sur toute la flotte
- [x] Serveur MCP natif — 48 outils (lecture + modification/opérations de flotte limitées par PAT) + prompts guidés
- [x] App store — catalogue de modèles en un clic + lanceur en mode Home
- [x] Explorateur de fichiers en lecture seule pour les volumes d'applications (interface web + MCP `list_files`)
- [x] Déploiements de prévisualisation (par pull request)
- [x] Supervision de disponibilité (HTTP/TCP/métrique) + canaux de notification
- [x] Tâches planifiées (cron) · retours en arrière · limites de ressources et contrôles de santé
- [x] Projets / environnements · équipes, rôles et invitations · étiquettes · variables partagées
- [x] API publique (OpenAPI) + CLI (`tugra`)
- [x] Mise à jour des serveurs (mises à jour des paquets de l'OS)
- [x] Mise à jour automatique (versions signées) + accueil guidé
- [x] Migrateur — adoption de conteneurs Docker locaux + import depuis Coolify (connexion · plan · application · retour arrière) + migration des données de bases entre hôtes en une commande (Postgres · MySQL · MariaDB · Redis · KeyDB · Dragonfly)

**Prochainement**

- [ ] OAuth MCP pour les clients tiers (enregistrement dynamique des clients, PKCE)
- [ ] Gestionnaire de fichiers — prise en charge de l'écriture (téléversement / renommage / suppression)
- [ ] Migration en un clic des données ClickHouse et MongoDB, et des données de volumes d'applications
- [ ] Davantage de sources de migration (Dokploy, CapRover)
- [ ] Application mobile

## Communauté et documentation

- [Documentation complète](docs/README.md) — installation, architecture, API, CLI, sécurité, open-core
- [Tickets](https://github.com/SimerayCom/tugra/issues) — rapports de bogues et demandes de fonctionnalités
- [Discussions](https://github.com/SimerayCom/tugra/discussions) — questions, idées, présentations de projets
- [Contribuer](CONTRIBUTING.md) · [Code de conduite](CODE_OF_CONDUCT.md) · [CLA](CLA.md)
- [Politique de sécurité](SECURITY.md)

## Contributeurs

<a href="https://github.com/SimerayCom/tugra/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=SimerayCom/tugra" alt="Contributeurs" />
</a>

## Sponsors

Tugra est construit et maintenu à ciel ouvert. S'il vous est utile, à vous ou à votre équipe, pensez à [sponsoriser le projet sur GitHub](https://github.com/sponsors/mrcandev) — il n'y a pas encore de palier de sponsoring, vous seriez donc le premier, et chaque contribution aide à préserver l'indépendance du développement.

## Historique des étoiles

[![Star History Chart](https://api.star-history.com/svg?repos=SimerayCom/tugra&type=Date)](https://star-history.com/#SimerayCom/tugra&Date)

## Licence

Tugra repose sur un modèle **open-core** :

- **Cœur** (ce dépôt) — [GNU AGPLv3](LICENSE). Libre d'utilisation, d'auto-hébergement, d'étude et de modification. Si vous exécutez une version modifiée comme service réseau, vous devez partager vos modifications sous la même licence.
- **Agent et CLI** — [MIT](agent/LICENSE). Utilisez-les où vous voulez, sans condition.
- **Tugra Cloud et fonctionnalités Pro** — propriétaires, pas encore publiés (voir [Auto-hébergé ou cloud](#auto-hébergé-ou-cloud)).

**Licence commerciale :** si vous ne pouvez pas vous conformer à l'AGPLv3 (par exemple si vous voulez bâtir une offre propriétaire ou SaaS au-dessus de Tugra), une licence commerciale est disponible. Contactez **license@tugra.io**. Description complète dans [docs/open-core.md](docs/open-core.md).

---

<div align="center"><sub>AGPL-3.0 © Simeray Ltd — voir <a href="LICENSE">LICENSE</a>.</sub></div>
