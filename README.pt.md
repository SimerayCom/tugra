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

[Site](https://tugra.io) · [Documentação](docs/README.md) · [Lançamentos](docs/RELEASING.md) · [Roteiro](#roteiro)

[English](README.md) · [Türkçe](README.tr.md) · [Español](README.es.md) · [Deutsch](README.de.md) · [Français](README.fr.md) · **Português** · [简体中文](README.zh.md) · [日本語](README.ja.md)

</div>

---

> **Status:** Beta. Em desenvolvimento ativo; as APIs podem mudar entre versões menores. Estrelas, issues e feedback são muito bem-vindos.

<div align="center">

<img src="docs/assets/screenshot-app-store.png" alt="Tugra App Store — deploy com um clique a partir de centenas de templates de apps auto-hospedados" width="860" />

<img src="docs/assets/screenshot-dashboard.png" alt="Centro de Comando — os apps, bancos de dados e a frota de cada equipe de relance" width="860" />

<img src="docs/assets/screenshot-app-detail.png" alt="Detalhe do app — deploy, restart, escalonamento, logs e arquivos por app" width="420" />&nbsp;<img src="docs/assets/screenshot-databases.png" alt="Bancos de dados gerenciados com um clique e volumes persistentes" width="420" />

</div>

## Nativo para agentes, por padrão

O Tugra traz um servidor [MCP](https://modelcontextprotocol.io) nativo — aponte o Claude, o Cursor ou o seu próprio agente para a sua infraestrutura para inspecioná-la, fazer deploy, escalar e operá-la, usando os mesmos tokens de acesso pessoal, escopos e trilha de auditoria da API REST. Sem pacote de integração separado e sem que nenhum valor de segredo seja devolvido ao modelo.

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

É o mesmo endpoint `POST /api/v1/mcp`, com a mesma autenticação por token de acesso pessoal, os mesmos escopos e a mesma lista de IPs permitidos da API REST por baixo — sem nenhuma credencial extra para gerenciar, e nenhum valor de segredo descriptografado é devolvido ao modelo. O catálogo tem **48 ferramentas**: 26 somente leitura (incluindo visões consolidadas de status, saúde e listagem de apps de toda a frota em uma única chamada, além de um explorador de arquivos de volumes em sandbox) e 22 ferramentas de escrita e operação com escopo de PAT (deploy · cancelar um deploy na fila · restart · escalar em tempo real · rollback · definir variáveis de ambiente · criar/expandir um swarm · ações em toda a frota de um cluster · configuração de DNS de domínio com um clique). Toda ferramenta de escrita reutiliza exatamente as mesmas verificações de permissão de equipe e a mesma trilha de auditoria da API REST, e as irreversíveis (desfazer um swarm, remover um app) exigem confirmação explícita pelo nome. O OAuth para clientes de terceiros ainda está no roteiro.

## O que é o Tugra?

O Tugra é um plano de controle open-core e auto-hospedável para fazer deploy, monitorar e operar apps e bancos de dados nos seus próprios servidores — o dia a dia do Heroku, do Render ou do Railway, sem entregar a sua infraestrutura à nuvem de outra pessoa. O foco é a **frota**: clusters Docker Swarm de verdade entre os seus servidores (e não apenas o gerenciamento de uma máquina por vez), operações em massa em toda a frota e um servidor MCP integrado para operações conduzidas por IA — tudo sob uma licença que você realmente pode ler.

## Por que Tugra

- **Frota em primeiro lugar, não máquina única** — agrupe servidores em clusters, forme um Docker Swarm de verdade entre eles e execute um comando em toda a frota com uma única chamada de operações em massa, em vez de acessar cada máquina via SSH.
- **Nativo para agentes também** — um servidor MCP integrado expõe 48 ferramentas (leitura + operações de escrita/frota com escopo de PAT) via `POST /api/v1/mcp`, com escopo definido pelos mesmos tokens de acesso pessoal da API REST.
- **9 engines de banco de dados, um único fluxo** — PostgreSQL, MySQL, MariaDB, MongoDB, Redis, KeyDB, Dragonfly, ClickHouse e LibSQL, todos provisionados da mesma forma; oito têm backups lógicos de dump/restore integrados (o LibSQL, que não tem ferramenta de dump, é coberto pelos backups de volume).
- **TLS de verdade, wildcards de verdade** — Let's Encrypt automático por app via Traefik, além de certificados wildcard DNS-01 (`*.yourdomain.com`) para ingress em cluster/Swarm — não apenas HTTP-01 para um único domínio.
- **Backups que saem de casa** — dumps agendados para disco local ou armazenamento compatível com S3 (S3/R2/MinIO), criptografados, com restore com um clique.
- **Open-core de verdade, não open-washing** — tudo o que está acima é distribuído gratuitamente sob AGPL-3.0 *neste* repositório. Pro/Cloud (SSO, exportação do log de auditoria, whitelabel, cobrança multi-tenant) é um complemento com licença separada — nada aqui fica te pressionando a fazer upgrade nem limita silenciosamente o que você pode fazer. O Tugra envia estatísticas de uso anônimas, ativadas por padrão — contagens agregadas (servidores, apps, bancos de dados, deploys) mais a sua versão, edição e SO, associadas a um ID aleatório; sem nomes, IPs, domínios ou segredos, e o servidor que recebe os dados não armazena o seu IP — e você pode desativá-las a qualquer momento com `--no-telemetry` / `TUGRA_TELEMETRY=0` ou nas Configurações. A verificação de atualizações e a detecção de IP público são opt-in e vêm desativadas por padrão.

## Como o Tugra se compara

Uma comparação lado a lado com as ferramentas de PaaS auto-hospedáveis que as pessoas realmente avaliam (dados dos concorrentes verificados em 2026-10). `✅` integrado · `~` parcial / limitado · `—` sem equivalente integrado documentado · `🔜` no roteiro do Tugra. Encontrou algum erro? [Abra uma issue](https://github.com/SimerayCom/tugra/issues).

| | **Tugra** | Coolify | Dokploy | Portainer | CapRover | Dokku |
|---|---|---|---|---|---|---|
| **Deploy e build** | | | | | | |
| Painel web (UI) | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| Deploy a partir do Git | ✅ | ✅ | ✅ | ~ | ~ | ✅ |
| Deploy com Docker Compose | ✅ | ✅ | ✅ | ✅ | ~ | ~ |
| Deploys de preview (apps de PR) | ✅ | ✅ | ✅ | — | — | ~ |
| Rollbacks | ✅ | ✅ | ✅ | — | ✅ | ~ |
| App store / templates de um clique | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| **Dados** | | | | | | |
| Engines de banco de dados gerenciados | **9** | 8 | 6 | — | — | — |
| Backups S3 agendados + restore | ✅ | ✅ | ✅ | — | — | ~ |
| Backups de volumes Docker dos apps | ✅ | — | ✅ | — | — | — |
| **Domínios e TLS** | | | | | | |
| Domínios personalizados + SSL automático | ✅ | ✅ | ✅ | — | ✅ | ✅ |
| Certificados wildcard DNS-01 | ✅ | ~ | — | — | — | ~ |
| **Frota e HA** | | | | | | |
| Cluster multinó | ✅ Swarm | Individual¹ | ✅ Swarm | ✅ | ✅ | ~ k3s⁶ |
| HA Raft multi-manager + HA de ingress | ✅ | — | — | — | — | — |
| Operações em massa na frota (uma chamada) | ✅ | — | — | — | — | — |
| Patching do SO (por servidor + frota) | ✅ | — | — | — | — | — |
| **Observabilidade** | | | | | | |
| Métricas integradas (CPU/RAM/disco) | ✅ | ~ | ✅ | ~ | — | — |
| Monitores de uptime + notificações | ✅ | ~ | ✅ | — | — | — |
| Visualizador de logs de app / contêiner | ✅ | ✅ | ✅ | ✅ | — | ✅ |
| **Acesso e agentes** | | | | | | |
| Equipes / RBAC | ✅ | ~ | ✅ | ~⁷ | — | — |
| SSO / OIDC | ✅ (Pro)⁸ | ✅ | ✅ | ~⁷ | — | — |
| Log de auditoria | ✅ | ✅ | ✅ | ~⁷ | — | — |
| MCP / controle por agentes | ✅ 48 ferramentas⁵ | ✅ | ✅ | — | — | ~² |
| **Confiança e licença** | | | | | | |
| Telemetria | Anônima, opt-out (somente contagens) | n/a | n/a | n/a | n/a | n/a |
| Migrar para cá (importar do Coolify) | ✅⁹ | — | — | — | — | — |
| Licença do núcleo | AGPL-3.0 | Apache-2.0 | Apache-2.0³ | zlib + BE⁷ | Apache-2.0 + termos⁴ | MIT |

<sub>¹ O Coolify v4 gerencia os servidores individualmente (sem clustering integrado). ² Um projeto de MCP para o Dokku feito por terceiros, ainda em estágio inicial, e não um lançamento oficial. ³ O núcleo do Dokploy é Apache-2.0; uma licença Source-Available separada cobre o diretório enterprise `proprietary/` (SSO, logs de auditoria, whitelabel) — o mesmo modelo open-core que o Tugra usa. ⁴ O `LICENSE` do CapRover é Apache-2.0, com um apêndice que restringe a modificação e a redistribuição de funcionalidades pagas. ⁵ Tugra, Coolify e Dokploy distribuem servidores MCP com ferramentas de leitura e escrita, então o controle por agentes está em paridade; o Tugra acrescenta ações em toda a frota (uma chamada em todo um cluster), confirmação pelo nome em ferramentas destrutivas e mascaramento de segredos. ⁶ O Dokku não tem suporte a Docker Swarm; a sua opção multinó é o plugin `scheduler-k3s` (k3s/Kubernetes), uma arquitetura diferente. ⁷ O RBAC, o SSO e os logs de auditoria do Portainer fazem parte da sua Business Edition paga. ⁸ O núcleo do Tugra é gratuito e completo (equipes/RBAC, log de auditoria, backups, monitoramento, MCP, migrator, HA multinó); o SSO/OIDC é um recurso Pro. ⁹ Importa apps do Coolify + a sua configuração/env como novos recursos do Tugra (modo cópia); um adopter local de Docker, separado, assume no local os contêineres do mesmo host (mantendo os seus volumes nomeados). Os **dados** de banco de dados de Postgres, MySQL, MariaDB, Redis, KeyDB e Dragonfly migram entre hosts com um migrator de um único comando, que você cola no host do Coolify; os dados do MongoDB migram por dump-and-restore guiado (import-from-url), os dados do LibSQL e de **volumes** de apps por `tar`/`rsync`, e o ClickHouse ainda não tem ferramenta de migração ([docs/coolify-migration.md](docs/coolify-migration.md)). Os nomes de produtos são marcas registradas dos seus respectivos proprietários; o Tugra não é afiliado a eles nem endossado por eles.</sub>

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

**Produção (TLS + um domínio).** A stack expõe HTTP puro nas portas deste host para um início rápido; coloque-a atrás do seu próprio proxy reverso, que faça a terminação do TLS, e execute o instalador de novo com o seu domínio:

```bash
./scripts/install.sh --domain tugra.example.com
```

Encaminhe a maior parte do tráfego para a **web** (`:3001`) — ela repassa ao hub a API REST e o início do fluxo OAuth — e envie ao **hub** (`:3000`) apenas os caminhos que a web não consegue tratar:

| Prefixo de caminho | → |
|---|---|
| `/agent`, `/terminal` (WebSocket), `/install`, `/webhooks`, `/auth/oauth` | hub `:3000` |
| todo o resto (`/`, `/api/*`) | web `:3001` |

Observações:

- **O TLS não vem incluído** — traga o seu próprio proxy reverso (Caddy, Traefik, nginx, …). `--domain` define `COOKIE_SECURE=true` + `HUB_TRUSTED_PROXY=true` para essa configuração.
- **Restrinja o acesso às portas diretas.** Com `HUB_TRUSTED_PROXY=true`, o hub respeita o `X-Forwarded-For`, então as portas `:3000`/`:3001` devem ser alcançáveis **somente** pelo proxy. Uma instalação nova com `--domain` as associa a `127.0.0.1` (proxy no mesmo host). Se o proxy rodar em outro host, defina `HUB_BIND`/`WEB_BIND` com o IP da interface privada desta máquina e proteja as portas com firewall — as portas publicadas pelo Docker contornam o `ufw`.
- **"Sign in with GitHub"** só funciona neste deploy com proxy e origem única (o hub e a web compartilham uma origem pública para que o cookie de sessão fique visível para a SPA); não está disponível no início rápido simples de duas portas.

> As imagens publicadas (`ghcr.io/simeraycom/tugra-*`) serão lançadas junto com a primeira versão com tag. Até lá, o instalador faz o build automaticamente a partir do seu clone local — mesmo comando, sem nenhuma alteração.

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
- [x] Deploy a partir de Git / Docker Compose / imagem (Nixpacks · Dockerfile · site estático)
- [x] Proxy reverso + SSL automático (Traefik · Let's Encrypt, incl. wildcard DNS-01)
- [x] Métricas em tempo real, logs de build e terminal web (streams WebSocket)
- [x] Bancos de dados (9 engines) com backups e restore (local + off-site em S3/R2)
- [x] Clusters multi-servidor + formação de Docker Swarm, operações em massa em toda a frota
- [x] Servidor MCP nativo — 48 ferramentas (leitura + operações de escrita/frota com escopo de PAT) + prompts guiados
- [x] App store — catálogo de templates de um clique + launcher do modo Home
- [x] Explorador de arquivos somente leitura para volumes de apps (UI web + `list_files` do MCP)
- [x] Deploys de preview (por pull request)
- [x] Monitoramento de uptime (HTTP/TCP/métrica) + canais de notificação
- [x] Tarefas agendadas (cron) · rollbacks · limites de recursos e health checks
- [x] Projetos / ambientes · equipes, papéis e convites · tags · variáveis compartilhadas
- [x] API pública (OpenAPI) + CLI (`tugra`)
- [x] Patching de servidores (atualizações de pacotes do SO)
- [x] Autoatualização (versões assinadas) + onboarding guiado
- [x] Migrator — adoção de contêineres Docker locais + importação do Coolify (conectar · planejar · aplicar · rollback) + migração de dados de banco entre hosts com um único comando (Postgres · MySQL · MariaDB · Redis · KeyDB · Dragonfly)

**A seguir**

- [ ] OAuth do MCP para clientes de terceiros (registro dinâmico de clientes, PKCE)
- [ ] Gerenciador de arquivos — suporte a escrita (upload / renomear / excluir)
- [ ] Migração com um clique para dados de ClickHouse + MongoDB e dados de volumes de apps
- [ ] Mais fontes de migração (Dokploy, CapRover)
- [ ] App mobile

## Comunidade e documentação

- [Documentação completa](docs/README.md) — instalação, arquitetura, API, CLI, segurança, open-core
- [Issues](https://github.com/SimerayCom/tugra/issues) — relatos de bugs e sugestões de funcionalidades
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
