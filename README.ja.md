<div align="center">

<img src="docs/assets/logo-seal.png" alt="Tugra" width="200" />

# Tugra

*すべてのサーバーに、あなたの印章を。*

**フリートと AI エージェントのために作られた、オープンコアでセルフホスト可能な PaaS。**

[![GitHub stars](https://img.shields.io/github/stars/SimerayCom/tugra?style=flat&logo=github&label=stars)](https://github.com/SimerayCom/tugra/stargazers)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue)](LICENSE)
[![Release](https://img.shields.io/github/v/release/SimerayCom/tugra?sort=semver&label=release)](https://github.com/SimerayCom/tugra/releases)
[![CI](https://img.shields.io/github/actions/workflow/status/SimerayCom/tugra/ci.yml?branch=main&label=CI)](https://github.com/SimerayCom/tugra/actions/workflows/ci.yml)
[![Image: ghcr.io](https://img.shields.io/badge/image-ghcr.io%2Fsimeraycom%2Ftugra--hub-blue?logo=docker&logoColor=white)](#クイックスタート)

[ウェブサイト](https://tugra.io) · [ドキュメント](docs/README.md) · [リリース手順](docs/RELEASING.md) · [ロードマップ](#ロードマップ)

[English](README.md) · [Türkçe](README.tr.md) · [Español](README.es.md) · [Deutsch](README.de.md) · [Français](README.fr.md) · [Português](README.pt.md) · [简体中文](README.zh.md) · **日本語**

</div>

---

> **ステータス:** ベータ版です。活発に開発中のため、マイナーリリース間で API が変更される場合があります。スター、Issue、フィードバックをお待ちしています。

<div align="center">

<img src="docs/assets/screenshot-app-store.png" alt="Tugra アプリストア — 数百種類のセルフホスト向けアプリテンプレートからワンクリックでデプロイ" width="860" />

<img src="docs/assets/screenshot-dashboard.png" alt="コマンドセンター — すべてのチームのアプリ、データベース、フリートを一目で把握" width="860" />

<img src="docs/assets/screenshot-app-detail.png" alt="アプリ詳細 — アプリごとのデプロイ、再起動、スケール、ログ、ファイル" width="420" />&nbsp;<img src="docs/assets/screenshot-databases.png" alt="永続ボリューム付きマネージドデータベースをワンクリックで作成" width="420" />

</div>

## デフォルトでエージェントネイティブ

Tugra にはネイティブの [MCP](https://modelcontextprotocol.io) サーバーが同梱されています。Claude、Cursor、あるいは自作のエージェントをインフラにつなぐだけで、REST API と同じパーソナルアクセストークン、スコープ、監査証跡のもとで、インフラの状態確認、デプロイ、スケール、運用を任せられます。別途インテグレーション用のパッケージは不要で、シークレットの値がモデルに返されることもありません。

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

エンドポイントは REST API と同じ `POST /api/v1/mcp` で、パーソナルアクセストークン認証、スコープ、IP 許可リストも REST API のものがそのまま使われます。別途管理する認証情報は不要で、復号されたシークレット値がモデルに返されることもありません。カタログは **48 個のツール** で構成されています。26 個は読み取り専用で(フリート全体のステータス / ヘルス / アプリ一覧を 1 回の呼び出しで集計するツールや、サンドボックス化されたボリュームのファイルブラウザーを含みます)、残る 22 個は PAT スコープ付きの変更・運用ツールです(デプロイ · キュー内デプロイのキャンセル · 再起動 · ライブスケール · ロールバック · 環境変数の設定 · Swarm の構成 / 拡張 · クラスター全体に対するフリート全体のアクション · ワンクリックでのドメイン DNS 設定)。変更系のツールはすべて、REST API とまったく同じチーム権限チェックと監査証跡を共有しており、元に戻せない操作(Swarm の解体、アプリの削除)では、対象の名前を入力する明示的な確認が必要です。サードパーティクライアント向けの OAuth は、引き続きロードマップに載っています。

## Tugra とは

Tugra は、自分たちのサーバー群にまたがってアプリとデータベースをデプロイ、監視、運用するための、セルフホスト可能なオープンコアのコントロールプレーンです。インフラを他社のクラウドに預けることなく、Heroku、Render、Railway のような日々の運用体験を手に入れられます。中心に据えているのは **フリート** です。サーバー間にまたがる本物の Docker Swarm クラスター(1 台ずつ管理するだけではありません)、フリート全体への一括操作、AI 駆動の運用に向けた組み込みの MCP サーバーを、中身を実際に読んで確認できるライセンスのもとで提供します。

## Tugra が選ばれる理由

- **単一サーバーではなく、フリートファースト** — サーバーをクラスターにまとめ、その上に本物の Docker Swarm を構成できます。各サーバーに SSH でログインして回る代わりに、1 回の一括操作でフリート全体に同じコマンドを実行できます。
- **エージェントネイティブでもある** — 組み込みの MCP サーバーが `POST /api/v1/mcp` 経由で 48 個のツール(読み取り + PAT スコープ付きの変更 / フリート操作)を公開し、REST API と同じパーソナルアクセストークンでスコープが管理されます。
- **9 種類のデータベースエンジンを、1 つのワークフローで** — PostgreSQL、MySQL、MariaDB、MongoDB、Redis、KeyDB、Dragonfly、ClickHouse、LibSQL のすべてを同じ手順でプロビジョニングできます。うち 8 種類は組み込みの論理ダンプ/リストアによるバックアップに対応しています(ダンプツールを持たない LibSQL は、ボリュームバックアップでカバーされます)。
- **本物の TLS、本物のワイルドカード** — Traefik 経由でアプリごとに Let's Encrypt 証明書を自動で適用します。さらに、クラスター / Swarm のイングレス向けに DNS-01 ワイルドカード証明書(`*.yourdomain.com`)にも対応しており、単一ドメインの HTTP-01 だけではありません。
- **オフサイトにも保管されるバックアップ** — ローカルディスクや S3 互換ストレージ(S3/R2/MinIO)へダンプをスケジュール実行し、暗号化して保存します。リストアはワンクリックです。
- **名ばかりではない、本物のオープンコア** — 上記のすべてを、*この* リポジトリで AGPL-3.0 のもと無料で提供します。Pro/Cloud(SSO、監査ログのエクスポート、ホワイトラベル、マルチテナント課金)は別ライセンスのアドオンです。ここにある機能が、アップグレードを迫ったり、できることをこっそり制限したりすることはありません。Tugra は匿名の利用統計を送信します(デフォルトでオン)。送られるのは、集計された件数(サーバー、アプリ、データベース、デプロイ)と、バージョン、エディション、OS だけで、ランダムな ID に紐づきます。名前、IP、ドメイン、シークレットは含まれず、受信側があなたの IP を保存することもありません。いつでも、`--no-telemetry` / `TUGRA_TELEMETRY=0` を指定するか、Settings から無効にできます。アップデート確認とパブリック IP の検出はオプトイン方式で、デフォルトではオフです。

## Tugra の比較

実際によく比較検討されている、セルフホスト可能な PaaS ツールとの比較です(競合データの確認日: 2026-10)。`✅` 組み込み · `~` 部分的 / 制限あり · `—` 文書化された組み込みの同等機能なし · `🔜` Tugra のロードマップ上にあり。誤りを見つけたら、[Issue でお知らせください](https://github.com/SimerayCom/tugra/issues)。

| | **Tugra** | Coolify | Dokploy | Portainer | CapRover | Dokku |
|---|---|---|---|---|---|---|
| **デプロイとビルド** | | | | | | |
| Web UI ダッシュボード | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| Git からのデプロイ | ✅ | ✅ | ✅ | ~ | ~ | ✅ |
| Docker Compose デプロイ | ✅ | ✅ | ✅ | ✅ | ~ | ~ |
| プレビューデプロイ(PR アプリ) | ✅ | ✅ | ✅ | — | — | ~ |
| ロールバック | ✅ | ✅ | ✅ | — | ✅ | ~ |
| アプリストア / ワンクリックテンプレート | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| **データ** | | | | | | |
| マネージドデータベースエンジン | **9** | 8 | 6 | — | — | — |
| スケジュール実行の S3 バックアップ + リストア | ✅ | ✅ | ✅ | — | — | ~ |
| アプリの Docker ボリュームバックアップ | ✅ | — | ✅ | — | — | — |
| **ドメインと TLS** | | | | | | |
| カスタムドメイン + 自動 SSL | ✅ | ✅ | ✅ | — | ✅ | ✅ |
| DNS-01 ワイルドカード証明書 | ✅ | ~ | — | — | — | ~ |
| **フリートと HA** | | | | | | |
| マルチノードクラスタリング | ✅ Swarm | 個別¹ | ✅ Swarm | ✅ | ✅ | ~ k3s⁶ |
| マルチマネージャー Raft HA + イングレス HA | ✅ | — | — | — | — | — |
| フリート全体への一括操作(1 回の呼び出し) | ✅ | — | — | — | — | — |
| OS パッチ適用(サーバー単位 + フリート) | ✅ | — | — | — | — | — |
| **オブザーバビリティ** | | | | | | |
| 組み込みメトリクス(CPU/RAM/ディスク) | ✅ | ~ | ✅ | ~ | — | — |
| 死活監視 + 通知 | ✅ | ~ | ✅ | — | — | — |
| アプリ / コンテナのログビューアー | ✅ | ✅ | ✅ | ✅ | — | ✅ |
| **アクセスとエージェント** | | | | | | |
| チーム / RBAC | ✅ | ~ | ✅ | ~⁷ | — | — |
| SSO / OIDC | ✅ (Pro)⁸ | ✅ | ✅ | ~⁷ | — | — |
| 監査ログ | ✅ | ✅ | ✅ | ~⁷ | — | — |
| MCP / エージェント制御 | ✅ 48 ツール⁵ | ✅ | ✅ | — | — | ~² |
| **信頼とライセンス** | | | | | | |
| テレメトリ | 匿名、オプトアウト方式(件数のみ) | n/a | n/a | n/a | n/a | n/a |
| 他ツールからの移行(Coolify からのインポート) | ✅⁹ | — | — | — | — | — |
| コアライセンス | AGPL-3.0 | Apache-2.0 | Apache-2.0³ | zlib + BE⁷ | Apache-2.0 + 追加条項⁴ | MIT |

<sub>¹ Coolify v4 はサーバーを個別に管理します(組み込みのクラスタリングはありません)。 ² サードパーティによる初期段階の Dokku MCP プロジェクトであり、公式リリースではありません。 ³ Dokploy のコアは Apache-2.0 です。エンタープライズ向けの `proprietary/` ディレクトリ(SSO、監査ログ、ホワイトラベル)には、別途 Source-Available ライセンスが適用されます。これは Tugra が採用しているものと同じオープンコアの形です。 ⁴ CapRover の `LICENSE` は Apache-2.0 ですが、有料機能の改変・再配布を制限する付録が付いています。 ⁵ Tugra、Coolify、Dokploy はいずれも、読み取りツールと書き込みツールを備えた MCP サーバーを提供しているため、エージェント制御の面では同等です。Tugra はこれに加えて、フリート全体へのアクション(クラスター全体に対する 1 回の呼び出し)、破壊的なツールでの名前確認、シークレットのマスキングを備えています。 ⁶ Dokku は Docker Swarm をサポートしていません。マルチノードの選択肢は `scheduler-k3s` プラグイン(k3s/Kubernetes)で、これはアーキテクチャが異なります。 ⁷ Portainer の RBAC、SSO、監査ログは、有料の Business Edition に含まれます。 ⁸ Tugra のコアは無料でフル機能です(チーム/RBAC、監査ログ、バックアップ、監視、MCP、マイグレーター、マルチノード HA)。SSO/OIDC は Pro 機能です。 ⁹ Coolify のアプリと、その設定・環境変数を、新しい Tugra リソースとしてインポートします(コピーモード)。これとは別に、ローカル Docker の引き継ぎ機能(adopter)が、同一ホスト上のコンテナを名前付きボリュームごとそのまま引き継ぎます。Postgres、MySQL、MariaDB、Redis、KeyDB、Dragonfly のデータベース **データ** は、Coolify ホスト上に貼り付けて実行するワンコマンドのマイグレーターで、ホスト間を移行できます。MongoDB のデータはガイド付きのダンプ&リストア(import-from-url)で、LibSQL とアプリの **ボリューム** データは `tar`/`rsync` で移行します。ClickHouse の移行ツールはまだありません([docs/coolify-migration.md](docs/coolify-migration.md))。製品名はそれぞれの所有者の商標です。Tugra はこれらの製品・企業とは提携関係になく、公認を受けているものでもありません。</sub>

## クイックスタート

新しい Linux ホストなら、**コマンド 1 つ** で前提ツール(git、Docker)のインストール、リポジトリのクローン、スタックの起動までが完了します。

```bash
curl -fsSL https://raw.githubusercontent.com/SimerayCom/tugra/main/scripts/bootstrap.sh | sh
```

<p align="center"><img src="docs/assets/install.png" alt="新しい Ubuntu ホストでの Tugra ワンコマンドインストール: 前提ツールのインストール、設定の書き込み、スタックの正常な起動、オーナー用セットアップコード" width="840" /></p>

実行前に中身を確認したい場合(実質 root に近い Docker 権限を渡すスクリプトなら、当然の心がけです)は、リポジトリをクローンしてインストーラーを自分で実行してください。インストーラーがすることは、ローカルの `.env` の書き込みと `docker compose` の呼び出しだけです。Docker が未導入ならインストールし、冪等なので何度再実行しても安全です。

```bash
git clone https://github.com/SimerayCom/tugra.git
cd tugra
less scripts/install.sh   # review it first
./scripts/install.sh
```

インストーラーは推測されにくい強力なシークレットをローカルの `.env` に生成し(再実行しても保持されます)、`docker compose` で Hub、Web UI、PostgreSQL、Redis を起動します。完了したら、表示された **Web UI** の URL(`http://<host-ip>:3001`。Hub / API のベース URL は `http://<host-ip>:3000`)を開き、最初のアカウントを作成してください。そのアカウントがインスタンスの **オーナー** になります。新規インストールでは、アカウント作成時に入力するワンタイムの **セットアップコード** もインストーラーが表示します(`grep SETUP_CODE .env` で再確認できます)。その後は、オンボーディングウィザードに従って最初のサーバーを接続してください。

`./scripts/install.sh` は、たとえば `git pull` の後などに再実行しても安全です。シークレットは保持されたまま設定だけが更新されるため、そのままアップグレード手順としても使えます。

**本番環境(TLS + ドメイン)。** クイックスタートの状態では、このスタックはホストのポートで平文の HTTP を提供します。TLS を終端するリバースプロキシを前段に置き、ドメインを指定して再実行してください。

```bash
./scripts/install.sh --domain tugra.example.com
```

トラフィックの大半は **web**(`:3001`)にルーティングしてください。REST API と OAuth の開始リクエストは、web が hub にプロキシします。web で処理できないパスだけを **hub**(`:3000`)に振り分けます。

| パスのプレフィックス | → |
|---|---|
| `/agent`, `/terminal` (WebSocket), `/install`, `/webhooks`, `/auth/oauth` | hub `:3000` |
| それ以外すべて(`/`, `/api/*`) | web `:3001` |

注意事項:

- **TLS は同梱されていません** — Caddy、Traefik、nginx などのリバースプロキシを各自で用意してください。`--domain` を指定すると、この構成に合わせて `COOKIE_SECURE=true` と `HUB_TRUSTED_PROXY=true` が設定されます。
- **直接アクセス用のポートへの接続を制限してください。** `HUB_TRUSTED_PROXY=true` では Hub が `X-Forwarded-For` を信頼するため、`:3000`/`:3001` の各ポートには **プロキシからのみ** 到達できる状態にする必要があります。新規の `--domain` インストールでは、これらを `127.0.0.1` にバインドします(同一ホストのプロキシ向け)。プロキシが別のホストで動いている場合は、`HUB_BIND`/`WEB_BIND` をこのマシンのプライベートインターフェースの IP に設定し、ファイアウォールでポートを制限してください。Docker が公開したポートは `ufw` のルールを迂回します。
- **「Sign in with GitHub」** が使えるのは、このシングルオリジンのプロキシ構成(Hub と web が公開オリジンを共有し、セッション Cookie が SPA から見える構成)に限られます。プレーンな 2 ポートのクイックスタートでは利用できません。

> 公開イメージ(`ghcr.io/simeraycom/tugra-*`)は、最初のタグ付きリリースとともに公開されます。それまでは、インストーラーが手元のチェックアウトから自動的にビルドします。コマンドは同じで、何も変更する必要はありません。

**MCP クイックスタート。** Tugra が起動したら、パーソナルアクセストークンを発行し(**Settings → API tokens**)、任意の MCP クライアントからそのトークンで接続してください。

```bash
curl -s http://<web-url>/api/v1/mcp \
  -H "Authorization: Bearer $TUGRA_PAT" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize"}'
```

## セルフホスト vs. クラウド

上記の [Tugra が選ばれる理由](#tugra-が選ばれる理由) に挙げた機能はすべて、AGPL-3.0 のもとで **永久に無料かつオープンソース** であり、自分のサーバーでセルフホストできます。人為的な上限も、お金のためにいつか有効化されるフィーチャーフラグもありません。このリポジトリの Community エディションは、機能を削ったデモ版ではなく、本物の製品です。

Pro および Cloud エディション(SSO、監査ログのエクスポート、ホワイトラベル、マネージドコントロールプレーン)は、別途、商用ライセンスで提供しています。AGPL 以外のライセンスが必要な場合や、Community ではできないことがある場合は、**license@tugra.io** までご連絡ください。

## アーキテクチャ

| コンポーネント | スタック |
|---|---|
| Hub(API + 制御の中枢) | NestJS · PostgreSQL (Prisma) · Redis / BullMQ |
| Web | Next.js |
| Agent | Go(サーバーごとに単一バイナリ) |
| Proxy | Traefik(自動 SSL、DNS-01 ワイルドカードを含む) |

リアルタイムのログ、メトリクス、ターミナルは WebSocket でストリーミングされます。詳しい構成は [docs/architecture.md](docs/architecture.md) をご覧ください。

## ロードマップ

**リリース済み**

- [x] Hub ↔ Agent プロトコル + サーバー登録(Agent 発のアウトバウンド WSS · ed25519 · 署名付きコマンド + ケイパビリティスコープ)
- [x] Git / Docker Compose / イメージからのデプロイ(Nixpacks · Dockerfile · 静的サイト)
- [x] リバースプロキシ + 自動 SSL(Traefik · Let's Encrypt、DNS-01 ワイルドカードを含む)
- [x] ライブメトリクス、ビルドログ、Web ターミナル(WebSocket ストリーム)
- [x] データベース(9 エンジン)とバックアップ / リストア(ローカル + S3/R2 へのオフサイト保存)
- [x] マルチサーバークラスター + Docker Swarm の構成、フリート全体への一括操作
- [x] ネイティブ MCP サーバー — 48 ツール(読み取り + PAT スコープ付きの変更 / フリート操作)+ ガイド付きプロンプト
- [x] アプリストア — ワンクリックのテンプレートカタログ + ホームモードランチャー
- [x] アプリのボリューム向け読み取り専用ファイルブラウザー(Web UI + MCP `list_files`)
- [x] プレビューデプロイ(プルリクエストごと)
- [x] 死活監視(HTTP/TCP/メトリクス)+ 通知チャネル
- [x] スケジュールタスク(cron) · ロールバック · リソース制限とヘルスチェック
- [x] プロジェクト / 環境 · チーム、ロール、招待 · タグ · 共有変数
- [x] パブリック API(OpenAPI)+ CLI(`tugra`)
- [x] サーバーのパッチ適用(OS パッケージの更新)
- [x] セルフアップデート(署名付きリリース)+ ガイド付きオンボーディング
- [x] マイグレーター — ローカル Docker コンテナの引き継ぎ + Coolify からのインポート(接続 · 計画 · 適用 · ロールバック)+ ワンコマンドでのホスト間 DB データ移行(Postgres · MySQL · MariaDB · Redis · KeyDB · Dragonfly)

**今後の予定**

- [ ] サードパーティクライアント向けの MCP OAuth(動的クライアント登録、PKCE)
- [ ] ファイルマネージャーの書き込み対応(アップロード / 名前変更 / 削除)
- [ ] ClickHouse と MongoDB のデータ、およびアプリのボリュームデータのワンクリック移行
- [ ] 移行元の追加(Dokploy、CapRover)
- [ ] モバイルアプリ

## コミュニティとドキュメント

- [完全なドキュメント](docs/README.md) — インストール、アーキテクチャ、API、CLI、セキュリティ、オープンコア
- [Issues](https://github.com/SimerayCom/tugra/issues) — バグ報告と機能リクエスト
- [Discussions](https://github.com/SimerayCom/tugra/discussions) — 質問、アイデア、作ったものの紹介
- [コントリビューションガイド](CONTRIBUTING.md) · [行動規範](CODE_OF_CONDUCT.md) · [CLA](CLA.md)
- [セキュリティポリシー](SECURITY.md)

## コントリビューター

<a href="https://github.com/SimerayCom/tugra/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=SimerayCom/tugra" alt="コントリビューター" />
</a>

## スポンサー

Tugra はオープンな場で開発・保守されています。あなたやあなたのチームのお役に立てているなら、[GitHub でプロジェクトをスポンサー](https://github.com/sponsors/mrcandev)することをご検討ください。スポンサーティアはまだないので、あなたが最初のスポンサーになります。ひとつひとつの支援が、開発の独立性を保つ力になります。

## スター履歴

[![Star History Chart](https://api.star-history.com/svg?repos=SimerayCom/tugra&type=Date)](https://star-history.com/#SimerayCom/tugra&Date)

## ライセンス

Tugra は **オープンコア** モデルを採用しています。

- **コア**(このリポジトリ) — [GNU AGPLv3](LICENSE)。自由に使用、セルフホスト、調査、改変できます。改変したバージョンをネットワークサービスとして運用する場合は、変更内容を同じライセンスで公開する必要があります。
- **Agent と CLI** — [MIT](agent/LICENSE)。どこでも、何の制約もなく利用できます。
- **Tugra Cloud と Pro 機能** — プロプライエタリで、まだ公開されていません([セルフホスト vs. クラウド](#セルフホスト-vs-クラウド)を参照)。

**商用ライセンス:** AGPLv3 を遵守できない場合(たとえば Tugra の上にプロプライエタリな製品や SaaS を構築したい場合)は、商用ライセンスをご用意しています。**license@tugra.io** までお問い合わせください。詳しい内訳は [docs/open-core.md](docs/open-core.md) をご覧ください。

---

<div align="center"><sub>AGPL-3.0 © Simeray Ltd — <a href="LICENSE">LICENSE</a> を参照してください。</sub></div>
