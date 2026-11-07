<div align="center">

<img src="docs/assets/logo-seal.png" alt="Tugra" width="200" />

# Tugra

*Tu sello en cada servidor.*

**PaaS open-core y autoalojable, creado para flotas y agentes de IA.**

[![GitHub stars](https://img.shields.io/github/stars/SimerayCom/tugra?style=flat&logo=github&label=stars)](https://github.com/SimerayCom/tugra/stargazers)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue)](LICENSE)
[![Release](https://img.shields.io/github/v/release/SimerayCom/tugra?sort=semver&label=release)](https://github.com/SimerayCom/tugra/releases)
[![CI](https://img.shields.io/github/actions/workflow/status/SimerayCom/tugra/ci.yml?branch=main&label=CI)](https://github.com/SimerayCom/tugra/actions/workflows/ci.yml)
[![Image: ghcr.io](https://img.shields.io/badge/image-ghcr.io%2Fsimeraycom%2Ftugra--hub-blue?logo=docker&logoColor=white)](#inicio-rápido)

[Sitio web](https://tugra.io) · [Documentación](docs/README.md) · [Publicación de versiones](docs/RELEASING.md) · [Hoja de ruta](#hoja-de-ruta)

[English](README.md) · [Türkçe](README.tr.md) · **Español** · [Deutsch](README.de.md) · [Français](README.fr.md) · [Português](README.pt.md) · [简体中文](README.zh.md) · [日本語](README.ja.md)

</div>

---

> **Estado:** Beta. En desarrollo activo; las API pueden cambiar entre versiones menores. Las estrellas, los issues y los comentarios son muy bienvenidos.

<div align="center">

<img src="docs/assets/screenshot-app-store.png" alt="Tugra App Store — despliegue con un clic desde cientos de plantillas de apps autoalojadas" width="860" />

<img src="docs/assets/screenshot-dashboard.png" alt="Centro de mando — las apps, bases de datos y la flota de cada equipo de un vistazo" width="860" />

<img src="docs/assets/screenshot-app-detail.png" alt="Detalle de la app — despliegue, reinicio, escalado, logs y archivos por app" width="420" />&nbsp;<img src="docs/assets/screenshot-databases.png" alt="Bases de datos gestionadas con un clic y volúmenes persistentes" width="420" />

</div>

## Nativo para agentes por defecto

Tugra incluye un servidor [MCP](https://modelcontextprotocol.io) nativo: apunta Claude, Cursor o tu propio agente a tu infraestructura para inspeccionarla, desplegar, escalar y operarla, con los mismos tokens de acceso personal, ámbitos y registro de auditoría que la API REST. Sin paquete de integración aparte y sin que nunca se devuelvan valores secretos al modelo.

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

Es el mismo endpoint `POST /api/v1/mcp`, con la misma autenticación por token de acceso personal, los mismos ámbitos y la misma lista de IP permitidas que la API REST subyacente: no hay que gestionar ninguna credencial aparte, y nunca se devuelven al modelo valores secretos descifrados. El catálogo consta de **48 herramientas**: 26 de solo lectura (incluidos resúmenes de estado / salud / listado de apps de toda la flota en una sola llamada y un explorador de archivos de volúmenes en entorno aislado), más 22 herramientas de mutación/operaciones con ámbito PAT (desplegar · cancelar un despliegue en cola · reiniciar · escalar en vivo · revertir · definir variables de entorno · formar/ampliar un swarm · acciones de toda la flota sobre un clúster · configuración de DNS de dominios con un clic). Cada herramienta de mutación reutiliza exactamente las mismas comprobaciones de permisos de equipo y el mismo registro de auditoría de la API REST, y las irreversibles (disolver un swarm, eliminar una app) exigen una confirmación explícita por nombre. OAuth para clientes de terceros sigue en la hoja de ruta.

## ¿Qué es Tugra?

Tugra es un plano de control open-core y autoalojable para desplegar, monitorizar y operar apps y bases de datos en tus propios servidores: el día a día de Heroku, Render o Railway, sin entregar tu infraestructura a la nube de otro. Su foco es la **flota**: clústeres reales de Docker Swarm entre tus servidores (no solo gestión de una máquina cada vez), operaciones masivas en toda la flota y un servidor MCP integrado para operaciones dirigidas por IA, todo bajo una licencia que de verdad puedes leer.

## Por qué Tugra

- **Primero la flota, no una sola máquina** — agrupa servidores en clústeres, forma un Docker Swarm real entre ellos y ejecuta un comando en toda tu flota con una sola llamada de operaciones masivas, en lugar de entrar por SSH en cada máquina.
- **También nativo para agentes** — un servidor MCP integrado expone 48 herramientas (lectura + operaciones de mutación/flota con ámbito PAT) mediante `POST /api/v1/mcp`, con el mismo ámbito de tokens de acceso personal que la API REST.
- **9 motores de bases de datos, un único flujo de trabajo** — PostgreSQL, MySQL, MariaDB, MongoDB, Redis, KeyDB, Dragonfly, ClickHouse y LibSQL, todos aprovisionados de la misma forma; ocho tienen copias de seguridad lógicas integradas con volcado/restauración (LibSQL, que no tiene herramienta de volcado, queda cubierto por las copias de seguridad de volúmenes).
- **TLS de verdad, comodines de verdad** — Let's Encrypt automático por app mediante Traefik, más certificados comodín DNS-01 (`*.yourdomain.com`) para el ingreso en clúster/Swarm, no solo HTTP-01 de un único dominio.
- **Copias de seguridad que salen del edificio** — volcados programados a disco local o a almacenamiento compatible con S3 (S3/R2/MinIO), cifrados y con restauración con un clic.
- **Open-core, no open-washed** — todo lo anterior se distribuye gratis bajo AGPL-3.0 en *este* repositorio. Pro/Cloud (SSO, exportación del registro de auditoría, marca blanca, facturación multiinquilino) es un complemento con licencia aparte: nada aquí te presiona para que actualices ni limita en silencio lo que puedes hacer. Tugra envía estadísticas de uso anónimas, activadas por defecto: recuentos agregados (servidores, apps, bases de datos, despliegues) más tu versión, edición y sistema operativo, bajo un id aleatorio; sin nombres, IP, dominios ni secretos, y el receptor no almacena tu IP. Puedes desactivarlas en cualquier momento con `--no-telemetry` / `TUGRA_TELEMETRY=0` o en Ajustes. La comprobación de actualizaciones y la detección de IP pública son opt-in y están desactivadas por defecto.

## Cómo se compara Tugra

Una comparación lado a lado con las herramientas PaaS autoalojables que la gente realmente evalúa (datos de la competencia verificados en 2026-10). `✅` integrado · `~` parcial / limitado · `—` sin equivalente integrado documentado · `🔜` en la hoja de ruta de Tugra. ¿Has visto un error? [Abre un issue](https://github.com/SimerayCom/tugra/issues).

| | **Tugra** | Coolify | Dokploy | Portainer | CapRover | Dokku |
|---|---|---|---|---|---|---|
| **Despliegue y compilación** | | | | | | |
| Panel de control web | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| Despliegue desde Git | ✅ | ✅ | ✅ | ~ | ~ | ✅ |
| Despliegue con Docker Compose | ✅ | ✅ | ✅ | ✅ | ~ | ~ |
| Despliegues de vista previa (apps de PR) | ✅ | ✅ | ✅ | — | — | ~ |
| Reversiones (rollbacks) | ✅ | ✅ | ✅ | — | ✅ | ~ |
| Tienda de apps / plantillas de un clic | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| **Datos** | | | | | | |
| Motores de bases de datos gestionados | **9** | 8 | 6 | — | — | — |
| Copias de seguridad S3 programadas + restauración | ✅ | ✅ | ✅ | — | — | ~ |
| Copias de seguridad de volúmenes Docker de apps | ✅ | — | ✅ | — | — | — |
| **Dominios y TLS** | | | | | | |
| Dominios personalizados + SSL automático | ✅ | ✅ | ✅ | — | ✅ | ✅ |
| Certificados comodín DNS-01 | ✅ | ~ | — | — | — | ~ |
| **Flota y alta disponibilidad** | | | | | | |
| Clustering multinodo | ✅ Swarm | Individual¹ | ✅ Swarm | ✅ | ✅ | ~ k3s⁶ |
| HA Raft multi-manager + HA de ingreso | ✅ | — | — | — | — | — |
| Operaciones masivas en toda la flota (una llamada) | ✅ | — | — | — | — | — |
| Parcheo del SO (por servidor + flota) | ✅ | — | — | — | — | — |
| **Observabilidad** | | | | | | |
| Métricas integradas (CPU/RAM/disco) | ✅ | ~ | ✅ | ~ | — | — |
| Monitores de disponibilidad + notificaciones | ✅ | ~ | ✅ | — | — | — |
| Visor de logs de apps / contenedores | ✅ | ✅ | ✅ | ✅ | — | ✅ |
| **Acceso y agentes** | | | | | | |
| Equipos / RBAC | ✅ | ~ | ✅ | ~⁷ | — | — |
| SSO / OIDC | ✅ (Pro)⁸ | ✅ | ✅ | ~⁷ | — | — |
| Registro de auditoría | ✅ | ✅ | ✅ | ~⁷ | — | — |
| MCP / control por agentes | ✅ 48 herramientas⁵ | ✅ | ✅ | — | — | ~² |
| **Confianza y licencia** | | | | | | |
| Telemetría | Anónima, opt-out (solo recuentos) | n/a | n/a | n/a | n/a | n/a |
| Migrar a Tugra (importar desde Coolify) | ✅⁹ | — | — | — | — | — |
| Licencia del núcleo | AGPL-3.0 | Apache-2.0 | Apache-2.0³ | zlib + BE⁷ | Apache-2.0 + condiciones⁴ | MIT |

<sub>¹ Coolify v4 gestiona los servidores de forma individual (sin clustering integrado). ² Un proyecto MCP de Dokku de terceros, en fase temprana, no una versión oficial. ³ El núcleo de Dokploy es Apache-2.0; una licencia Source-Available aparte cubre su directorio empresarial `proprietary/` (SSO, registros de auditoría, marca blanca), la misma forma open-core que usa Tugra. ⁴ El `LICENSE` de CapRover es Apache-2.0 con un apéndice que restringe la modificación/redistribución de las funciones de pago. ⁵ Tugra, Coolify y Dokploy incluyen servidores MCP con herramientas de lectura y escritura, por lo que el control por agentes está en paridad; Tugra añade acciones de toda la flota (una llamada sobre un clúster), confirmación por nombre en las herramientas destructivas y redacción de secretos. ⁶ Dokku no es compatible con Docker Swarm; su opción multinodo es el plugin `scheduler-k3s` (k3s/Kubernetes), una arquitectura distinta. ⁷ El RBAC, el SSO y los registros de auditoría de Portainer forman parte de su Business Edition de pago. ⁸ El núcleo de Tugra es gratuito y completo (equipos/RBAC, registro de auditoría, copias de seguridad, monitorización, MCP, migrador, HA multinodo); el SSO/OIDC es una función Pro. ⁹ Importa las apps de Coolify y su configuración/variables de entorno como nuevos recursos de Tugra (modo copia); un adoptador local de Docker aparte se hace cargo in situ de los contenedores del mismo host (conservando sus volúmenes con nombre). Los **datos** de las bases de datos Postgres, MySQL, MariaDB, Redis, KeyDB y Dragonfly se mueven entre hosts con un migrador de un solo comando que pegas en el host de Coolify; los datos de MongoDB se mueven mediante un volcado y restauración guiados (import-from-url), los de LibSQL y los **datos de volúmenes** de las apps con `tar`/`rsync`, y ClickHouse aún no tiene herramienta de migración ([docs/coolify-migration.md](docs/coolify-migration.md)). Los nombres de productos son marcas comerciales de sus respectivos propietarios; Tugra no está afiliado a ellos ni cuenta con su respaldo.</sub>

## Inicio rápido

En un host Linux recién instalado, **un solo comando** instala los requisitos previos (git, Docker), clona el repositorio y levanta el stack:

```bash
curl -fsSL https://raw.githubusercontent.com/SimerayCom/tugra/main/scripts/bootstrap.sh | sh
```

<p align="center"><img src="docs/assets/install.png" alt="Instalación de Tugra con un solo comando en un host Ubuntu recién instalado: requisitos previos instalados, configuración escrita, el stack arrancando en buen estado y el código de configuración del propietario" width="840" /></p>

¿Prefieres leer antes de ejecutar (lo sensato con cualquier script al que le das acceso a Docker casi de root)? Clona y ejecuta tú mismo el instalador: solo escribe un `.env` local y llama a `docker compose`, instala Docker si falta y es idempotente (se puede volver a ejecutar sin riesgo):

```bash
git clone https://github.com/SimerayCom/tugra.git
cd tugra
less scripts/install.sh   # review it first
./scripts/install.sh
```

El instalador genera secretos robustos en un `.env` local (al volver a ejecutarlo se conservan) y luego levanta el hub, la interfaz web, PostgreSQL y Redis con `docker compose`. Cuando termina, abre la URL de la **interfaz web** que imprime (`http://<host-ip>:3001`; la base del hub/API es `http://<host-ip>:3000`) y crea la primera cuenta: pasa a ser el **propietario** de la instancia. En una instalación nueva, el instalador también imprime un **código de configuración** de un solo uso que debes introducir al crear esa cuenta (recupéralo con `grep SETUP_CODE .env`). Después sigue el asistente de incorporación para conectar tu primer servidor.

Volver a ejecutar `./scripts/install.sh` (p. ej. tras un `git pull`) es seguro: conserva tus secretos y solo actualiza la configuración, así que sirve también como ruta de actualización.

**Producción (TLS + un dominio).** El stack se entrega con HTTP plano en los puertos de este host para un inicio rápido; ponlo detrás de tu propio proxy inverso que termine TLS y vuelve a ejecutar con tu dominio:

```bash
./scripts/install.sh --domain tugra.example.com
```

Dirige la mayor parte del tráfico a la **web** (`:3001`), que se encarga de reenviar al hub la API REST y el inicio de OAuth, y envía al **hub** (`:3000`) solo las rutas que la web no puede gestionar:

| Prefijo de ruta | → |
|---|---|
| `/agent`, `/terminal` (WebSocket), `/install`, `/webhooks`, `/auth/oauth` | hub `:3000` |
| todo lo demás (`/`, `/api/*`) | web `:3001` |

Notas:

- **TLS no está incluido** — trae tu propio proxy inverso (Caddy, Traefik, nginx, …). `--domain` establece `COOKIE_SECURE=true` + `HUB_TRUSTED_PROXY=true` para esa configuración.
- **Bloquea los puertos directos.** Con `HUB_TRUSTED_PROXY=true` el hub respeta `X-Forwarded-For`, por lo que los puertos directos `:3000`/`:3001` deben ser accesibles **solo** para el proxy. Una instalación nueva con `--domain` los enlaza a `127.0.0.1` (proxy en el mismo host). Si el proxy se ejecuta en otro host, define `HUB_BIND`/`WEB_BIND` con la IP de la interfaz privada de esta máquina y protege los puertos con un cortafuegos: los puertos publicados por Docker eluden `ufw`.
- **«Sign in with GitHub»** solo funciona en este despliegue de proxy de origen único (el hub y la web comparten un origen público para que la SPA vea la cookie de sesión); no está disponible en el inicio rápido simple de dos puertos.

> Las imágenes publicadas (`ghcr.io/simeraycom/tugra-*`) llegarán con la primera versión etiquetada. Hasta entonces, el instalador compila automáticamente desde tu copia local: el mismo comando, sin cambios.

**Inicio rápido de MCP.** Cuando Tugra esté en marcha, genera un token de acceso personal (**Settings → API tokens**) y apunta cualquier cliente MCP hacia él:

```bash
curl -s http://<web-url>/api/v1/mcp \
  -H "Authorization: Bearer $TUGRA_PAT" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize"}'
```

## Autoalojado frente a nube

Todo lo de [Por qué Tugra](#por-qué-tugra) es **gratuito y de código abierto para siempre**, bajo AGPL-3.0, autoalojado en tus propios servidores: sin límites artificiales, sin ningún interruptor de función a la espera de activarse a cambio de dinero. La edición Community de este repositorio es el producto de verdad, no una demo capada.

Las ediciones Pro y Cloud (SSO, exportación del registro de auditoría, marca blanca, plano de control gestionado) se ofrecen bajo una licencia comercial aparte. Para una licencia distinta de AGPL o para algo que Community no pueda hacer, contacta con **license@tugra.io**.

## Arquitectura

| Componente | Stack |
|---|---|
| Hub (API + cerebro) | NestJS · PostgreSQL (Prisma) · Redis / BullMQ |
| Web | Next.js |
| Agente | Go (un único binario, por servidor) |
| Proxy | Traefik (SSL automático, incl. comodín DNS-01) |

Los logs en vivo, las métricas y el terminal se transmiten mediante WebSockets. Desglose completo en [docs/architecture.md](docs/architecture.md).

## Hoja de ruta

**Entregado**

- [x] Protocolo Hub ↔ Agente + alta de servidores (WSS saliente · ed25519 · comandos firmados + ámbito de capacidades)
- [x] Despliegue desde Git / Docker Compose / imagen (Nixpacks · Dockerfile · sitio estático)
- [x] Proxy inverso + SSL automático (Traefik · Let's Encrypt, incl. comodín DNS-01)
- [x] Métricas en vivo, logs de compilación y terminal web (flujos WebSocket)
- [x] Bases de datos (9 motores) con copias de seguridad y restauración (local + externas en S3/R2)
- [x] Clústeres multiservidor + formación de Docker Swarm, operaciones masivas en toda la flota
- [x] Servidor MCP nativo — 48 herramientas (lectura + operaciones de mutación/flota con ámbito PAT) + prompts guiados
- [x] Tienda de apps — catálogo de plantillas de un clic + lanzador en modo Home
- [x] Explorador de archivos de solo lectura para volúmenes de apps (interfaz web + MCP `list_files`)
- [x] Despliegues de vista previa (por pull request)
- [x] Monitorización de disponibilidad (HTTP/TCP/métricas) + canales de notificación
- [x] Tareas programadas (cron) · reversiones · límites de recursos y comprobaciones de salud
- [x] Proyectos / entornos · equipos, roles e invitaciones · etiquetas · variables compartidas
- [x] API pública (OpenAPI) + CLI (`tugra`)
- [x] Parcheo de servidores (actualizaciones de paquetes del SO)
- [x] Autoactualización (versiones firmadas) + incorporación guiada
- [x] Migrador — adopta contenedores Docker locales + importa desde Coolify (conectar · planificar · aplicar · revertir) + migración de datos de BD entre hosts con un solo comando (Postgres · MySQL · MariaDB · Redis · KeyDB · Dragonfly)

**Próximamente**

- [ ] OAuth para MCP con clientes de terceros (registro dinámico de clientes, PKCE)
- [ ] Gestor de archivos — soporte de escritura (subir / renombrar / eliminar)
- [ ] Migración con un clic de datos de ClickHouse y MongoDB, y de datos de volúmenes de apps
- [ ] Más orígenes de migración (Dokploy, CapRover)
- [ ] App móvil

## Comunidad y documentación

- [Documentación completa](docs/README.md) — instalación, arquitectura, API, CLI, seguridad, open-core
- [Issues](https://github.com/SimerayCom/tugra/issues) — informes de errores y solicitudes de funciones
- [Discussions](https://github.com/SimerayCom/tugra/discussions) — preguntas, ideas y muestras de proyectos
- [Cómo contribuir](CONTRIBUTING.md) · [Código de conducta](CODE_OF_CONDUCT.md) · [CLA](CLA.md)
- [Política de seguridad](SECURITY.md)

## Colaboradores

<a href="https://github.com/SimerayCom/tugra/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=SimerayCom/tugra" alt="Colaboradores" />
</a>

## Patrocinadores

Tugra se construye y se mantiene de forma abierta. Si te resulta útil a ti o a tu equipo, considera [patrocinar el proyecto en GitHub](https://github.com/sponsors/mrcandev): todavía no hay nivel de patrocinio, así que serías el primero, y cada aportación ayuda a mantener el desarrollo independiente.

## Historial de estrellas

[![Star History Chart](https://api.star-history.com/svg?repos=SimerayCom/tugra&type=Date)](https://star-history.com/#SimerayCom/tugra&Date)

## Licencia

Tugra usa un modelo **open-core**:

- **Núcleo** (este repositorio) — [GNU AGPLv3](LICENSE). Libre para usar, autoalojar, estudiar y modificar. Si ejecutas una versión modificada como servicio de red, debes compartir tus cambios bajo la misma licencia.
- **Agente y CLI** — [MIT](agent/LICENSE). Úsalos donde quieras, sin condiciones.
- **Tugra Cloud y funciones Pro** — propietarios, aún no publicados (consulta [Autoalojado frente a nube](#autoalojado-frente-a-nube)).

**Licencia comercial:** si no puedes cumplir con la AGPLv3 (p. ej., quieres crear una oferta propietaria o SaaS sobre Tugra), hay disponible una licencia comercial. Contacta con **license@tugra.io**. Desglose completo en [docs/open-core.md](docs/open-core.md).

---

<div align="center"><sub>AGPL-3.0 © Simeray Ltd — consulta <a href="LICENSE">LICENSE</a>.</sub></div>
