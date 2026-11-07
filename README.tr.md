<div align="center">

<img src="docs/assets/logo-seal.png" alt="Tuğra" width="200" />

# Tuğra

*Her sunucuda sizin mührünüz.*

**Fleet'ler ve yapay zekâ ajanları için geliştirilmiş, açık çekirdekli, self-host edilebilir PaaS.**

[![GitHub stars](https://img.shields.io/github/stars/SimerayCom/tugra?style=flat&logo=github&label=stars)](https://github.com/SimerayCom/tugra/stargazers)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue)](LICENSE)
[![Release](https://img.shields.io/github/v/release/SimerayCom/tugra?sort=semver&label=release)](https://github.com/SimerayCom/tugra/releases)
[![CI](https://img.shields.io/github/actions/workflow/status/SimerayCom/tugra/ci.yml?branch=main&label=CI)](https://github.com/SimerayCom/tugra/actions/workflows/ci.yml)
[![Image: ghcr.io](https://img.shields.io/badge/image-ghcr.io%2Fsimeraycom%2Ftugra--hub-blue?logo=docker&logoColor=white)](#hızlı-başlangıç)

[Web sitesi](https://tugra.io) · [Dokümanlar](docs/README.md) · [Release süreci](docs/RELEASING.md) · [Yol haritası](#yol-haritası)

[<img src="docs/assets/flags/gb.svg" width="20" alt=""> English](README.md) · <img src="docs/assets/flags/tr.svg" width="20" alt=""> **Türkçe** · [<img src="docs/assets/flags/es.svg" width="20" alt=""> Español](README.es.md) · [<img src="docs/assets/flags/de.svg" width="20" alt=""> Deutsch](README.de.md) · [<img src="docs/assets/flags/fr.svg" width="20" alt=""> Français](README.fr.md) · [<img src="docs/assets/flags/br.svg" width="20" alt=""> Português](README.pt.md) · [<img src="docs/assets/flags/cn.svg" width="20" alt=""> 简体中文](README.zh.md) · [<img src="docs/assets/flags/jp.svg" width="20" alt=""> 日本語](README.ja.md)

</div>

---

> **Durum:** Beta. Aktif olarak geliştiriliyor; API'ler ara sürümler arasında değişebilir. Yıldızlar, issue'lar ve geri bildirimler memnuniyetle karşılanır.

<div align="center">

<img src="docs/assets/screenshot-app-store.png" alt="Tuğra App Store — yüzlerce self-host uygulama şablonundan tek tıkla deploy" width="860" />

<img src="docs/assets/screenshot-dashboard.png" alt="Command Center — her ekibin uygulamaları, veritabanları ve fleet'i tek bakışta" width="860" />

<img src="docs/assets/screenshot-app-detail.png" alt="Uygulama detayı — her uygulama için deploy, yeniden başlatma, ölçekleme, log'lar ve dosyalar" width="420" />&nbsp;<img src="docs/assets/screenshot-databases.png" alt="Kalıcı volume'larla tek tıkla kurulan yönetilen veritabanları" width="420" />

</div>

## Varsayılan olarak yapay zekâ ajanlarına yerel destek

Tuğra, yerleşik bir [MCP](https://modelcontextprotocol.io) sunucusuyla gelir — Claude'u, Cursor'ı ya da kendi ajanınızı altyapınıza yönlendirerek REST API ile aynı kişisel erişim token'larını, scope'ları ve audit trail'i kullanarak altyapınızı incelemesini, deploy etmesini, ölçeklemesini ve yönetmesini sağlayabilirsiniz. Ayrı bir entegrasyon paketi gerekmez; modele hiçbir secret değeri asla döndürülmez.

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

Bu, altta yatan REST API ile aynı `POST /api/v1/mcp` endpoint'idir; aynı kişisel erişim token'ıyla kimlik doğrulama, aynı scope'lar ve aynı IP allowlist geçerlidir — yönetmeniz gereken ayrı bir kimlik bilgisi yoktur ve şifresi çözülmüş hiçbir secret değeri modele döndürülmez. Katalogda **48 tool** vardır: 26'sı salt okunurdur (tek çağrıda fleet durumu / sağlık / uygulama listesi özetleri ve sandbox içinde çalışan bir volume dosya tarayıcısı dahil), 22'si ise PAT scope'lu, değişiklik yapan (mutate/ops) tool'lardır (deploy · kuyruktaki deploy'u iptal etme · yeniden başlatma · canlı ölçekleme · rollback · env ayarlama · Swarm kurma/büyütme · bir cluster genelinde fleet çapında eylemler · tek tıkla alan adı DNS kurulumu). Değişiklik yapan her tool, REST API'nin ekip izin kontrollerini ve audit trail'ini birebir yeniden kullanır; geri alınamayan işlemler (Swarm'ı sonlandırma, uygulamayı silme) ise adı yazarak açık onay vermeyi gerektirir. Üçüncü taraf client'lar için OAuth henüz yol haritasındadır.

## Tuğra nedir?

Tuğra; uygulamaları ve veritabanlarını kendi sunucularınızda deploy etmek, izlemek ve işletmek için self-host edebileceğiniz, açık çekirdekli bir control plane'dir — Heroku, Render ya da Railway'in sunduğu gündelik deneyimi, altyapınızı başkasının bulutuna teslim etmeden sağlar. Odağı **fleet**'tir: sunucularınıza yayılan gerçek Docker Swarm cluster'ları (yalnızca tek seferde tek sunucu yönetmek değil), fleet çapında toplu işlemler ve yapay zekâ destekli operasyonlar için yerleşik bir MCP sunucusu — hepsi gerçekten okuyabileceğiniz bir lisansla.

## Neden Tuğra

- **Tek sunucu değil, fleet öncelikli** — sunucuları cluster'lar halinde gruplayın, aralarında gerçek bir Docker Swarm kurun ve her sunucuya tek tek SSH ile bağlanmak yerine tüm fleet'inizde tek bir toplu işlem çağrısıyla aynı komutu çalıştırın.
- **Yapay zekâ ajanlarına da yerel destek** — yerleşik MCP sunucusu, `POST /api/v1/mcp` üzerinden 48 tool (okuma + PAT scope'lu değişiklik yapan/fleet operasyonları) sunar; erişim REST API ile aynı kişisel erişim token'larıyla scope'lanır.
- **9 veritabanı motoru, tek iş akışı** — PostgreSQL, MySQL, MariaDB, MongoDB, Redis, KeyDB, Dragonfly, ClickHouse ve LibSQL; hepsi aynı şekilde kurulur. Sekizinde yerleşik mantıksal dump/restore backup'ı vardır (dump aracı olmayan LibSQL, volume backup'larıyla kapsanır).
- **Gerçek TLS, gerçek wildcard'lar** — Traefik üzerinden uygulama başına otomatik Let's Encrypt ve cluster'lı/Swarm ingress için DNS-01 wildcard sertifikaları (`*.yourdomain.com`) — yalnızca tek alan adlı HTTP-01 değil.
- **Sunucu dışı (off-site) backup'lar** — yerel diske ya da S3 uyumlu depolamaya (S3/R2/MinIO) zamanlanmış, şifreli dump'lar ve tek tıkla restore.
- **Açık çekirdek, sahte açıklık değil** — yukarıdakilerin hepsi *bu* repoda AGPL-3.0 altında ücretsiz gelir. Pro/Cloud (SSO, audit log dışa aktarma, whitelabel, multi-tenant faturalama) ayrı lisanslı bir eklentidir — buradaki hiçbir şey sizi durmadan yükseltmeye itmez ya da yapabileceklerinizi sessizce kısıtlamaz. Tuğra, varsayılan olarak açık olan anonim kullanım istatistikleri gönderir. Bunlar toplu/özet sayılar (sunucu, uygulama, veritabanı, deploy) ile sürüm, edition ve işletim sistemi bilgisinden oluşur; rastgele bir kimlikle iletilir, ad, IP, alan adı ya da secret içermez ve alıcı IP adresinizi saklamaz. İstediğiniz zaman `--no-telemetry` / `TUGRA_TELEMETRY=0` ile ya da Settings'ten kapatabilirsiniz. Güncelleme kontrolleri ve genel IP tespiti opt-in'dir, varsayılan olarak kapalıdır.

## Tuğra rakipleriyle nasıl kıyaslanıyor?

İnsanların gerçekten değerlendirdiği self-host edilebilir PaaS araçlarıyla yan yana bir karşılaştırma (rakip verileri 2026-10'da kontrol edildi). `✅` yerleşik · `~` kısmi / sınırlı · `—` belgelenmiş yerleşik karşılığı yok · `🔜` Tuğra'nın yol haritasında. Bir hata mı fark ettiniz? [Issue açın](https://github.com/SimerayCom/tugra/issues).

| | **Tuğra** | Coolify | Dokploy | Portainer | CapRover | Dokku |
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
| Zamanlanmış S3 backup'ları + restore | ✅ | ✅ | ✅ | — | — | ~ |
| Uygulama Docker volume backup'ları | ✅ | — | ✅ | — | — | — |
| **Alan adları ve TLS** | | | | | | |
| Özel alan adları + otomatik SSL | ✅ | ✅ | ✅ | — | ✅ | ✅ |
| DNS-01 wildcard sertifikaları | ✅ | ~ | — | — | — | ~ |
| **Fleet ve HA** | | | | | | |
| Multi-node cluster | ✅ Swarm | Tek tek¹ | ✅ Swarm | ✅ | ✅ | ~ k3s⁶ |
| Multi-manager Raft HA + ingress HA | ✅ | — | — | — | — | — |
| Fleet çapında toplu işlemler (tek çağrı) | ✅ | — | — | — | — | — |
| İşletim sistemi yamalama (sunucu başına + fleet) | ✅ | — | — | — | — | — |
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

<sub>¹ Coolify v4 sunucuları tek tek yönetir (yerleşik cluster desteği yoktur). ² Üçüncü taraf, erken aşamadaki bir Dokku MCP projesi; resmî bir sürüm değildir. ³ Dokploy'un çekirdeği Apache-2.0'dır; kurumsal `proprietary/` dizinini (SSO, audit log'lar, whitelabel) ayrı bir Source-Available lisansı kapsar — Tuğra'nın kullandığı açık çekirdek modelinin aynısı. ⁴ CapRover'ın `LICENSE` dosyası Apache-2.0'dır; ancak ücretli özelliklerin değiştirilmesini/yeniden dağıtılmasını kısıtlayan bir ek içerir. ⁵ Tuğra, Coolify ve Dokploy'un üçü de read ve write tool'lu MCP sunucuları sunar; yani ajan kontrolünde eşit düzeydedir. Tuğra buna fleet çapında eylemleri (bir cluster'da tek çağrı), yıkıcı tool'larda isim onayını ve secret redaction'ı ekler. ⁶ Dokku'nun Docker Swarm desteği yoktur; multi-node seçeneği, farklı bir mimari olan `scheduler-k3s` eklentisidir (k3s/Kubernetes). ⁷ Portainer'ın RBAC, SSO ve audit log özellikleri ücretli Business Edition'ın parçasıdır. ⁸ Tuğra'nın çekirdeği ücretsiz ve tam özellikli (ekipler/RBAC, audit log, backup'lar, izleme, MCP, migrator, multi-node HA); SSO/OIDC ise bir Pro özelliğidir. ⁹ Coolify uygulamalarını, yapılandırma/env değerleriyle birlikte yeni Tuğra kaynakları olarak import eder (kopyalama modu); ayrı bir yerel Docker devralma aracı, aynı host'taki container'ları yerinde devralır (adlandırılmış volume'larını koruyarak). Postgres, MySQL, MariaDB, Redis, KeyDB ve Dragonfly için veritabanı **verisi**, Coolify host'una yapıştırdığınız tek komutluk bir migrator ile host'lar arasında taşınır; MongoDB verisi rehberli bir dump-ve-restore ile (import-from-url), LibSQL ve uygulama **volume** verisi ise `tar`/`rsync` ile taşınır; ClickHouse için henüz bir migrasyon aracı yoktur ([docs/coolify-migration.md](docs/coolify-migration.md)). Ürün adları ilgili sahiplerinin ticari markalarıdır; Tuğra bu ürünlerle bağlantılı değildir ve onlar tarafından onaylanmamıştır.</sub>

## Hızlı başlangıç

Yeni bir Linux host'unda **tek bir komut** ön koşulları (git, Docker) kurar, repoyu klonlar ve stack'i ayağa kaldırır:

```bash
curl -fsSL https://raw.githubusercontent.com/SimerayCom/tugra/main/scripts/bootstrap.sh | sh
```

<p align="center"><img src="docs/assets/install.png" alt="Yeni bir Ubuntu host'ta Tuğra'nın tek komutla kurulumu: ön koşullar kuruldu, yapılandırma yazıldı, stack sağlıklı biçimde ayağa kalkıyor ve owner kurulum kodu görünüyor" width="840" /></p>

Çalıştırmadan önce okumayı mı tercih edersiniz (root'a yakın Docker erişimi verdiğiniz her script için mantıklı bir alışkanlık)? Repoyu klonlayın ve kurulum script'ini kendiniz çalıştırın — yalnızca yerel bir `.env` yazar ve `docker compose` çağırır, Docker eksikse kurar ve idempotent'tir (tekrar çalıştırmak güvenlidir):

```bash
git clone https://github.com/SimerayCom/tugra.git
cd tugra
less scripts/install.sh   # review it first
./scripts/install.sh
```

Kurulum script'i güçlü secret'ları yerel bir `.env` dosyasına üretir (yeniden çalıştırıldığında korunurlar), ardından `docker compose` ile hub'ı, Web UI'ı, PostgreSQL'i ve Redis'i ayağa kaldırır. İş bittiğinde yazdırılan **Web UI** URL'sini (`http://<host-ip>:3001`; hub/API base URL'i `http://<host-ip>:3000`) açın ve ilk hesabı oluşturun — bu hesap instance'ın **owner**'ı olur. Yeni bir kurulumda script ayrıca, o hesabı oluştururken girmeniz gereken tek seferlik bir **setup code** yazdırır (`grep SETUP_CODE .env` ile tekrar bulabilirsiniz). Ardından ilk sunucunuzu bağlamak için onboarding sihirbazını izleyin.

`./scripts/install.sh` dosyasını yeniden çalıştırmak (ör. `git pull` sonrasında) güvenlidir — secret'larınızı korur, yalnızca yapılandırmayı günceller; dolayısıyla aynı zamanda upgrade yolu görevi görür.

**Production (TLS + alan adı).** Stack, hızlı başlangıç için bu host'un portlarında düz HTTP sunar; onu TLS'i sonlandıran kendi reverse proxy'nizin arkasına koyun ve alan adınızla yeniden çalıştırın:

```bash
./scripts/install.sh --domain tugra.example.com
```

Trafiğin çoğunu **web**'e (`:3001`) yönlendirin — REST API'yi ve OAuth başlatma isteğini sizin yerinize hub'a proxy'ler — ve yalnızca web'in işleyemediği yolları **hub**'a (`:3000`) iletin:

| Yol öneki | → |
|---|---|
| `/agent`, `/terminal` (WebSocket), `/install`, `/webhooks`, `/auth/oauth` | hub `:3000` |
| geri kalan her şey (`/`, `/api/*`) | web `:3001` |

Notlar:

- **TLS pakete dahil değildir** — kendi reverse proxy'nizi getirin (Caddy, Traefik, nginx, …). `--domain`, bu kurulum için `COOKIE_SECURE=true` + `HUB_TRUSTED_PROXY=true` ayarlar.
- **Ham portları kilitleyin.** `HUB_TRUSTED_PROXY=true` iken hub `X-Forwarded-For` başlığına güvenir; bu yüzden ham `:3000`/`:3001` portlarına **yalnızca** proxy erişebilmelidir. Yeni bir `--domain` kurulumu bunları `127.0.0.1`'e bağlar (aynı host'taki proxy için). Proxy başka bir host'ta çalışıyorsa `HUB_BIND`/`WEB_BIND` değerini bu makinenin private arayüz IP'sine ayarlayın ve portları firewall ile koruyun — Docker'ın publish ettiği portlar `ufw`'yi atlar.
- **"Sign in with GitHub"** yalnızca bu single-origin proxy kurulumunda çalışır (session cookie'sinin SPA tarafından görülebilmesi için hub ve web ortak bir public origin'i paylaşır); düz iki portlu hızlı başlangıçta kullanılamaz.

> Yayımlanmış image'lar (`ghcr.io/simeraycom/tugra-*`) ilk etiketli sürümle birlikte gelecektir. O zamana kadar kurulum script'i, checkout'unuzdan otomatik olarak build eder — aynı komut, hiçbir değişiklik gerekmez.

**MCP hızlı başlangıç.** Tuğra ayağa kalktıktan sonra bir kişisel erişim token'ı oluşturun (**Settings → API tokens**) ve herhangi bir MCP client'ını ona yönlendirin:

```bash
curl -s http://<web-url>/api/v1/mcp \
  -H "Authorization: Bearer $TUGRA_PAT" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize"}'
```

## Kendi sunucunuzda barındırma ve bulut

Yukarıdaki [Neden Tuğra](#neden-tuğra) bölümündeki her şey, kendi sunucularınızda self-host edilmek üzere AGPL-3.0 altında **sonsuza dek ücretsiz ve açık kaynaktır** — yapay bir limit yok, para karşılığı açılmayı bekleyen bir feature flag yok. Bu repodaki Community edition gerçek ürünün kendisidir, kırpılmış bir demo değil.

Pro ve Cloud edition'ları (SSO, audit log dışa aktarma, whitelabel, managed control plane) ayrı bir ticari lisansla sunulur. AGPL dışı bir lisans için ya da Community'nin yapamadığı bir şey için **license@tugra.io** adresiyle iletişime geçin.

## Mimari

| Bileşen | Teknoloji |
|---|---|
| Hub (API + merkez) | NestJS · PostgreSQL (Prisma) · Redis / BullMQ |
| Web | Next.js |
| Agent | Go (sunucu başına tek binary) |
| Proxy | Traefik (otomatik SSL, DNS-01 wildcard dahil) |

Canlı log'lar, metrikler ve terminal WebSocket'ler üzerinden akar. Tüm ayrıntılar [docs/architecture.md](docs/architecture.md) içinde.

## Yol haritası

**Tamamlananlar**

- [x] Hub ↔ Agent protokolü + sunucu kaydı (dışa bağlanan WSS · ed25519 · imzalı komutlar + capability scope)
- [x] Git / Docker Compose / image'dan deploy (Nixpacks · Dockerfile · statik site)
- [x] Reverse proxy + otomatik SSL (Traefik · Let's Encrypt, DNS-01 wildcard dahil)
- [x] Canlı metrikler, build log'ları ve web terminal (WebSocket akışları)
- [x] Backup ve restore destekli veritabanları (9 motor; yerel + S3/R2 off-site)
- [x] Multi-server cluster'lar + Docker Swarm kurulumu, fleet genelinde toplu işlemler
- [x] Yerleşik MCP sunucusu — 48 tool (okuma + PAT scope'lu değişiklik yapan/fleet operasyonları) + yönlendirmeli prompt'lar
- [x] App store — tek tıkla şablon kataloğu + Home modu launcher'ı
- [x] Uygulama volume'ları için salt okunur dosya tarayıcısı (Web UI + MCP `list_files`)
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
- [Discussions](https://github.com/SimerayCom/tugra/discussions) — sorular, fikirler, geliştirdiklerinizi paylaşın
- [Katkıda bulunma](CONTRIBUTING.md) · [Davranış Kuralları](CODE_OF_CONDUCT.md) · [CLA](CLA.md)
- [Güvenlik politikası](SECURITY.md)

## Katkıda bulunanlar

<a href="https://github.com/SimerayCom/tugra/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=SimerayCom/tugra" alt="Katkıda bulunanlar" />
</a>

## Sponsorlar

Tuğra, herkesin gözü önünde, açık bir şekilde geliştiriliyor ve sürdürülüyor. Size ya da ekibinize faydalıysa [projeye GitHub'da sponsor olmayı](https://github.com/sponsors/mrcandev) düşünebilirsiniz — henüz bir sponsor kademesi yok, yani ilk sponsor siz olursunuz; her destek geliştirmenin bağımsız kalmasına yardımcı olur.

## Yıldız geçmişi

[![Star History Chart](https://api.star-history.com/svg?repos=SimerayCom/tugra&type=Date)](https://star-history.com/#SimerayCom/tugra&Date)

## Lisans

Tuğra, **açık çekirdek** modelini kullanır:

- **Çekirdek** (bu repo) — [GNU AGPLv3](LICENSE). Kullanımı, self-host edilmesi, incelenmesi ve değiştirilmesi ücretsizdir. Değiştirilmiş bir sürümü ağ hizmeti olarak çalıştırırsanız, değişikliklerinizi aynı lisansla paylaşmak zorundasınız.
- **Agent ve CLI** — [MIT](agent/LICENSE). İstediğiniz yerde kullanın, hiçbir şart yok.
- **Tuğra Cloud ve Pro özellikleri** — proprietary, henüz yayımlanmadı ([Kendi sunucunuzda barındırma ve bulut](#kendi-sunucunuzda-barındırma-ve-bulut) bölümüne bakın).

**Ticari lisans:** AGPLv3'e uyamıyorsanız (ör. Tuğra'nın üzerine proprietary ya da SaaS bir ürün kurmak istiyorsanız) ticari lisans mevcuttur. **license@tugra.io** adresiyle iletişime geçin. Tüm ayrıntılar [docs/open-core.md](docs/open-core.md) içinde.

---

<div align="center"><sub>AGPL-3.0 © Simeray Ltd — bkz. <a href="LICENSE">LICENSE</a>.</sub></div>
