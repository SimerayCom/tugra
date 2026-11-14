<div align="center">

<img src="docs/assets/logo-seal.png" alt="Tugra" width="200" />

# Tugra

*Seu selo em cada servidor.*

**PaaS open-core e auto-hospedável, feito para frotas e agentes de IA.**

[![GitHub stars](https://img.shields.io/github/stars/SimerayCom/tugra?style=flat&logo=github&label=stars)](https://github.com/SimerayCom/tugra/stargazers)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue)](LICENSE)
[![Release](https://img.shields.io/github/v/release/SimerayCom/tugra?sort=semver&label=release)](https://github.com/SimerayCom/tugra/releases)
[![CI](https://img.shields.io/github/actions/workflow/status/SimerayCom/tugra/ci.yml?branch=main&label=CI)](https://github.com/SimerayCom/tugra/actions/workflows/ci.yml)
[![Image: ghcr.io](https://img.shields.io/badge/image-ghcr.io%2Fsimeraycom%2Ftugra--hub-blue?logo=docker&logoColor=white)](#início-rápido)

[Site](https://tugra.io) · [Documentação](docs/README.md) · [Publicação de versões](docs/RELEASING.md) · [Roteiro](#roteiro)

[<img src="docs/assets/flags/gb.svg" width="20" alt=""> English](README.md) · [<img src="docs/assets/flags/tr.svg" width="20" alt=""> Türkçe](README.tr.md) · [<img src="docs/assets/flags/es.svg" width="20" alt=""> Español](README.es.md) · [<img src="docs/assets/flags/de.svg" width="20" alt=""> Deutsch](README.de.md) · [<img src="docs/assets/flags/fr.svg" width="20" alt=""> Français](README.fr.md) · <img src="docs/assets/flags/br.svg" width="20" alt=""> **Português** · [<img src="docs/assets/flags/cn.svg" width="20" alt=""> 简体中文](README.zh.md) · [<img src="docs/assets/flags/jp.svg" width="20" alt=""> 日本語](README.ja.md)

</div>

---

> **Status:** Beta. Em desenvolvimento ativo; as APIs podem mudar entre versões menores. Estrelas, issues e feedback são muito bem-vindos — veja o [guia para beta testers](docs/beta-testing.md) para saber o que testar e como reportar.

<div align="center">

<img src="docs/assets/screenshot-app-store.png" alt="Tugra App Store — deploy com um clique a partir de centenas de templates de apps auto-hospedados" width="860" />

<img src="docs/assets/screenshot-dashboard.png" alt="Command Center — os apps, bancos de dados e a frota de cada equipe de relance" width="860" />

<img src="docs/assets/screenshot-app-detail.png" alt="Detalhe do app — deploy, restart, escalonamento, logs e arquivos por app" width="420" />&nbsp;<img src="docs/assets/screenshot-databases.png" alt="Bancos de dados gerenciados com um clique, com volumes persistentes" width="420" />

</div>

## Nativo para agentes, por padrão

O Tugra traz um servidor [MCP](https://modelcontextprotocol.io) nativo — aponte o Claude, o Cursor ou o seu próprio agente para a sua infraestrutura para inspecioná-la, fazer deploy, escalar e operá-la, usando os mesmos tokens de acesso pessoal, escopos e trilha de auditoria da API REST. Sem pacote de integração separado e sem que nenhum valor de segredo seja jamais devolvido ao modelo.

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

É o mesmo endpoint `POST /api/v1/mcp`, com a mesma autenticação por token de acesso pessoal, os mesmos escopos e a mesma lista de IPs permitidos da API REST por baixo — sem nenhuma credencial extra para gerenciar, e nenhum valor de segredo descriptografado é devolvido ao modelo. O catálogo tem **53 ferramentas**: 31 somente leitura (incluindo visões consolidadas de status, saúde e listagem de apps de toda a frota em uma única chamada, além de um explorador de arquivos de volumes em sandbox) e 22 ferramentas de escrita e operação com escopo de PAT (deploy · cancelar um deploy na fila · restart · escalar em tempo real · rollback · definir variáveis de ambiente · criar/expandir um Swarm · ações em toda a frota de um cluster · configuração de DNS de domínio com um clique). Toda ferramenta de escrita reutiliza exatamente as mesmas verificações de permissão de equipe e a mesma trilha de auditoria da API REST, e as irreversíveis (desfazer um Swarm, remover um app) exigem confirmação explícita pelo nome. O OAuth para clientes de terceiros ainda está no roteiro.

## O que é o Tugra?

O Tugra é um plano de controle open-core e auto-hospedável para fazer deploy, monitorar e operar apps e bancos de dados nos seus próprios servidores — o dia a dia do Heroku, do Render ou do Railway, sem entregar a sua infraestrutura à nuvem de outra pessoa. O foco é a **frota**: clusters Docker Swarm de verdade entre os seus servidores (e não apenas o gerenciamento de uma máquina por vez), operações em massa em toda a frota e um servidor MCP integrado para operações conduzidas por IA — tudo sob uma licença que você realmente pode ler.

## Por que Tugra

- **Frota em primeiro lugar, não máquina única** — agrupe servidores em clusters, forme um Docker Swarm de verdade entre eles e execute um comando em toda a frota com uma única chamada de operações em massa, em vez de acessar cada máquina via SSH.
- **Nativo para agentes também** — um servidor MCP integrado expõe 53 ferramentas (leitura + operações de escrita/frota com escopo de PAT) via `POST /api/v1/mcp`, com escopo definido pelos mesmos tokens de acesso pessoal da API REST.
- **9 engines de banco de dados, um único fluxo** — PostgreSQL, MySQL, MariaDB, MongoDB, Redis, KeyDB, Dragonfly, ClickHouse e LibSQL, todos provisionados da mesma forma; oito têm backups lógicos de dump/restore integrados (o LibSQL, que não tem ferramenta de dump, é coberto apenas por backups de volume em nível de arquivo — pare o app antes para obter uma cópia consistente).
- **TLS de verdade, wildcards de verdade** — Let's Encrypt automático por app via Traefik, além de certificados wildcard DNS-01 (`*.yourdomain.com`) para ingress em cluster/Swarm — não apenas HTTP-01 para um único domínio.
- **Backups fora do servidor** — dumps agendados para disco local ou armazenamento compatível com S3 (S3/R2/MinIO), opcionalmente criptografados (gpg AES-256), com restore com um clique; **simulações de restore-verify** agendadas comprovam que um backup realmente restaura, e o PostgreSQL conta com **recuperação para um ponto no tempo** (envio de WAL + base backups, restore para qualquer segundo a partir do painel).
- **Deploys em que você pode confiar** — deploys progressivos com health gate e rollback automático em caso de falha do gate (mais um período de soak pós-cutover, opt-in, que reverte automaticamente), rollouts de frota (canary → ondas → parada/rollback), build secrets que nunca vão parar na imagem e deploys que sobrevivem a uma reinicialização do control plane.
- **Open-core de verdade, não open-washing** — tudo o que está acima é distribuído gratuitamente sob AGPL-3.0 *neste* repositório. Os recursos Pro/Cloud (SSO, exportação do log de auditoria, whitelabel) são liberados por uma chave assinada com licença separada — nada aqui fica pressionando você a fazer upgrade nem limita silenciosamente o que você pode fazer. O Tugra envia estatísticas de uso anônimas, ativadas por padrão — contagens agregadas (servidores, apps, bancos de dados, deploys, equipes, usuários, clusters, monitores) mais a sua versão, canal de release, edição, SO, arquitetura de CPU e versão principal do Node.js, associadas a um ID aleatório; sem nomes, IPs, domínios ou segredos, e o servidor que recebe os dados não armazena o seu IP — e você pode desativá-las a qualquer momento com `--no-telemetry` / `TUGRA_TELEMETRY=0` ou em Settings. A verificação de atualizações e a detecção de IP público são opt-in e vêm desativadas por padrão.

## Como o Tugra se compara

Uma comparação lado a lado com as ferramentas de PaaS auto-hospedáveis que as pessoas realmente avaliam (dados dos concorrentes verificados em 2026-11). `✅` integrado · `~` parcial / limitado · `—` sem equivalente integrado documentado · `🔜` no roteiro do Tugra. Encontrou algum erro? [Abra uma issue](https://github.com/SimerayCom/tugra/issues).

| | **Tugra** | Coolify | Dokploy | Portainer | CapRover | Dokku |
|---|---|---|---|---|---|---|
| **Deploy e build** | | | | | | |
| Painel web (UI) | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| Deploy a partir do Git | ✅ | ✅ | ✅ | ~ | ~ | ✅ |
| Deploy com Docker Compose | ✅ | ✅ | ✅ | ✅ | ~ | ~ |
| Deploys de preview (apps de PR) | ✅¹¹ | ✅ | ✅ | — | — | ~ |
| Rollbacks | ✅ | ✅ | ✅ | ~¹² | ✅ | ~ |
| App store / templates de um clique | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| **Dados** | | | | | | |
| Engines de banco de dados gerenciados | **9** | 9 (SQLite experimental)¹² | 6 | — | — | ~¹² |
| Backups S3 agendados + restore | ✅ | ✅ | ✅ | — | — | ~ |
| Backups de volumes Docker dos apps (em nível de arquivo, não um snapshot) | ✅ | ~¹² | ✅ | — | — | — |
| **Domínios e TLS** | | | | | | |
| Domínios personalizados + SSL automático | ✅ | ✅ | ✅ | — | ✅ | ✅ |
| Certificados wildcard DNS-01 | ✅ | ~ | — | — | ~¹² | ~ |
| **Frota e HA** | | | | | | |
| Cluster multi-node | ✅ Swarm | Individual¹ | ✅ Swarm | ✅ | ✅ | ~ k3s⁶ |
| HA Raft multi-manager + HA de ingress | ✅ | — | — | — | — | — |
| Operações em massa na frota (uma chamada) | ✅ | — | — | — | — | — |
| Patching do SO (por servidor + frota) | ✅ | ~¹² | — | — | — | — |
| Recuperação para um ponto no tempo (WAL do PostgreSQL) | ✅¹⁰ | — | — | — | — | — |
| Simulações agendadas de restore-verify | ✅ | — | — | — | — | — |
| Rollouts de frota (canary → ondas → parada/rollback automáticos) | ✅ | — | — | ~¹² | — | — |
| Rollback automático pós-cutover (janela de soak, opt-in por app) | ✅ | — | ~¹² | — | — | — |
| **Observabilidade** | | | | | | |
| Métricas integradas (CPU/RAM/disco) | ✅ | ~ | ✅ | ~ | ~¹² | — |
| Monitores de uptime + notificações | ✅ | ~ | ~¹² | — | — | — |
| Visualizador de logs de app / contêiner | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Acesso e agentes** | | | | | | |
| Equipes / RBAC | ✅ | ✅ | ✅ | ~⁷ | — | — |
| SSO / OIDC | ✅ (Pro)⁸ | ✅ | ✅ | ~⁷ | — | — |
| Log de auditoria | ✅ | ✅ | ✅ | ~⁷ | — | — |
| MCP / controle por agentes | ✅ 53 tools⁵ | ✅ | ✅ | ~⁷ | — | ~² |
| **Confiança e licença** | | | | | | |
| Telemetria | Anônima, opt-out (somente contagens) | n/a | n/a | n/a | n/a | n/a |
| Migrar para cá (importar do Coolify) | ✅⁹ | — | — | — | — | — |
| Licença do núcleo | AGPL-3.0 | Apache-2.0 | Apache-2.0³ | zlib + BE⁷ | Apache-2.0 + termos⁴ | MIT |

<sub>¹ O Coolify v4 gerencia os servidores individualmente (sem clustering integrado); o suporte a Docker Swarm está obsoleto (remoção prevista na v5), e fazer deploy de uma imagem em vários servidores exige o seu próprio load balancer. ² Um projeto de MCP para o Dokku feito por terceiros, ainda em estágio inicial, e não um lançamento oficial. ³ O núcleo do Dokploy é Apache-2.0; uma licença Source-Available separada cobre o diretório enterprise `proprietary/` (SSO, logs de auditoria, whitelabel) — o mesmo modelo open-core que o Tugra usa. ⁴ O `LICENSE` do CapRover é Apache-2.0, com um apêndice que restringe a modificação e a redistribuição de funcionalidades pagas. ⁵ O Tugra, o Coolify e o Dokploy distribuem servidores MCP com ferramentas de leitura e escrita, então o controle por agentes está em paridade; o Tugra acrescenta ações em toda a frota (uma chamada em todo um cluster), confirmação pelo nome em ferramentas destrutivas e mascaramento de segredos. ⁶ O Dokku não tem suporte a Docker Swarm; a sua opção multi-node é o plugin `scheduler-k3s` (k3s/Kubernetes), uma arquitetura diferente. ⁷ O RBAC completo, os templates de SSO AD/OIDC e os logs de auditoria do Portainer são da Business Edition (gratuita até 3 nós); a Community tem usuários básicos e LDAP/OAuth limitado. O repositório oficial do servidor MCP não tem suporte; o caminho de IA com suporte (Portainer Command) é da Business Edition. ⁸ O núcleo do Tugra é gratuito e completo (equipes/RBAC, log de auditoria, backups, monitoramento, MCP, migrator, HA multi-node); o SSO/OIDC é uma funcionalidade Pro. ⁹ Importa apps do Coolify + a sua configuração/env como novos recursos do Tugra (modo cópia; projetos do Dokploy também podem ser importados, hoje via API / MCP / CLI, ainda não no assistente web); um adopter local de Docker, separado, assume no local os contêineres do mesmo host (mantendo os seus volumes nomeados). Os **dados** de banco de dados de Postgres, MySQL, MariaDB, Redis, KeyDB e Dragonfly migram entre hosts com um migrator de um único comando, que você cola no host do Coolify; os dados do MongoDB migram por dump-and-restore guiado (import-from-url), os dados do LibSQL e de **volumes** de apps por `tar`/`rsync`, e o ClickHouse ainda não tem ferramenta de migração ([docs/coolify-migration.md](docs/coolify-migration.md)). ¹⁰ Somente PostgreSQL; os demais engines mantêm dumps lógicos agendados. ¹¹ Por enquanto apenas eventos de pull request do GitHub; webhooks do GitLab/Gitea/Bitbucket disparam deploys por push. ¹² Notas sobre concorrentes extraídas da documentação oficial, 2026-11: o Server Patching do Coolify é por servidor e está em Beta, seus backups de storage não têm restore pela UI, e ele documenta 9 engines de BD, mas backups agendados para apenas 6; os limites de monitoramento do Dokploy são rotulados como apenas Cloud e seu rollback é o rollback de atualização nativo do Docker Swarm, que você mesmo configura; o rollout de grupo estilo canary do Portainer é da Business Edition e apenas para Edge Stacks; o DNS-01 do CapRover e o monitoramento com Netdata são configurações manuais/opt-in; as engines de banco de dados do Dokku são plugins oficiais de CLI sem UI. Os nomes de produtos são marcas comerciais dos seus respectivos proprietários; o Tugra não é afiliado a eles nem endossado por eles.</sub>

## Início rápido

Em um host Linux novo, **um único comando** instala os pré-requisitos (git, Docker), clona o repositório e sobe a stack:

```bash
curl -fsSL https://raw.githubusercontent.com/SimerayCom/tugra/main/scripts/bootstrap.sh | sh
```

<p align="center"><img src="docs/assets/install.png" alt="Instalação do Tugra com um único comando em um host Ubuntu novo: pré-requisitos instalados, configuração gravada, a stack subindo saudável e o código de setup do proprietário" width="840" /></p>

Prefere ler antes de executar (uma boa prática para qualquer script a que você concede acesso ao Docker, que na prática equivale a acesso root)? Clone o repositório e execute o instalador você mesmo — ele só grava um `.env` local e chama `docker compose`, instala o Docker se estiver faltando e é idempotente (pode ser executado de novo com segurança):

```bash
git clone https://github.com/SimerayCom/tugra.git
cd tugra
less scripts/install.sh   # review it first
./scripts/install.sh
```

O instalador gera segredos fortes em um `.env` local (executá-lo de novo os preserva) e então sobe o hub, a UI web, o PostgreSQL e o Redis com `docker compose`. Ao terminar, abra a URL da **Web UI** exibida (`http://<host-ip>:3001`; a base do hub/API é `http://<host-ip>:3000`) e crie a primeira conta — ela se torna o **proprietário** da instância. Em uma instalação nova, o instalador também exibe um **código de setup** de uso único, que deve ser informado ao criar essa conta (recupere-o com `grep SETUP_CODE .env`). Depois, siga o assistente de onboarding para conectar o seu primeiro servidor.

Executar `./scripts/install.sh` de novo (por exemplo, depois de um `git pull`) é seguro — ele mantém os seus segredos e só atualiza a configuração, então também serve como caminho de atualização.

**Produção (TLS + um domínio).** A stack expõe HTTP puro nas portas deste host para um início rápido; coloque-a atrás do seu próprio reverse proxy, que faça a terminação do TLS, e execute o instalador de novo com o seu domínio:

```bash
./scripts/install.sh --domain tugra.example.com
```

Encaminhe a maior parte do tráfego para a **web** (`:3001`) — ela repassa ao hub a API REST e o início do fluxo OAuth — e envie ao **hub** (`:3000`) apenas os caminhos que a web não consegue tratar:

| Prefixo de caminho | → |
|---|---|
| `/agent`, `/terminal` (WebSocket), `/install`, `/webhooks`, `/auth/oauth` | hub `:3000` |
| todo o resto (`/`, `/api/*`) | web `:3001` |

Observações:

- **TLS:** traga o seu próprio reverse proxy (Caddy, Traefik, nginx, …) ou adicione `--auto-tls --acme-email you@domain` para que o Tugra provisione o HTTPS do painel (Traefik integrado + Let's Encrypt). `--domain` define `COOKIE_SECURE=true` + `HUB_TRUSTED_PROXY=true`.
- **Restrinja o acesso às portas diretas.** Com `HUB_TRUSTED_PROXY=true`, o hub respeita o `X-Forwarded-For` (somente de peers privados, de loopback ou do docker, ou de `HUB_TRUSTED_PROXY_CIDRS`), e as portas `:3000`/`:3001` deveriam ser alcançáveis **somente** pelo proxy. Uma instalação nova com `--domain` as vincula a `127.0.0.1` (proxy no mesmo host), e uma instalação existente que passa a usar https também é movida para lá (`--keep-raw-ports` desativa isso). Se o proxy rodar em outro host, defina `HUB_BIND`/`WEB_BIND` com o IP da interface privada desta máquina e proteja as portas com firewall — as portas publicadas pelo Docker contornam o `ufw`.
- **"Sign in with GitHub"** só funciona neste deploy com proxy e origem única (o hub e a web compartilham uma origem pública para que o cookie de sessão fique visível para a SPA); não está disponível no início rápido simples de duas portas.

> As imagens publicadas (`ghcr.io/simeraycom/tugra-*`) são baixadas automaticamente; em um host sem imagem publicada para a sua arquitetura (hoje, arm64), o instalador faz o build a partir do seu clone local — mesmo comando, sem nenhuma alteração. Cada versão é fixada por digest e distribuída com provenance assinada; veja [docs/upgrade.md](docs/upgrade.md).

**Início rápido do MCP.** Com o Tugra no ar, gere um token de acesso pessoal (**Settings → API tokens**) e aponte qualquer cliente MCP para ele:

```bash
curl -s http://<web-url>/api/v1/mcp \
  -H "Authorization: Bearer $TUGRA_PAT" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize"}'
```

## Auto-hospedagem vs. nuvem

Tudo o que está em [Por que Tugra](#por-que-tugra) acima é **gratuito e open-source para sempre**, sob AGPL-3.0, auto-hospedado nos seus próprios servidores — sem limite artificial, sem nenhuma feature flag à espera de ser liberada mediante pagamento. A edição Community deste repositório é o produto de verdade, não uma demo limitada.

As edições Pro e Cloud (SSO, exportação do log de auditoria, whitelabel, plano de controle gerenciado) são oferecidas sob uma licença comercial separada. Para uma licença diferente da AGPL ou para algo que a Community não consiga fazer, entre em contato com **license@tugra.io**.

## Arquitetura

| Componente | Stack |
|---|---|
| Hub (API + cérebro) | NestJS · PostgreSQL (Prisma) · Redis / BullMQ |
| Web | Next.js |
| Agente | Go (binário único, por servidor) |
| Proxy | Traefik (SSL automático, incl. wildcard DNS-01) |

Logs em tempo real, métricas e o terminal são transmitidos por WebSockets. Detalhamento completo em [docs/architecture.md](docs/architecture.md).

## Roteiro

**Entregue**

- [x] Protocolo Hub ↔ Agente + registro (enrollment) de servidores (WSS de saída · ed25519 · comandos assinados + escopo de capacidades)
- [x] Deploy a partir de Git / Docker Compose / imagem (Nixpacks · Railpack · buildpacks do Heroku · Dockerfile · site estático)
- [x] Reverse proxy + SSL automático (Traefik · Let's Encrypt, incl. wildcard DNS-01)
- [x] Métricas em tempo real, logs de build e terminal web (streams WebSocket; o terminal é protegido por capability e vem desativado por padrão)
- [x] Bancos de dados (9 engines) com backups e restore (local + off-site em S3/R2)
- [x] Clusters multi-servidor + formação de Docker Swarm, operações em massa em toda a frota
- [x] Servidor MCP nativo — 53 ferramentas (leitura + operações de escrita/frota com escopo de PAT) + prompts guiados
- [x] App store — mais de 280 templates de um clique + launcher do modo Home
- [x] Explorador de arquivos somente leitura para volumes de apps (UI web + `list_files` do MCP)
- [x] Deploys de preview (por pull request)
- [x] Monitoramento de uptime (HTTP/TCP/métrica) + 12 canais de notificação (webhook · Telegram · ntfy · Discord · Slack · Gotify · SMTP · Pushover · Teams · Mattermost · Lark · Resend)
- [x] Tarefas agendadas (cron) · rollbacks · limites de recursos e health checks
- [x] Projetos / ambientes · equipes, papéis e convites · tags · variáveis compartilhadas
- [x] API pública (OpenAPI) + CLI (`tugra`)
- [x] Patching de servidores (atualizações de pacotes do SO)
- [x] Self-update (versões assinadas) + onboarding guiado
- [x] Migrator — adoção de contêineres Docker locais + importação do Coolify (assistente web) e do Dokploy (API / MCP / CLI) (conectar · planejar · aplicar · rollback) + migração de dados de banco entre hosts com um único comando (Postgres · MySQL · MariaDB · Redis · KeyDB · Dragonfly)
- [x] Simulações de restore-verify (agendadas, com um watchdog de liveness) · recuperação para um ponto no tempo do PostgreSQL (envio de WAL · base backups · restore para qualquer segundo)
- [x] Deploys progressivos com health gate + soak pós-cutover opt-in e reversão automática · rollouts de frota (canary → ondas → health gate → parar/retomar/rollback)
- [x] Deploys sobrevivem a uma reinicialização do hub (journal de comandos do agent + adoção do resultado) · página de detalhes por deploy (linha do tempo · log ao vivo · diff de configuração)
- [x] Build secrets via `--secret` do BuildKit (builds com Dockerfile) · rotação da master key (job de recriptografia retomável, nada é digitado de novo, apps intactos; o hub reinicia duas vezes) · self-updates assinados e fixados por digest, com um ponto de restore antes da atualização
- [x] Provisionamento de servidores cloud (Hetzner · DigitalOcean · Vultr) · Cloudflare Tunnel · analytics de tráfego integrado (GeoIP local, sem phone-home) · log drains · registries privados · provedor de segredos Vault (Pro)

**A seguir**

- [ ] OAuth do MCP para clientes de terceiros (registro dinâmico de clientes, PKCE)
- [ ] Gerenciador de arquivos — suporte a escrita (upload / renomear / excluir)
- [ ] Migração com um clique para dados de ClickHouse + MongoDB e dados de volumes de apps
- [ ] Mais fontes de migração (Dokploy no assistente web de importação, CapRover)
- [ ] App mobile

## Comunidade e documentação

- [Documentação completa](docs/README.md) — instalação, arquitetura, API, CLI, segurança, open-core
- [Issues](https://github.com/SimerayCom/tugra/issues) — relatos de bugs e solicitações de funcionalidades
- [Discussions](https://github.com/SimerayCom/tugra/discussions) — perguntas, ideias, show-and-tell
- [Contribuir](CONTRIBUTING.md) · [Código de Conduta](CODE_OF_CONDUCT.md) · [CLA](CLA.md)
- [Política de segurança](SECURITY.md)

## Colaboradores

<a href="https://github.com/SimerayCom/tugra/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=SimerayCom/tugra" alt="Colaboradores" />
</a>

## Patrocinadores

O Tugra é desenvolvido e mantido de forma aberta. Se ele é útil para você ou para a sua equipe, considere [patrocinar o projeto no GitHub](https://github.com/sponsors/mrcandev) — ainda não existe uma faixa de patrocínio, então você seria o primeiro, e toda contribuição ajuda a manter o desenvolvimento independente.

## Histórico de estrelas

[![Star History Chart](https://api.star-history.com/svg?repos=SimerayCom/tugra&type=Date)](https://star-history.com/#SimerayCom/tugra&Date)

## Licença

O Tugra usa um modelo **open-core**:

- **Núcleo** (este repositório) — [GNU AGPLv3](LICENSE). Livre para usar, auto-hospedar, estudar e modificar. Se você executar uma versão modificada como serviço de rede, deve compartilhar as suas alterações sob a mesma licença.
- **Agente e CLI** — [MIT](agent/LICENSE). Use-os em qualquer lugar, sem restrições.
- **Tugra Cloud e funcionalidades Pro** — proprietários, ainda não publicados (veja [Auto-hospedagem vs. nuvem](#auto-hospedagem-vs-nuvem)).

**Licença comercial:** se você não puder cumprir a AGPLv3 (por exemplo, se quiser construir uma oferta proprietária ou SaaS sobre o Tugra), há uma licença comercial disponível. Entre em contato com **license@tugra.io**. Detalhamento completo em [docs/open-core.md](docs/open-core.md).

---

<div align="center"><sub>AGPL-3.0 © Simeray Ltd — veja <a href="LICENSE">LICENSE</a>.</sub></div>
