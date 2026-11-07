<div align="center">

<img src="docs/assets/logo-seal.png" alt="Tugra" width="200" />

# Tugra

*すべてのサーバーに、あなたの印を。*

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

> **ステータス:** ベータ版。活発に開発中のため、マイナーリリース間で API が変更される場合があります。スター、Issue、フィードバックを心よりお待ちしています。

<div align="center">

<img src="docs/assets/screenshot-app-store.png" alt="Tugra アプリストア — 数百種類のセルフホスト向けアプリテンプレートからワンクリックでデプロイ" width="860" />

<img src="docs/assets/screenshot-dashboard.png" alt="コマンドセンター — すべてのチームのアプリ、データベース、フリートを一目で把握" width="860" />

<img src="docs/assets/screenshot-app-detail.png" alt="アプリ詳細 — アプリごとのデプロイ、再起動、スケール、ログ、ファイル" width="420" />&nbsp;<img src="docs/assets/screenshot-databases.png" alt="永続ボリューム付きのワンクリック マネージドデータベース" width="420" />

</div>

## デフォルトでエージェントネイティブ

Tugra にはネイティブの [MCP](https://modelcontextprotocol.io) サーバーが同梱されています。Claude、Cursor、または独自のエージェントをあなたのインフラに接続すれば、REST API と同じパーソナルアクセストークン、スコープ、監査証跡を使って、インフラの確認、デプロイ、スケール、運用を行えます。別途統合パッケージは不要で、シークレットの値がモデルに返されることもありません。

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

これは REST API と同じ `POST /api/v1/mcp` エンドポイントであり、基盤となる REST API と同じパーソナルアクセストークン認証、スコープ、IP 許可リストを使用します。管理すべき別の認証情報はなく、復号されたシークレット値がモデルに返されることもありません。カタログは **48 個のツール** で構成されています。26 個は読み取り専用(フリート全体のステータス / ヘルス / アプリ一覧を 1 回の呼び出しで集計するものや、サンドボックス化されたボリュームファイルブラウザを含む)で、残る 22 個は PAT スコープ付きの変更・運用ツールです(デプロイ · キュー内デプロイのキャンセル · 再起動 · ライブスケール · ロールバック · 環境変数の設定 · Swarm の形成 / 拡張 · クラスタ全体に対するフリート規模のアクション · ワンクリックのドメイン DNS 設定)。すべての変更系ツールは REST API とまったく同じチーム権限チェックと監査証跡を再利用し、元に戻せない操作(Swarm の解体、アプリの削除)には明示的な名前の確認が必要です。サードパーティクライアント向けの OAuth は引き続きロードマップに載っています。

## Tugraとは

Tugra は、自分のサーバー全体にわたってアプリとデータベースのデプロイ、監視、運用を行うための、セルフホスト可能なオープンコアのコントロールプレーンです。インフラを他社のクラウドに預けることなく、Heroku、Render、Railway のような日々の運用を実現します。中心となるのは **フリート** です。サーバー間にまたがる本物の Docker Swarm クラスタ(1 台ずつ管理するだけではありません)、フリート全体への一括操作、AI 駆動の運用のための組み込み MCP サーバーを、実際に読めるライセンスの下で提供します。

## Tugraが選ばれる理由

- **シングルボックスではなく、フリートファースト** — サーバーをクラスタにまとめ、その上に本物の Docker Swarm を形成し、各ボックスに SSH で入る代わりに、1 回の一括操作でフリート全体に 1 つのコマンドを実行できます。
- **エージェントネイティブでもある** — 組み込みの MCP サーバーが `POST /api/v1/mcp` 経由で 48 個のツール(読み取り + PAT スコープ付きの変更 / フリート操作)を公開し、REST API と同じパーソナルアクセストークンでスコープが管理されます。
- **9 種類のデータベースエンジン、1 つのワークフロー** — PostgreSQL、MySQL、MariaDB、MongoDB、Redis、KeyDB、Dragonfly、ClickHouse、LibSQL のすべてが同じ方法でプロビジョニングされます。8 種類には組み込みの論理ダンプ/リストアバックアップがあります(ダンプツールを持たない LibSQL はボリュームバックアップでカバーされます)。
- **本物の TLS、本物のワイルドカード** — Traefik 経由でアプリごとに Let's Encrypt を自動適用し、さらにクラスタ / Swarm イングレス向けに DNS-01 ワイルドカード証明書(`*.yourdomain.com`)にも対応しています。単一ドメインの HTTP-01 だけではありません。
- **建物の外へ出ていくバックアップ** — ローカルディスクまたは S3 互換ストレージ(S3/R2/MinIO)へのスケジュールダンプを暗号化して保存し、ワンクリックでリストアできます。
- **オープンコアであって、オープンウォッシュではない** — 上記のすべては、*この* リポジトリで AGPL-3.0 の下、無料で提供されます。Pro/Cloud(SSO、監査ログのエクスポート、ホワイトラベル、マルチテナント課金)は別ライセンスのアドオンです。ここにあるものが、アップグレードを迫ったり、できることをこっそり制限したりすることはありません。Tugra は匿名の利用統計を送信します(デフォルトでオン)。内容は集計された件数(サーバー、アプリ、データベース、デプロイ)と、バージョン、エディション、OS のみで、ランダムな ID に紐づきます。名前、IP、ドメイン、シークレットは含まれず、受信側があなたの IP を保存することもありません。無効化は `--no-telemetry` / `TUGRA_TELEMETRY=0` または設定画面からいつでも可能です。アップデート確認とパブリック IP 検出はオプトインで、デフォルトではオフです。

## Tugraの比較

人々が実際に検討するセルフホスト可能な PaaS ツールとの比較です(競合データの確認日: 2026-10)。`✅` 組み込み · `~` 部分的 / 制限あり · `—` 文書化された組み込みの同等機能なし · `🔜` Tugra のロードマップ上にあり。誤りを見つけた場合は [Issue を作成](https://github.com/SimerayCom/tugra/issues)してください。

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
| スケジュール S3 バックアップ + リストア | ✅ | ✅ | ✅ | — | — | ~ |
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
| 稼働監視 + 通知 | ✅ | ~ | ✅ | — | — | — |
| アプリ / コンテナのログビューア | ✅ | ✅ | ✅ | ✅ | — | ✅ |
| **アクセスとエージェント** | | | | | | |
| チーム / RBAC | ✅ | ~ | ✅ | ~⁷ | — | — |
| SSO / OIDC | ✅ (Pro)⁸ | ✅ | ✅ | ~⁷ | — | — |
| 監査ログ | ✅ | ✅ | ✅ | ~⁷ | — | — |
| MCP / エージェント制御 | ✅ 48 ツール⁵ | ✅ | ✅ | — | — | ~² |
| **信頼とライセンス** | | | | | | |
| テレメトリ | 匿名、オプトアウト式(件数のみ) | n/a | n/a | n/a | n/a | n/a |
| 移行元としての取り込み(Coolify からのインポート) | ✅⁹ | — | — | — | — | — |
| コアライセンス | AGPL-3.0 | Apache-2.0 | Apache-2.0³ | zlib + BE⁷ | Apache-2.0 + 追加条項⁴ | MIT |

<sub>¹ Coolify v4 はサーバーを個別に管理します(組み込みのクラスタリングなし)。 ² サードパーティによる初期段階の Dokku MCP プロジェクトであり、公式リリースではありません。 ³ Dokploy のコアは Apache-2.0 です。エンタープライズ向けの `proprietary/` ディレクトリ(SSO、監査ログ、ホワイトラベル)には別途 Source-Available ライセンスが適用されます。これは Tugra が採用しているものと同じオープンコアの形です。 ⁴ CapRover の `LICENSE` は Apache-2.0 であり、有料機能の改変・再配布を制限する付録が付いています。 ⁵ Tugra、Coolify、Dokploy はいずれも読み取りツールと書き込みツールを備えた MCP サーバーを提供しており、エージェント制御は同等です。Tugra はこれに加えて、フリート全体へのアクション(クラスタ全体に対する 1 回の呼び出し)、破壊的ツールでの名前確認、シークレットのマスキングを備えています。 ⁶ Dokku は Docker Swarm をサポートしていません。マルチノードの選択肢は `scheduler-k3s` プラグイン(k3s/Kubernetes)で、これは異なるアーキテクチャです。 ⁷ Portainer の RBAC、SSO、監査ログは有料の Business Edition に含まれます。 ⁸ Tugra のコアは無料でフル機能です(チーム/RBAC、監査ログ、バックアップ、監視、MCP、マイグレーター、マルチノード HA)。SSO/OIDC は Pro 機能です。 ⁹ Coolify のアプリとその設定/環境変数を、新しい Tugra リソースとしてインポートします(コピーモード)。別途ローカル Docker アダプターが、同一ホスト上のコンテナを(名前付きボリュームを維持したまま)その場で引き継ぎます。Postgres、MySQL、MariaDB、Redis、KeyDB、Dragonfly のデータベース **データ** は、Coolify ホスト上に貼り付けて実行するワンコマンドのマイグレーターでホスト間を移動します。MongoDB のデータはガイド付きのダンプ&リストア(import-from-url)で、LibSQL とアプリの **ボリューム** データは `tar`/`rsync` で移動します。ClickHouse には移行ツールがまだありません([docs/coolify-migration.md](docs/coolify-migration.md))。製品名はそれぞれの所有者の商標です。Tugra はそれらと提携しておらず、承認を受けているものでもありません。</sub>

## クイックスタート

新しい Linux ホストでは、**1 つのコマンド** で前提パッケージ(git、Docker)のインストール、リポジトリのクローン、スタックの起動までを行います。

```bash
curl -fsSL https://raw.githubusercontent.com/SimerayCom/tugra/main/scripts/bootstrap.sh | sh
```

<p align="center"><img src="docs/assets/install.png" alt="新しい Ubuntu ホストでの Tugra ワンコマンドインストール: 前提パッケージのインストール、設定の書き込み、スタックの正常な起動、オーナー用セットアップコード" width="840" /></p>

実行前に中身を読みたい場合(root に近い Docker アクセスを渡すスクリプトなら当然のことです)は、クローンしてインストーラーを自分で実行してください。インストーラーはローカルの `.env` を書き込み、`docker compose` を呼び出すだけで、Docker がなければインストールし、冪等です(再実行しても安全です)。

```bash
git clone https://github.com/SimerayCom/tugra.git
cd tugra
less scripts/install.sh   # review it first
./scripts/install.sh
```

インストーラーは強力なシークレットをローカルの `.env` に生成し(再実行しても保持されます)、`docker compose` でハブ、Web UI、PostgreSQL、Redis を起動します。完了したら、表示された **Web UI** の URL(`http://<host-ip>:3001`、ハブ/API のベースは `http://<host-ip>:3000`)を開き、最初のアカウントを作成してください。そのアカウントがインスタンスの **オーナー** になります。新規インストールでは、アカウント作成時に入力するワンタイムの **セットアップコード** もインストーラーが表示します(`grep SETUP_CODE .env` で再確認できます)。その後はオンボーディングウィザードに従って、最初のサーバーを接続してください。

`./scripts/install.sh` の再実行(たとえば `git pull` の後など)は安全です。シークレットは保持され、設定だけが更新されるため、そのままアップグレード手順としても使えます。

**本番環境(TLS + ドメイン)。** このスタックは、クイックスタート用にこのホストのポートで平文 HTTP を提供します。TLS を終端する独自のリバースプロキシの背後に置き、ドメインを指定して再実行してください。

```bash
./scripts/install.sh --domain tugra.example.com
```

ほとんどのトラフィックは **web**(`:3001`)にルーティングしてください。web が REST API と OAuth の開始をハブへ代わりにプロキシします。web で処理できないパスだけを **hub**(`:3000`)に送ります。

| パスのプレフィックス | → |
|---|---|
| `/agent`, `/terminal` (WebSocket), `/install`, `/webhooks`, `/auth/oauth` | hub `:3000` |
| それ以外すべて(`/`, `/api/*`) | web `:3001` |

注意事項:

- **TLS は同梱されていません** — 独自のリバースプロキシ(Caddy、Traefik、nginx など)を用意してください。`--domain` は、その構成向けに `COOKIE_SECURE=true` と `HUB_TRUSTED_PROXY=true` を設定します。
- **生のポートをロックダウンしてください。** `HUB_TRUSTED_PROXY=true` ではハブが `X-Forwarded-For` を信頼するため、生の `:3000`/`:3001` ポートには **プロキシだけ** が到達できる必要があります。新規の `--domain` インストールでは、これらを `127.0.0.1` にバインドします(同一ホストのプロキシ向け)。プロキシが別のホストで動作する場合は、`HUB_BIND`/`WEB_BIND` をこのマシンのプライベートインターフェースの IP に設定し、ポートをファイアウォールで保護してください。Docker が公開するポートは `ufw` を迂回します。
- **「Sign in with GitHub」** は、このシングルオリジンのプロキシ構成(ハブと web が公開オリジンを共有し、セッション Cookie が SPA から見える構成)でのみ動作します。プレーンな 2 ポートのクイックスタートでは利用できません。

> 公開イメージ(`ghcr.io/simeraycom/tugra-*`)は最初のタグ付きリリースで提供されます。それまでは、インストーラーがチェックアウトからの自動ビルドに切り替えます。コマンドは同じで、変更は不要です。

**MCP クイックスタート。** Tugra が起動したら、パーソナルアクセストークンを発行し(**Settings → API tokens**)、任意の MCP クライアントをそれに向けてください。

```bash
curl -s http://<web-url>/api/v1/mcp \
  -H "Authorization: Bearer $TUGRA_PAT" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize"}'
```

## セルフホスト vs. クラウド

上記の [Tugraが選ばれる理由](#tugraが選ばれる理由) にあるものはすべて、AGPL-3.0 の下で **永久に無料かつオープンソース** であり、あなた自身のサーバーでセルフホストできます。人為的な上限も、お金のためにいつか有効化されるフィーチャーフラグもありません。このリポジトリの Community エディションは、機能を削いだデモではなく、本物の製品です。

Pro および Cloud エディション(SSO、監査ログのエクスポート、ホワイトラベル、マネージドコントロールプレーン)は、別個の商用ライセンスで提供されます。AGPL 以外のライセンスが必要な場合や、Community ではできないことがある場合は、**license@tugra.io** までご連絡ください。

## アーキテクチャ

| コンポーネント | スタック |
|---|---|
| Hub(API + 頭脳) | NestJS · PostgreSQL (Prisma) · Redis / BullMQ |
| Web | Next.js |
| Agent | Go(サーバーごとに単一バイナリ) |
| Proxy | Traefik(自動 SSL、DNS-01 ワイルドカードを含む) |

ライブログ、メトリクス、ターミナルは WebSocket 経由でストリーミングされます。詳細な内訳は [docs/architecture.md](docs/architecture.md) をご覧ください。

## ロードマップ

**提供済み**

- [x] Hub ↔ Agent プロトコル + サーバー登録(ダイヤルアウト WSS · ed25519 · 署名付きコマンド + ケイパビリティスコープ)
- [x] Git / Docker Compose / イメージからのデプロイ(Nixpacks · Dockerfile · 静的サイト)
- [x] リバースプロキシ + 自動 SSL(Traefik · Let's Encrypt、DNS-01 ワイルドカードを含む)
- [x] ライブメトリクス、ビルドログ、Web ターミナル(WebSocket ストリーム)
- [x] バックアップとリストア付きのデータベース(9 エンジン)(ローカル + S3/R2 オフサイト)
- [x] マルチサーバークラスタ + Docker Swarm の形成、フリート全体への一括操作
- [x] ネイティブ MCP サーバー — 48 ツール(読み取り + PAT スコープ付きの変更 / フリート操作)+ ガイド付きプロンプト
- [x] アプリストア — ワンクリックのテンプレートカタログ + ホームモードランチャー
- [x] アプリボリューム向けの読み取り専用ファイルブラウザ(Web UI + MCP `list_files`)
- [x] プレビューデプロイ(プルリクエストごと)
- [x] 稼働監視(HTTP/TCP/メトリクス)+ 通知チャネル
- [x] スケジュールタスク(cron) · ロールバック · リソース制限とヘルスチェック
- [x] プロジェクト / 環境 · チーム、ロール、招待 · タグ · 共有変数
- [x] パブリック API(OpenAPI)+ CLI(`tugra`)
- [x] サーバーパッチ適用(OS パッケージの更新)
- [x] セルフアップデート(署名付きリリース)+ ガイド付きオンボーディング
- [x] マイグレーター — ローカル Docker コンテナの引き継ぎ + Coolify からのインポート(接続 · 計画 · 適用 · ロールバック)+ ワンコマンドでのホスト間 DB データ移行(Postgres · MySQL · MariaDB · Redis · KeyDB · Dragonfly)

**今後の予定**

- [ ] サードパーティクライアント向けの MCP OAuth(動的クライアント登録、PKCE)
- [ ] ファイルマネージャー — 書き込みサポート(アップロード / 名前変更 / 削除)
- [ ] ClickHouse と MongoDB のデータ、およびアプリボリュームデータのワンクリック移行
- [ ] さらなる移行元(Dokploy、CapRover)
- [ ] モバイルアプリ

## コミュニティとドキュメント

- [完全なドキュメント](docs/README.md) — インストール、アーキテクチャ、API、CLI、セキュリティ、オープンコア
- [Issues](https://github.com/SimerayCom/tugra/issues) — バグ報告と機能リクエスト
- [Discussions](https://github.com/SimerayCom/tugra/discussions) — 質問、アイデア、作ったものの共有
- [コントリビューションガイド](CONTRIBUTING.md) · [行動規範](CODE_OF_CONDUCT.md) · [CLA](CLA.md)
- [セキュリティポリシー](SECURITY.md)

## コントリビューター

<a href="https://github.com/SimerayCom/tugra/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=SimerayCom/tugra" alt="コントリビューター" />
</a>

## スポンサー

Tugra はオープンな場で構築・保守されています。あなたやあなたのチームのお役に立てているなら、[GitHub でプロジェクトをスポンサー](https://github.com/sponsors/mrcandev)することをご検討ください。スポンサーティアはまだないので、あなたが最初のスポンサーになります。ひとつひとつの支援が、開発の独立性を保つ力になります。

## スター履歴

[![Star History Chart](https://api.star-history.com/svg?repos=SimerayCom/tugra&type=Date)](https://star-history.com/#SimerayCom/tugra&Date)

## ライセンス

Tugra は **オープンコア** モデルを採用しています。

- **コア**(このリポジトリ) — [GNU AGPLv3](LICENSE)。自由に使用、セルフホスト、調査、改変できます。改変したバージョンをネットワークサービスとして運用する場合は、変更内容を同じライセンスで公開する必要があります。
- **Agent と CLI** — [MIT](agent/LICENSE)。どこでも、何の制約もなく利用できます。
- **Tugra Cloud と Pro 機能** — プロプライエタリで、まだ公開されていません([セルフホスト vs. クラウド](#セルフホスト-vs-クラウド)を参照)。

**商用ライセンス:** AGPLv3 を遵守できない場合(たとえば Tugra の上にプロプライエタリな製品や SaaS を構築したい場合)は、商用ライセンスをご用意しています。**license@tugra.io** までお問い合わせください。詳細な内訳は [docs/open-core.md](docs/open-core.md) をご覧ください。

---

<div align="center"><sub>AGPL-3.0 © Simeray Ltd — <a href="LICENSE">LICENSE</a> を参照してください。</sub></div>
