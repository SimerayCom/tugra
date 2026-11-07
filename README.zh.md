<div align="center">

<img src="docs/assets/logo-seal.png" alt="Tugra" width="200" />

# Tugra

*你的印记，盖在每一台服务器上。*

**面向服务器集群与 AI 智能体打造的开源核心（open-core）、可自托管 PaaS。**

[![GitHub stars](https://img.shields.io/github/stars/SimerayCom/tugra?style=flat&logo=github&label=stars)](https://github.com/SimerayCom/tugra/stargazers)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue)](LICENSE)
[![Release](https://img.shields.io/github/v/release/SimerayCom/tugra?sort=semver&label=release)](https://github.com/SimerayCom/tugra/releases)
[![CI](https://img.shields.io/github/actions/workflow/status/SimerayCom/tugra/ci.yml?branch=main&label=CI)](https://github.com/SimerayCom/tugra/actions/workflows/ci.yml)
[![Image: ghcr.io](https://img.shields.io/badge/image-ghcr.io%2Fsimeraycom%2Ftugra--hub-blue?logo=docker&logoColor=white)](#快速开始)

[官网](https://tugra.io) · [文档](docs/README.md) · [发布流程](docs/RELEASING.md) · [路线图](#路线图)

[English](README.md) · [Türkçe](README.tr.md) · [Español](README.es.md) · [Deutsch](README.de.md) · [Français](README.fr.md) · [Português](README.pt.md) · **简体中文** · [日本語](README.ja.md)

</div>

---

> **状态：** 测试版（Beta）。正在积极开发中；次要版本之间 API 可能发生变化。非常欢迎你点亮 Star、提交 issue 并反馈意见。

<div align="center">

<img src="docs/assets/screenshot-app-store.png" alt="Tugra 应用商店——从数百个自托管应用模板中一键部署" width="860" />

<img src="docs/assets/screenshot-dashboard.png" alt="指挥中心——各团队的应用、数据库和服务器集群一览无余" width="860" />

<img src="docs/assets/screenshot-app-detail.png" alt="应用详情——针对每个应用进行部署、重启、扩缩容，并查看日志与文件" width="420" />&nbsp;<img src="docs/assets/screenshot-databases.png" alt="一键创建带持久化卷的托管数据库" width="420" />

</div>

## 默认即智能体原生

Tugra 内置原生 [MCP](https://modelcontextprotocol.io) 服务器——让 Claude、Cursor 或你自己的智能体直接对接你的基础设施，进行查看、部署、扩缩容和运维，所用的个人访问令牌、权限范围和审计记录与 REST API 完全一致。无需额外的集成包，也绝不会向模型返回任何机密值。

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

它底层使用的就是同一个 `POST /api/v1/mcp` 端点，以及与 REST API 相同的个人访问令牌认证、权限范围和 IP 白名单——无需另行管理凭据，解密后的机密值也绝不会返回给模型。工具目录共 **48 个工具**：26 个只读工具（包括一次调用即可获取的集群状态 / 健康度 / 应用列表汇总，以及沙盒化的卷文件浏览器），外加 22 个受 PAT 权限范围约束的变更 / 运维工具（部署 · 取消排队中的部署 · 重启 · 实时扩缩容 · 回滚 · 设置环境变量 · 组建 / 扩展 swarm · 跨集群的全集群操作 · 一键配置域名 DNS）。每个变更类工具都复用 REST API 完全相同的团队权限检查和审计记录，而不可逆的操作（解散 swarm、删除应用）需要显式输入名称进行确认。面向第三方客户端的 OAuth 仍在路线图中。

## 什么是 Tugra？

Tugra 是一个可自托管的开源核心（open-core）控制平面，用于在你自己的服务器上部署、监控和运维应用与数据库——它提供 Heroku、Render 或 Railway 的日常使用体验，却不必把你的基础设施交给别人的云。它的重心是**集群（fleet）**：跨服务器的真正 Docker Swarm 集群（而不只是一次管理一台机器）、覆盖整个集群的批量操作，以及用于 AI 驱动运维的内置 MCP 服务器——这一切都基于一份你真正能读懂的许可证。

## 为什么选择 Tugra

- **集群优先，而非单机** —— 把服务器分组成集群，在它们之上组建真正的 Docker Swarm，并通过一次批量操作调用就能对整个集群执行命令，不必再逐台 SSH 登录。
- **同样原生支持智能体** —— 内置 MCP 服务器通过 `POST /api/v1/mcp` 提供 48 个工具（只读 + 受 PAT 权限范围约束的变更 / 集群运维操作），其权限范围由与 REST API 相同的个人访问令牌控制。
- **9 种数据库引擎，同一套工作流** —— PostgreSQL、MySQL、MariaDB、MongoDB、Redis、KeyDB、Dragonfly、ClickHouse 和 LibSQL，全部以相同方式创建；其中八种内置逻辑导出 / 恢复备份（LibSQL 没有导出工具，由卷备份覆盖）。
- **真正的 TLS，真正的通配符** —— 通过 Traefik 为每个应用自动签发 Let's Encrypt 证书，并为集群 / Swarm 入口提供 DNS-01 通配符证书（`*.yourdomain.com`）——而不仅仅是单域名 HTTP-01。
- **能“走出大门”的备份** —— 定时导出到本地磁盘或兼容 S3 的存储（S3/R2/MinIO），加密保存，一键恢复。
- **真正的开源核心，而非“开源洗白”** —— 以上所有功能都在*本*仓库中以 AGPL-3.0 免费提供。Pro/Cloud（SSO、审计日志导出、白标、多租户计费）是单独授权的附加组件——这里没有任何东西会催你升级，也不会悄悄限制你能做的事。Tugra 会发送匿名使用统计，默认开启——仅包含汇总计数（服务器、应用、数据库、部署数量）以及你的版本、版本类型（edition）和操作系统，并使用随机 ID 标识；不含名称、IP、域名或机密，接收端也不会存储你的 IP——你可以随时通过 `--no-telemetry` / `TUGRA_TELEMETRY=0` 或在设置中关闭。更新检查和公网 IP 检测为需主动开启，默认关闭。

## Tugra 与同类产品对比

下表将 Tugra 与人们实际会评估的可自托管 PaaS 工具进行并排对比（竞品数据核对于 2026-10）。`✅` 内置 · `~` 部分支持 / 有限制 · `—` 没有文档记载的内置对应功能 · `🔜` 在 Tugra 路线图中。发现错误？[提交 issue](https://github.com/SimerayCom/tugra/issues)。

| | **Tugra** | Coolify | Dokploy | Portainer | CapRover | Dokku |
|---|---|---|---|---|---|---|
| **部署与构建** | | | | | | |
| Web UI 控制台 | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| 从 Git 部署 | ✅ | ✅ | ✅ | ~ | ~ | ✅ |
| Docker Compose 部署 | ✅ | ✅ | ✅ | ✅ | ~ | ~ |
| 预览部署（PR 应用） | ✅ | ✅ | ✅ | — | — | ~ |
| 回滚 | ✅ | ✅ | ✅ | — | ✅ | ~ |
| 应用商店 / 一键模板 | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| **数据** | | | | | | |
| 托管数据库引擎 | **9** | 8 | 6 | — | — | — |
| 定时 S3 备份 + 恢复 | ✅ | ✅ | ✅ | — | — | ~ |
| 应用 Docker 卷备份 | ✅ | — | ✅ | — | — | — |
| **域名与 TLS** | | | | | | |
| 自定义域名 + 自动 SSL | ✅ | ✅ | ✅ | — | ✅ | ✅ |
| DNS-01 通配符证书 | ✅ | ~ | — | — | — | ~ |
| **集群与高可用** | | | | | | |
| 多节点集群 | ✅ Swarm | 单机独立管理¹ | ✅ Swarm | ✅ | ✅ | ~ k3s⁶ |
| 多管理节点 Raft 高可用 + 入口高可用 | ✅ | — | — | — | — | — |
| 全集群批量操作（一次调用） | ✅ | — | — | — | — | — |
| 操作系统补丁（单台服务器 + 整个集群） | ✅ | — | — | — | — | — |
| **可观测性** | | | | | | |
| 内置指标（CPU/内存/磁盘） | ✅ | ~ | ✅ | ~ | — | — |
| 可用性监控 + 通知 | ✅ | ~ | ✅ | — | — | — |
| 应用 / 容器日志查看器 | ✅ | ✅ | ✅ | ✅ | — | ✅ |
| **访问控制与智能体** | | | | | | |
| 团队 / RBAC | ✅ | ~ | ✅ | ~⁷ | — | — |
| SSO / OIDC | ✅ (Pro)⁸ | ✅ | ✅ | ~⁷ | — | — |
| 审计日志 | ✅ | ✅ | ✅ | ~⁷ | — | — |
| MCP / 智能体控制 | ✅ 48 个工具⁵ | ✅ | ✅ | — | — | ~² |
| **信任与许可证** | | | | | | |
| 遥测 | 匿名，可退出（仅计数） | 不适用 | 不适用 | 不适用 | 不适用 | 不适用 |
| 迁入（从 Coolify 导入） | ✅⁹ | — | — | — | — | — |
| 核心许可证 | AGPL-3.0 | Apache-2.0 | Apache-2.0³ | zlib + BE⁷ | Apache-2.0 + 附加条款⁴ | MIT |

<sub>¹ Coolify v4 逐台单独管理服务器（没有内置集群功能）。 ² 一个第三方的早期 Dokku MCP 项目，并非官方发布。 ³ Dokploy 的核心是 Apache-2.0；另有一份 Source-Available 许可证覆盖其企业版 `proprietary/` 目录（SSO、审计日志、白标）——与 Tugra 采用的开源核心形态相同。 ⁴ CapRover 的 `LICENSE` 为 Apache-2.0，并附有一份限制修改 / 再分发付费功能的附录。 ⁵ Tugra、Coolify 和 Dokploy 都提供带有读写工具的 MCP 服务器，因此在智能体控制方面持平；Tugra 额外提供全集群操作（一次调用覆盖整个集群）、对破坏性工具的名称确认，以及机密信息脱敏。 ⁶ Dokku 不支持 Docker Swarm；它的多节点方案是 `scheduler-k3s` 插件（k3s/Kubernetes），属于不同的架构。 ⁷ Portainer 的 RBAC、SSO 和审计日志属于其付费的 Business Edition。 ⁸ Tugra 的核心免费且功能完整（团队/RBAC、审计日志、备份、监控、MCP、迁移器、多节点高可用）；SSO/OIDC 是 Pro 功能。 ⁹ 将 Coolify 的应用及其配置/环境变量作为新的 Tugra 资源导入（复制模式）；另有一个本地 Docker 接管器可就地接管同主机上的容器（保留其具名卷）。Postgres、MySQL、MariaDB、Redis、KeyDB 和 Dragonfly 的数据库**数据**可通过你在 Coolify 主机上粘贴运行的一条命令迁移器跨主机迁移；MongoDB 数据通过引导式导出再恢复（import-from-url）迁移，LibSQL 和应用**卷**数据通过 `tar`/`rsync` 迁移，而 ClickHouse 目前还没有迁移工具（[docs/coolify-migration.md](docs/coolify-migration.md)）。产品名称为其各自所有者的商标；Tugra 与它们没有任何隶属关系，也未获其认可。</sub>

## 快速开始

在一台全新的 Linux 主机上，**一条命令**即可安装前置依赖（git、Docker）、克隆仓库并启动整套服务：

```bash
curl -fsSL https://raw.githubusercontent.com/SimerayCom/tugra/main/scripts/bootstrap.sh | sh
```

<p align="center"><img src="docs/assets/install.png" alt="在全新的 Ubuntu 主机上一条命令安装 Tugra：安装前置依赖、写入配置、整套服务健康启动，并显示所有者设置码" width="840" /></p>

更想先读后跑（对任何要授予近似 root 级 Docker 访问权限的脚本来说都是明智之举）？可以自己克隆并运行安装程序——它只会写入本地 `.env` 并调用 `docker compose`，在缺少 Docker 时自动安装，并且是幂等的（可安全重复运行）：

```bash
git clone https://github.com/SimerayCom/tugra.git
cd tugra
less scripts/install.sh   # review it first
./scripts/install.sh
```

安装程序会把高强度的随机机密生成到本地 `.env` 中（重复运行会保留它们），然后通过 `docker compose` 启动 hub、Web UI、PostgreSQL 和 Redis。完成后，打开打印出的 **Web UI** 地址（`http://<host-ip>:3001`；hub/API 基础地址为 `http://<host-ip>:3000`），创建第一个账号——它将成为该实例的**所有者**。全新安装时，安装程序还会打印一个一次性的**设置码**，在创建该账号时输入即可（可通过 `grep SETUP_CODE .env` 找回）。接着按照引导向导连接你的第一台服务器。

重新运行 `./scripts/install.sh`（例如在 `git pull` 之后）是安全的——它会保留你的机密，只更新配置，因此也可以直接作为升级路径。

**生产环境（TLS + 域名）。** 为了快速上手，整套服务默认在本机端口上使用纯 HTTP；请把它放在你自己的、负责终结 TLS 的反向代理之后，并使用你的域名重新运行：

```bash
./scripts/install.sh --domain tugra.example.com
```

把绝大多数流量路由到 **web**（`:3001`）——它会替你把 REST API 和 OAuth 起始请求代理到 hub——只将 web 无法处理的路径发送到 **hub**（`:3000`）：

| 路径前缀 | → |
|---|---|
| `/agent`、`/terminal`（WebSocket）、`/install`、`/webhooks`、`/auth/oauth` | hub `:3000` |
| 其余所有路径（`/`、`/api/*`） | web `:3001` |

注意事项：

- **不内置 TLS** —— 请自带反向代理（Caddy、Traefik、nginx 等）。`--domain` 会为这种部署方式设置 `COOKIE_SECURE=true` + `HUB_TRUSTED_PROXY=true`。
- **锁定原始端口。** 当 `HUB_TRUSTED_PROXY=true` 时，hub 会信任 `X-Forwarded-For`，因此原始的 `:3000`/`:3001` 端口必须**只**对代理开放。全新的 `--domain` 安装会把它们绑定到 `127.0.0.1`（同主机代理）。如果代理运行在另一台主机上，请把 `HUB_BIND`/`WEB_BIND` 设置为本机的私有网卡 IP，并用防火墙保护这些端口——Docker 发布的端口会绕过 `ufw`。
- **“使用 GitHub 登录”** 仅在这种单一源（single-origin）代理部署下可用（hub 与 web 共享同一个公网源，会话 cookie 才能被 SPA 读取）；在普通的双端口快速开始模式下不可用。

> 已发布的镜像（`ghcr.io/simeraycom/tugra-*`）将随首个带标签的正式版本一起提供。在此之前，安装程序会自动基于你本地检出的代码构建——命令相同，无需任何改动。

**MCP 快速开始。** Tugra 启动后，创建一个个人访问令牌（**Settings → API tokens**），然后让任意 MCP 客户端指向它：

```bash
curl -s http://<web-url>/api/v1/mcp \
  -H "Authorization: Bearer $TUGRA_PAT" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize"}'
```

## 自托管与云端

上文[为什么选择 Tugra](#为什么选择-tugra)中的所有内容都**永久免费且开源**，采用 AGPL-3.0 许可证，自托管在你自己的服务器上——没有人为设置的上限，也没有等着花钱解锁的功能开关。本仓库中的社区版（Community edition）就是真正的产品，而不是被阉割的演示版。

Pro 和 Cloud 版本（SSO、审计日志导出、白标、托管控制平面）以单独的商业许可证提供。如果你需要非 AGPL 许可证，或需要社区版做不到的功能，请联系 **license@tugra.io**。

## 架构

| 组件 | 技术栈 |
|---|---|
| Hub（API + 大脑） | NestJS · PostgreSQL (Prisma) · Redis / BullMQ |
| Web | Next.js |
| Agent | Go（单个二进制文件，每台服务器一个） |
| 代理 | Traefik（自动 SSL，含 DNS-01 通配符） |

实时日志、指标和终端通过 WebSocket 推送。完整说明见 [docs/architecture.md](docs/architecture.md)。

## 路线图

**已发布**

- [x] Hub ↔ Agent 协议 + 服务器接入（主动外连 WSS · ed25519 · 签名命令 + 能力范围限定）
- [x] 从 Git / Docker Compose / 镜像部署（Nixpacks · Dockerfile · 静态站点）
- [x] 反向代理 + 自动 SSL（Traefik · Let's Encrypt，含 DNS-01 通配符）
- [x] 实时指标、构建日志与 Web 终端（WebSocket 流）
- [x] 数据库（9 种引擎），支持备份与恢复（本地 + S3/R2 异地）
- [x] 多服务器集群 + Docker Swarm 组建，跨集群批量操作
- [x] 原生 MCP 服务器——48 个工具（只读 + 受 PAT 权限范围约束的变更 / 集群运维操作）+ 引导式提示词
- [x] 应用商店——一键模板目录 + Home 模式启动器
- [x] 应用卷的只读文件浏览器（Web UI + MCP `list_files`）
- [x] 预览部署（按每个 pull request）
- [x] 可用性监控（HTTP/TCP/指标）+ 通知渠道
- [x] 定时任务（cron）· 回滚 · 资源限制与健康检查
- [x] 项目 / 环境 · 团队、角色与邀请 · 标签 · 共享变量
- [x] 公开 API（OpenAPI）+ CLI（`tugra`）
- [x] 服务器补丁（操作系统软件包更新）
- [x] 自更新（签名发布）+ 引导式上手
- [x] 迁移器——接管本地 Docker 容器 + 从 Coolify 导入（连接 · 规划 · 应用 · 回滚）+ 一条命令的跨主机数据库数据迁移（Postgres · MySQL · MariaDB · Redis · KeyDB · Dragonfly）

**下一步**

- [ ] 面向第三方客户端的 MCP OAuth（动态客户端注册、PKCE）
- [ ] 文件管理器——写入支持（上传 / 重命名 / 删除）
- [ ] ClickHouse 与 MongoDB 数据及应用卷数据的一键迁移
- [ ] 更多迁移来源（Dokploy、CapRover）
- [ ] 移动应用

## 社区与文档

- [完整文档](docs/README.md) —— 安装、架构、API、CLI、安全、开源核心模式
- [Issues](https://github.com/SimerayCom/tugra/issues) —— 缺陷报告与功能请求
- [Discussions](https://github.com/SimerayCom/tugra/discussions) —— 提问、分享想法、成果展示
- [贡献指南](CONTRIBUTING.md) · [行为准则](CODE_OF_CONDUCT.md) · [CLA](CLA.md)
- [安全政策](SECURITY.md)

## 贡献者

<a href="https://github.com/SimerayCom/tugra/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=SimerayCom/tugra" alt="贡献者" />
</a>

## 赞助者

Tugra 在公开透明中构建与维护。如果它对你或你的团队有帮助，请考虑[在 GitHub 上赞助本项目](https://github.com/sponsors/mrcandev)——目前还没有赞助者等级，所以你会是第一位，每一份支持都有助于保持开发的独立性。

## Star 历史

[![Star History Chart](https://api.star-history.com/svg?repos=SimerayCom/tugra&type=Date)](https://star-history.com/#SimerayCom/tugra&Date)

## 许可证

Tugra 采用**开源核心（open-core）**模式：

- **核心**（本仓库）—— [GNU AGPLv3](LICENSE)。可自由使用、自托管、研究和修改。如果你将修改后的版本作为网络服务运行，则必须以相同许可证公开你的修改。
- **Agent 与 CLI** —— [MIT](agent/LICENSE)。可在任何地方使用，不附带任何条件。
- **Tugra Cloud 与 Pro 功能** —— 专有，尚未公开发布（参见[自托管与云端](#自托管与云端)）。

**商业许可证：** 如果你无法遵守 AGPLv3（例如你想在 Tugra 之上构建专有产品或 SaaS 服务），可提供商业许可证。请联系 **license@tugra.io**。完整说明见 [docs/open-core.md](docs/open-core.md)。

---

<div align="center"><sub>AGPL-3.0 © Simeray Ltd — 参见 <a href="LICENSE">LICENSE</a>。</sub></div>
