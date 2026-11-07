<div align="center">

<img src="docs/assets/logo-seal.png" alt="Tugra" width="200" />

# Tugra

*Her sunucuda senin mührün.*

**Sunucu filoları ve yapay zekâ ajanları için geliştirilmiş, açık çekirdekli, self-host edilebilir PaaS.**

[![GitHub stars](https://img.shields.io/github/stars/SimerayCom/tugra?style=flat&logo=github&label=stars)](https://github.com/SimerayCom/tugra/stargazers)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue)](LICENSE)
[![Release](https://img.shields.io/github/v/release/SimerayCom/tugra?sort=semver&label=release)](https://github.com/SimerayCom/tugra/releases)
[![CI](https://img.shields.io/github/actions/workflow/status/SimerayCom/tugra/ci.yml?branch=main&label=CI)](https://github.com/SimerayCom/tugra/actions/workflows/ci.yml)
[![Image: ghcr.io](https://img.shields.io/badge/image-ghcr.io%2Fsimeraycom%2Ftugra--hub-blue?logo=docker&logoColor=white)](#hızlı-başlangıç)

[Web sitesi](https://tugra.io) · [Dokümantasyon](docs/README.md) · [Sürüm yayınlama](docs/RELEASING.md) · [Yol haritası](#yol-haritası)

[English](README.md) · **Türkçe** · [Español](README.es.md) · [Deutsch](README.de.md) · [Français](README.fr.md) · [Português](README.pt.md) · [简体中文](README.zh.md) · [日本語](README.ja.md)

</div>

---

> **Durum:** Beta. Aktif olarak geliştiriliyor; API'ler ara sürümler arasında değişebilir. Yıldızlar, issue'lar ve geri bildirimler çok değerli.

<div align="center">

<img src="docs/assets/screenshot-app-store.png" alt="Tugra App Store — kendi sunucunda çalıştırabileceğin yüzlerce uygulama şablonundan tek tıkla deploy" width="860" />

<img src="docs/assets/screenshot-dashboard.png" alt="Command Center — her ekibin uygulamaları, veritabanları ve filosu tek bakışta" width="860" />

<img src="docs/assets/screenshot-app-detail.png" alt="Uygulama detayı — her uygulama için deploy, restart, ölçekleme, loglar ve dosyalar" width="420" />&nbsp;<img src="docs/assets/screenshot-databases.png" alt="Kalıcı volume'larla tek tıkla kurulan yönetilen veritabanları" width="420" />

</div>

## Varsayılan olarak yapay zekâ ajanlarına yerel destek

Tugra, yerleşik bir [MCP](https://modelcontextprotocol.io) sunucusuyla gelir. Claude'u, Cursor'ı ya da kendi ajanını altyapına bağla; REST API ile aynı kişisel erişim token'larını, scope'ları ve audit trail'i kullanarak altyapını incelemesini, deploy etmesini, ölçeklemesini ve yönetmesini sağla. Ayrı bir entegrasyon paketine gerek yok; modele hiçbir secret değeri asla döndürülmez.

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

Bu, altta yatan REST API ile aynı `POST /api/v1/mcp` endpoint'i; kişisel erişim token'ıyla kimlik doğrulama, scope'lar ve IP allowlist de aynı. Yönetmen gereken ayrı bir kimlik bilgisi yok ve çözülmüş hiçbir secret değeri modele döndürülmez. Katalogda **48 tool** var: 26'sı salt okunur (tek çağrıda filo durumu / sağlık / uygulama listesi özetleri ve sandbox içinde çalışan bir volume dosya tarayıcısı dahil), 22'si ise PAT scope'lu, değişiklik yapan (mutate/ops) tool'lar (deploy · kuyruktaki deploy'u iptal etme · yeniden başlatma · canlı ölçekleme · rollback · env ayarlama · swarm kurma/büyütme · bir cluster genelinde filo çapında eylemler · tek tıkla alan adı DNS kurulumu). Değişiklik yapan her tool, REST API'nin ekip izin kontrollerini ve audit log'unu birebir kullanır; geri alınamayan işlemler (swarm'ı sonlandırma, uygulamayı silme) ise adı yazarak açık onay vermeyi gerektirir. Üçüncü taraf client'lar için OAuth henüz yol haritasında.

## Tugra nedir?

Tugra; uygulamaları ve veritabanlarını kendi sunucularında deploy etmek, izlemek ve işletmek için self-host edebileceğin, açık çekirdekli bir control plane'dir. Heroku, Render ya da Railway'in sunduğu gündelik deneyimi veriyor, ama altyapını başkasının bulutuna teslim etmeni gerektirmiyor. Odağı **filo**: sunucularına yayılan gerçek Docker Swarm cluster'ları (tek seferde tek sunucu yönetmenin ötesinde), filo çapında toplu işlemler ve yapay zekâ destekli operasyonlar için yerleşik bir MCP sunucusu — hepsi gerçekten okuyabileceğin bir lisansla.

## Neden Tugra

- **Tek sunucu değil, filo öncelikli** — sunucuları cluster'lar halinde grupla, aralarında gerçek bir Docker Swarm kur ve her sunucuya tek tek SSH ile bağlanmak yerine tüm filonda tek bir toplu işlem çağrısıyla aynı komutu çalıştır.
- **Yapay zekâ ajanlarına da yerel destek** — yerleşik MCP sunucusu, `POST /api/v1/mcp` üzerinden 48 tool (okuma + PAT scope'lu değişiklik yapan/filo operasyonları) sunar; erişim REST API ile aynı kişisel erişim token'larıyla scope'lanır.
- **9 veritabanı motoru, tek iş akışı** — PostgreSQL, MySQL, MariaDB, MongoDB, Redis, KeyDB, Dragonfly, ClickHouse ve LibSQL; hepsi aynı şekilde kurulur. Sekizinde yerleşik mantıksal dump/restore yedeklemesi var (dump aracı olmayan LibSQL, volume yedekleriyle kapsanır).
- **Gerçek TLS, gerçek wildcard'lar** — Traefik üzerinden uygulama başına otomatik Let's Encrypt ve cluster'lı/Swarm ingress için DNS-01 wildcard sertifikaları (`*.yourdomain.com`) — yalnızca tek alan adlı HTTP-01 değil.
- **Sunucu dışına çıkan (off-site) yedekler** — yerel diske ya da S3 uyumlu depolamaya (S3/R2/MinIO) zamanlanmış, şifreli dump'lar ve tek tıkla restore.
- **Açık çekirdek, sahte açıklık değil** — yukarıdakilerin hepsi *bu* repoda AGPL-3.0 altında ücretsiz gelir. Pro/Cloud (SSO, audit log dışa aktarma, whitelabel, multi-tenant faturalama) ayrı lisanslı bir eklentidir — buradaki hiçbir şey seni yükseltmeye zorlamaz ya da yapabileceklerini sessizce kısıtlamaz. Tugra, varsayılan olarak açık olan anonim kullanım istatistikleri gönderir. Bunlar toplu/özet sayılar (sunucu, uygulama, veritabanı, deploy) ile sürüm, edition ve işletim sistemi bilgisinden oluşur; rastgele bir kimlikle iletilir, ad, IP, alan adı ya da secret içermez ve alıcı IP adresini saklamaz. İstediğin zaman `--no-telemetry` / `TUGRA_TELEMETRY=0` ile ya da Settings'ten kapatabilirsin. Güncelleme kontrolleri ve genel IP tespiti opt-in'dir, varsayılan olarak kapalıdır.

## Tugra rakipleriyle nasıl karşılaştırılır

İnsanların gerçekten değerlendirdiği self-host edilebilir PaaS araçlarıyla yan yana bir karşılaştırma (rakip verileri 2026-10'da kontrol edildi). `✅` yerleşik · `~` kısmi / sınırlı · `—` belgelenmiş yerleşik karşılığı yok · `🔜` Tugra'nın yol haritasında. Bir hata mı fark ettin? [Issue aç](https://github.com/SimerayCom/tugra/issues).

| | **Tugra** | Coolify | Dokploy | Portainer | CapRover | Dokku |
|---|---|---|---|---|---|---|
| **Deploy ve build** | | | | | | |
| Web UI dashboard'u | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| Git'ten deploy | ✅ | ✅ | ✅ | ~ | ~ | ✅ |
| Docker Compose ile deploy | ✅ | ✅ | ✅ | ✅ | ~ | ~ |
| Preview deploy'lar (PR uygulamaları) | ✅ | ✅ | ✅ | — | — | ~ |
| Rollback'ler | ✅ | ✅ | ✅ | — | ✅ | ~ |
| App store / tek tıkla şablonlar | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| **Veri** | | | | | | |
| Yönetilen veritabanı motorları | **9** | 8 | 6 | — | — | — |
| Zamanlanmış S3 yedekleri + restore | ✅ | ✅ | ✅ | — | — | ~ |
| Uygulama Docker volume yedekleri | ✅ | — | ✅ | — | — | — |
| **Alan adları ve TLS** | | | | | | |
| Özel alan adları + otomatik SSL | ✅ | ✅ | ✅ | — | ✅ | ✅ |
| DNS-01 wildcard sertifikaları | ✅ | ~ | — | — | — | ~ |
| **Filo ve HA** | | | | | | |
| Çok düğümlü (multi-node) cluster | ✅ Swarm | Tek tek¹ | ✅ Swarm | ✅ | ✅ | ~ k3s⁶ |
| Çok yöneticili (multi-manager) Raft HA + ingress HA | ✅ | — | — | — | — | — |
| Filo çapında toplu işlemler (tek çağrı) | ✅ | — | — | — | — | — |
| İşletim sistemi yamalama (sunucu başına + filo) | ✅ | — | — | — | — | — |
| **Gözlemlenebilirlik** | | | | | | |
| Yerleşik metrikler (CPU/RAM/disk) | ✅ | ~ | ✅ | ~ | — | — |
| Uptime izleme + bildirimler | ✅ | ~ | ✅ | — | — | — |
| Uygulama / container log görüntüleyici | ✅ | ✅ | ✅ | ✅ | — | ✅ |
| **Erişim ve ajan** | | | | | | |
| Ekipler / RBAC | ✅ | ~ | ✅ | ~⁷ | — | — |
| SSO / OIDC | ✅ (Pro)⁸ | ✅ | ✅ | ~⁷ | — | — |
| Audit log | ✅ | ✅ | ✅ | ~⁷ | — | — |
| MCP / ajan kontrolü | ✅ 48 tool⁵ | ✅ | ✅ | — | — | ~² |
| **Güven ve lisans** | | | | | | |
| Telemetri | Anonim, opt-out (yalnızca sayılar) | n/a | n/a | n/a | n/a | n/a |
| Migrasyon (Coolify'dan import) | ✅⁹ | — | — | — | — | — |
| Çekirdek lisans | AGPL-3.0 | Apache-2.0 | Apache-2.0³ | zlib + BE⁷ | Apache-2.0 + ek şartlar⁴ | MIT |

<sub>¹ Coolify v4 sunucuları tek tek yönetir (yerleşik cluster desteği yok). ² Erken aşamadaki, üçüncü taraf bir Dokku MCP projesi; resmî bir sürüm değil. ³ Dokploy'un çekirdeği Apache-2.0'dır; kurumsal `proprietary/` dizinini (SSO, audit log'lar, whitelabel) ayrı bir Source-Available lisansı kapsar — Tugra'nın kullandığı açık çekirdek modelinin aynısı. ⁴ CapRover'ın `LICENSE` dosyası Apache-2.0'dır; ancak ücretli özelliklerin değiştirilmesini/yeniden dağıtılmasını kısıtlayan bir ek içerir. ⁵ Tugra, Coolify ve Dokploy'un üçü de read ve write tool'lu MCP sunucuları sunar; yani ajan kontrolünde eşitiz. Tugra buna filo çapında eylemleri (bir cluster'da tek çağrı), yıkıcı tool'larda isim onayını ve secret maskelemeyi ekler. ⁶ Dokku'nun Docker Swarm desteği yoktur; çok düğümlü seçeneği, farklı bir mimari olan `scheduler-k3s` eklentisidir (k3s/Kubernetes). ⁷ Portainer'ın RBAC, SSO ve audit log özellikleri ücretli Business Edition'ın parçasıdır. ⁸ Tugra'nın çekirdeği ücretsiz ve tam özellikli (ekipler/RBAC, audit log, yedekler, izleme, MCP, migrator, çok düğümlü HA); SSO/OIDC ise bir Pro özelliğidir. ⁹ Coolify uygulamalarını, yapılandırma/env değerleriyle birlikte yeni Tugra kaynakları olarak import eder (kopyalama modu); ayrı bir yerel Docker devralma aracı, aynı host'taki container'ları yerinde devralır (adlandırılmış volume'larını koruyarak). Postgres, MySQL, MariaDB, Redis, KeyDB ve Dragonfly için veritabanı **verisi**, Coolify host'una yapıştırdığın tek komutluk bir migrator ile host'lar arasında taşınır; MongoDB verisi rehberli bir dump-ve-restore ile (import-from-url), LibSQL ve uygulama **volume** verisi ise `tar`/`rsync` ile taşınır; ClickHouse için henüz bir migrasyon aracı yoktur ([docs/coolify-migration.md](docs/coolify-migration.md)). Ürün adları ilgili sahiplerinin ticari markalarıdır; Tugra bu ürünlerle bağlantılı değildir ve onlar tarafından onaylanmamıştır.</sub>

## Hızlı başlangıç

Yeni kurulmuş bir Linux host'unda **tek bir komut** ön koşulları (git, Docker) kurar, repoyu klonlar ve stack'i ayağa kaldırır:

```bash
curl -fsSL https://raw.githubusercontent.com/SimerayCom/tugra/main/scripts/bootstrap.sh | sh
```

<p align="center"><img src="docs/assets/install.png" alt="Yeni bir Ubuntu host'ta Tugra'nın tek komutla kurulumu: ön koşullar kuruldu, yapılandırma yazıldı, stack sağlıklı biçimde ayağa kalkıyor ve owner kurulum kodu görünüyor" width="840" /></p>

Çalıştırmadan önce okumayı mı tercih edersin (root'a yakın Docker erişimi verdiğin her script için akıllıca bir alışkanlık)? Repoyu klonla ve kurulum script'ini kendin çalıştır — yalnızca yerel bir `.env` yazar ve `docker compose` çağırır, Docker eksikse kurar ve idempotent'tir (tekrar çalıştırmak güvenlidir):

```bash
git clone https://github.com/SimerayCom/tugra.git
cd tugra
less scripts/install.sh   # review it first
./scripts/install.sh
```

Kurulum script'i güçlü secret'ları yerel bir `.env` dosyasına üretir (yeniden çalıştırınca korunurlar), ardından `docker compose` ile hub'ı, web arayüzünü, PostgreSQL'i ve Redis'i ayağa kaldırır. İş bittiğinde yazdırılan **Web UI** URL'sini (`http://<host-ip>:3001`; hub/API base URL'i `http://<host-ip>:3000`) aç ve ilk hesabı oluştur — bu hesap instance'ın **owner**'ı olur. Yeni bir kurulumda script ayrıca, o hesabı oluştururken girmen gereken tek seferlik bir **setup code** yazdırır (`grep SETUP_CODE .env` ile tekrar bulabilirsin). Ardından ilk sunucunu bağlamak için onboarding sihirbazını izle.

`./scripts/install.sh` dosyasını yeniden çalıştırmak (ör. `git pull` sonrasında) güvenlidir — secret'larını korur, yalnızca yapılandırmayı günceller; dolayısıyla aynı zamanda upgrade yolu görevi görür.

**Production (TLS + alan adı).** Stack, hızlı başlangıç için bu host'un portlarında düz HTTP sunar; onu TLS'i sonlandıran kendi reverse proxy'nin arkasına koy ve alan adınla yeniden çalıştır:

```bash
./scripts/install.sh --domain tugra.example.com
```

Trafiğin çoğunu **web**'e (`:3001`) yönlendir — REST API'yi ve OAuth başlatma isteğini senin yerine hub'a proxy'ler — ve yalnızca web'in işleyemediği yolları **hub**'a (`:3000`) ilet:

| Yol öneki | → |
|---|---|
| `/agent`, `/terminal` (WebSocket), `/install`, `/webhooks`, `/auth/oauth` | hub `:3000` |
| geri kalan her şey (`/`, `/api/*`) | web `:3001` |

Notlar:

- **TLS pakete dahil değildir** — kendi reverse proxy'ni getir (Caddy, Traefik, nginx, …). `--domain`, bu kurulum için `COOKIE_SECURE=true` + `HUB_TRUSTED_PROXY=true` ayarlar.
- **Ham portları kilitle.** `HUB_TRUSTED_PROXY=true` iken hub `X-Forwarded-For` başlığına güvenir; bu yüzden ham `:3000`/`:3001` portlarına **yalnızca** proxy erişebilmelidir. Yeni bir `--domain` kurulumu bunları `127.0.0.1`'e bağlar (aynı host'taki proxy için). Proxy başka bir host'ta çalışıyorsa `HUB_BIND`/`WEB_BIND` değerini bu makinenin private arayüz IP'sine ayarla ve portları firewall ile koru — Docker'ın publish ettiği portlar `ufw`'yi atlar.
- **"Sign in with GitHub"** yalnızca bu single-origin proxy kurulumunda çalışır (session cookie'sinin SPA tarafından görülebilmesi için hub ve web ortak bir public origin'i paylaşır); düz iki portlu hızlı başlangıçta kullanılamaz.

> Yayımlanmış image'lar (`ghcr.io/simeraycom/tugra-*`) ilk etiketli sürümle birlikte gelecek. O zamana kadar kurulum script'i, checkout'undan otomatik olarak build eder — aynı komut, hiçbir değişiklik gerekmez.

**MCP hızlı başlangıç.** Tugra ayağa kalktıktan sonra bir kişisel erişim token'ı oluştur (**Settings → API tokens**) ve herhangi bir MCP client'ını ona yönlendir:

```bash
curl -s http://<web-url>/api/v1/mcp \
  -H "Authorization: Bearer $TUGRA_PAT" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize"}'
```

## Kendi sunucunda barındırma ve bulut

Yukarıdaki [Neden Tugra](#neden-tugra) bölümündeki her şey, kendi sunucularında self-host edilmek üzere AGPL-3.0 altında **sonsuza dek ücretsiz ve açık kaynaktır** — yapay bir limit yok, para karşılığı açılmayı bekleyen bir feature flag yok. Bu repodaki Community edition gerçek ürünün kendisidir, kırpılmış bir demo değil.

Pro ve Cloud edition'ları (SSO, audit log dışa aktarma, whitelabel, managed control plane) ayrı bir ticari lisansla sunulur. AGPL dışı bir lisans için ya da Community'nin yapamadığı bir şey için **license@tugra.io** adresiyle iletişime geç.

## Mimari

| Bileşen | Teknoloji |
|---|---|
| Hub (API + merkez) | NestJS · PostgreSQL (Prisma) · Redis / BullMQ |
| Web | Next.js |
| Agent | Go (sunucu başına tek binary) |
| Proxy | Traefik (otomatik SSL, DNS-01 wildcard dahil) |

Canlı loglar, metrikler ve terminal WebSocket'ler üzerinden akar. Tüm ayrıntılar [docs/architecture.md](docs/architecture.md) içinde.

## Yol haritası

**Tamamlananlar**

- [x] Hub ↔ Agent protokolü + sunucu kaydı (dışa bağlanan WSS · ed25519 · imzalı komutlar + capability scope)
- [x] Git / Docker Compose / image'dan deploy (Nixpacks · Dockerfile · statik site)
- [x] Reverse proxy + otomatik SSL (Traefik · Let's Encrypt, DNS-01 wildcard dahil)
- [x] Canlı metrikler, build log'ları ve web terminal (WebSocket akışları)
- [x] Yedekleme ve restore destekli veritabanları (9 motor; yerel + S3/R2 off-site)
- [x] Çok sunuculu cluster'lar + Docker Swarm kurulumu, filo genelinde toplu işlemler
- [x] Yerleşik MCP sunucusu — 48 tool (okuma + PAT scope'lu değişiklik yapan/filo operasyonları) + yönlendirmeli prompt'lar
- [x] App store — tek tıkla şablon kataloğu + Home modu launcher'ı
- [x] Uygulama volume'ları için salt okunur dosya tarayıcısı (web UI + MCP `list_files`)
- [x] Preview deploy'lar (pull request başına)
- [x] Uptime izleme (HTTP/TCP/metrik) + bildirim kanalları
- [x] Zamanlanmış görevler (cron) · rollback'ler · kaynak limitleri ve health check'ler
- [x] Projeler / ortamlar · ekipler, roller ve davetler · etiketler · paylaşılan değişkenler
- [x] Public API (OpenAPI) + CLI (`tugra`)
- [x] Sunucu yamalama (işletim sistemi paket güncellemeleri)
- [x] Self-update (imzalı sürümler) + yönlendirmeli onboarding
- [x] Migrator — yerel Docker container'larını devralma + Coolify'dan import (bağlan · planla · uygula · rollback) + tek komutla host'lar arası veritabanı verisi migrasyonu (Postgres · MySQL · MariaDB · Redis · KeyDB · Dragonfly)

**Sırada**

- [ ] Üçüncü taraf client'lar için MCP OAuth (dinamik client kaydı, PKCE)
- [ ] Dosya yöneticisi — yazma desteği (yükleme / yeniden adlandırma / silme)
- [ ] ClickHouse + MongoDB verisi ve uygulama volume verisi için tek tıkla migrasyon
- [ ] Daha fazla migrasyon kaynağı (Dokploy, CapRover)
- [ ] Mobil uygulama

## Topluluk ve dokümantasyon

- [Tam dokümantasyon](docs/README.md) — kurulum, mimari, API, CLI, güvenlik, açık çekirdek
- [Issues](https://github.com/SimerayCom/tugra/issues) — hata bildirimleri ve özellik istekleri
- [Discussions](https://github.com/SimerayCom/tugra/discussions) — sorular, fikirler, yaptıklarını paylaş
- [Katkıda bulunma](CONTRIBUTING.md) · [Davranış Kuralları](CODE_OF_CONDUCT.md) · [CLA](CLA.md)
- [Güvenlik politikası](SECURITY.md)

## Katkıda bulunanlar

<a href="https://github.com/SimerayCom/tugra/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=SimerayCom/tugra" alt="Katkıda bulunanlar" />
</a>

## Sponsorlar

Tugra, açık kaynak olarak ve herkesin gözü önünde geliştiriliyor ve sürdürülüyor. Sana ya da ekibine faydalıysa [projeye GitHub'da sponsor olmayı](https://github.com/sponsors/mrcandev) düşünebilirsin — henüz bir sponsor kademesi yok, yani ilk sponsor sen olabilirsin; her destek geliştirmenin bağımsız kalmasına yardımcı olur.

## Yıldız geçmişi

[![Star History Chart](https://api.star-history.com/svg?repos=SimerayCom/tugra&type=Date)](https://star-history.com/#SimerayCom/tugra&Date)

## Lisans

Tugra, **açık çekirdek** modelini kullanır:

- **Çekirdek** (bu repo) — [GNU AGPLv3](LICENSE). Kullanması, self-host etmesi, incelemesi ve değiştirmesi ücretsiz. Değiştirilmiş bir sürümü ağ hizmeti olarak çalıştırırsan, değişikliklerini aynı lisansla paylaşmak zorundasın.
- **Agent ve CLI** — [MIT](agent/LICENSE). İstediğin yerde kullan, hiçbir şart yok.
- **Tugra Cloud ve Pro özellikleri** — kapalı kaynak, henüz yayımlanmadı ([Kendi sunucunda barındırma ve bulut](#kendi-sunucunda-barındırma-ve-bulut) bölümüne bak).

**Ticari lisans:** AGPLv3'e uyamıyorsan (ör. Tugra'nın üzerine kapalı kaynaklı ya da SaaS bir ürün kurmak istiyorsan) ticari lisans mevcut. **license@tugra.io** adresiyle iletişime geç. Tüm ayrıntılar [docs/open-core.md](docs/open-core.md) içinde.

---

<div align="center"><sub>AGPL-3.0 © Simeray Ltd — bkz. <a href="LICENSE">LICENSE</a>.</sub></div>
