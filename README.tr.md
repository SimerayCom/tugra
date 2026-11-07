<div align="center">

<img src="docs/assets/logo-seal.png" alt="Tugra" width="200" />

# Tugra

*Her sunucuda senin mührün.*

**Filolar ve yapay zekâ ajanları için geliştirilmiş, açık çekirdekli, kendi sunucunda barındırılabilen PaaS.**

[![GitHub stars](https://img.shields.io/github/stars/SimerayCom/tugra?style=flat&logo=github&label=stars)](https://github.com/SimerayCom/tugra/stargazers)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue)](LICENSE)
[![Release](https://img.shields.io/github/v/release/SimerayCom/tugra?sort=semver&label=release)](https://github.com/SimerayCom/tugra/releases)
[![CI](https://img.shields.io/github/actions/workflow/status/SimerayCom/tugra/ci.yml?branch=main&label=CI)](https://github.com/SimerayCom/tugra/actions/workflows/ci.yml)
[![Image: ghcr.io](https://img.shields.io/badge/image-ghcr.io%2Fsimeraycom%2Ftugra--hub-blue?logo=docker&logoColor=white)](#hızlı-başlangıç)

[Web sitesi](https://tugra.io) · [Dokümantasyon](docs/README.md) · [Sürüm yayınlama](docs/RELEASING.md) · [Yol haritası](#yol-haritası)

[English](README.md) · **Türkçe** · [Español](README.es.md) · [Deutsch](README.de.md) · [Français](README.fr.md) · [Português](README.pt.md) · [简体中文](README.zh.md) · [日本語](README.ja.md)

</div>

---

> **Durum:** Beta. Aktif olarak geliştiriliyor; API'ler minör sürümler arasında değişebilir. Yıldızlar, issue'lar ve geri bildirimler çok değerli.

<div align="center">

<img src="docs/assets/screenshot-app-store.png" alt="Tugra Uygulama Mağazası — yüzlerce kendi sunucunda barındırılabilen uygulama şablonundan tek tıkla dağıtım" width="860" />

<img src="docs/assets/screenshot-dashboard.png" alt="Komuta Merkezi — her ekibin uygulamaları, veritabanları ve filosu tek bakışta" width="860" />

<img src="docs/assets/screenshot-app-detail.png" alt="Uygulama detayı — uygulama başına dağıtım, yeniden başlatma, ölçekleme, loglar ve dosyalar" width="420" />&nbsp;<img src="docs/assets/screenshot-databases.png" alt="Kalıcı disklerle tek tıkla yönetilen veritabanları" width="420" />

</div>

## Varsayılan olarak ajan odaklı

Tugra, yerleşik bir [MCP](https://modelcontextprotocol.io) sunucusuyla gelir — Claude'u, Cursor'ı veya kendi ajanını altyapına yönlendir; REST API ile aynı kişisel erişim token'larını, kapsamları ve denetim kaydını kullanarak altyapını incelesin, dağıtsın, ölçeklesin ve yönetsin. Ayrı bir entegrasyon paketi yok, modele hiçbir gizli değer asla geri döndürülmez.

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

Altta yatan REST API ile aynı `POST /api/v1/mcp` uç noktası, aynı kişisel erişim token'ı doğrulaması, kapsamlar ve IP izin listesi söz konusu — yönetilecek ayrı bir kimlik bilgisi yok ve çözülmüş hiçbir gizli değer modele geri döndürülmez. Katalog **48 araçtan** oluşur: 26'sı salt okunur (tek çağrıda filo durumu / sağlık / uygulama listesi özetleri ve korumalı alanda çalışan bir disk dosya tarayıcısı dahil) ve 22'si PAT kapsamlı değiştirme/operasyon aracı (dağıtım · kuyruktaki dağıtımı iptal etme · yeniden başlatma · canlı ölçekleme · geri alma · env ayarlama · swarm oluşturma/büyütme · bir kümede filo çapında eylemler · tek tıkla alan adı DNS kurulumu). Her değiştirme aracı REST API'nin tam ekip izin kontrollerini ve denetim kaydını yeniden kullanır; geri alınamaz olanlar (bir swarm'ı dağıtma, bir uygulamayı kaldırma) açık bir ad onayı gerektirir. Üçüncü taraf istemciler için OAuth hâlâ yol haritasında.

## Tugra nedir?

Tugra; uygulamaları ve veritabanlarını kendi sunucularında dağıtmak, izlemek ve işletmek için kendi sunucunda barındırılabilen, açık çekirdekli bir kontrol düzlemidir — Heroku, Render veya Railway'in gündelik işlevleri, altyapını başkasının bulutuna teslim etmeden. Odağı **filodur**: sunucuların arasında gerçek Docker Swarm kümeleri (yalnızca tek tek kutu yönetimi değil), filo çapında toplu işlemler ve yapay zekâ destekli operasyonlar için yerleşik bir MCP sunucusu — hepsi gerçekten okuyabileceğin bir lisans altında.

## Neden Tugra

- **Önce filo, tek kutu değil** — sunucuları kümelere grupla, aralarında gerçek bir Docker Swarm oluştur ve her kutuya tek tek SSH ile bağlanmak yerine tüm filonda tek bir toplu işlem çağrısıyla tek bir komut çalıştır.
- **Ajan odaklı da** — yerleşik bir MCP sunucusu, `POST /api/v1/mcp` üzerinden 48 araç (okuma + PAT kapsamlı değiştirme/filo operasyonları) sunar ve REST API ile aynı kişisel erişim token'larıyla kapsamlandırılır.
- **9 veritabanı motoru, tek iş akışı** — PostgreSQL, MySQL, MariaDB, MongoDB, Redis, KeyDB, Dragonfly, ClickHouse ve LibSQL, hepsi aynı şekilde kurulur; sekizinde yerleşik mantıksal dump/restore yedekleri vardır (dump aracı olmayan LibSQL, disk yedekleriyle kapsanır).
- **Gerçek TLS, gerçek wildcard'lar** — Traefik üzerinden uygulama başına otomatik Let's Encrypt ve kümelenmiş/Swarm ingress için DNS-01 wildcard sertifikaları (`*.yourdomain.com`) — yalnızca tek alan adlı HTTP-01 değil.
- **Binanın dışına çıkan yedekler** — yerel diske veya S3 uyumlu depolamaya (S3/R2/MinIO) zamanlanmış, şifreli dump'lar ve tek tıkla geri yükleme.
- **Açık çekirdekli, göstermelik açık değil** — yukarıdakilerin hepsi *bu* depoda AGPL-3.0 altında ücretsiz gelir. Pro/Cloud (SSO, denetim kaydı dışa aktarma, whitelabel, çok kiracılı faturalama) ayrı lisanslı bir eklentidir — buradaki hiçbir şey seni yükseltmeye zorlamaz ya da yapabileceklerini sessizce kısıtlamaz. Tugra varsayılan olarak açık olan anonim kullanım istatistikleri gönderir — toplu sayılar (sunucular, uygulamalar, veritabanları, dağıtımlar) ile sürümün, edisyonun ve işletim sistemin, rastgele bir kimlik altında; ad, IP, alan adı veya gizli değer yok ve alıcı IP'ni saklamaz — bunları istediğin zaman `--no-telemetry` / `TUGRA_TELEMETRY=0` ile ya da Ayarlar'dan kapatabilirsin. Güncelleme kontrolleri ve genel IP tespiti isteğe bağlıdır ve varsayılan olarak kapalıdır.

## Tugra rakiplerle nasıl kıyaslanır

İnsanların gerçekten değerlendirdiği, kendi sunucunda barındırılabilen PaaS araçlarıyla yan yana bir karşılaştırma (rakip verileri 2026-10'da kontrol edildi). `✅` yerleşik · `~` kısmi / sınırlı · `—` belgelenmiş yerleşik karşılığı yok · `🔜` Tugra'nın yol haritasında. Bir hata mı gördün? [Bir issue aç](https://github.com/SimerayCom/tugra/issues).

| | **Tugra** | Coolify | Dokploy | Portainer | CapRover | Dokku |
|---|---|---|---|---|---|---|
| **Dağıtım ve derleme** | | | | | | |
| Web arayüzü paneli | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| Git'ten dağıtım | ✅ | ✅ | ✅ | ~ | ~ | ✅ |
| Docker Compose ile dağıtım | ✅ | ✅ | ✅ | ✅ | ~ | ~ |
| Önizleme dağıtımları (PR uygulamaları) | ✅ | ✅ | ✅ | — | — | ~ |
| Geri almalar | ✅ | ✅ | ✅ | — | ✅ | ~ |
| Uygulama mağazası / tek tıkla şablonlar | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| **Veri** | | | | | | |
| Yönetilen veritabanı motorları | **9** | 8 | 6 | — | — | — |
| Zamanlanmış S3 yedekleri + geri yükleme | ✅ | ✅ | ✅ | — | — | ~ |
| Uygulama Docker disk yedekleri | ✅ | — | ✅ | — | — | — |
| **Alan adları ve TLS** | | | | | | |
| Özel alan adları + otomatik SSL | ✅ | ✅ | ✅ | — | ✅ | ✅ |
| DNS-01 wildcard sertifikaları | ✅ | ~ | — | — | — | ~ |
| **Filo ve HA** | | | | | | |
| Çok düğümlü kümeleme | ✅ Swarm | Tekil¹ | ✅ Swarm | ✅ | ✅ | ~ k3s⁶ |
| Çok yöneticili Raft HA + ingress HA | ✅ | — | — | — | — | — |
| Filo çapında toplu işlemler (tek çağrı) | ✅ | — | — | — | — | — |
| İşletim sistemi yamalama (sunucu başına + filo) | ✅ | — | — | — | — | — |
| **Gözlemlenebilirlik** | | | | | | |
| Yerleşik metrikler (CPU/RAM/disk) | ✅ | ~ | ✅ | ~ | — | — |
| Çalışma süresi izleyicileri + bildirimler | ✅ | ~ | ✅ | — | — | — |
| Uygulama / konteyner log görüntüleyici | ✅ | ✅ | ✅ | ✅ | — | ✅ |
| **Erişim ve ajan** | | | | | | |
| Ekipler / RBAC | ✅ | ~ | ✅ | ~⁷ | — | — |
| SSO / OIDC | ✅ (Pro)⁸ | ✅ | ✅ | ~⁷ | — | — |
| Denetim kaydı | ✅ | ✅ | ✅ | ~⁷ | — | — |
| MCP / ajan kontrolü | ✅ 48 araç⁵ | ✅ | ✅ | — | — | ~² |
| **Güven ve lisans** | | | | | | |
| Telemetri | Anonim, vazgeçilebilir (yalnızca sayılar) | n/a | n/a | n/a | n/a | n/a |
| İçe taşıma (Coolify'dan içe aktarma) | ✅⁹ | — | — | — | — | — |
| Çekirdek lisans | AGPL-3.0 | Apache-2.0 | Apache-2.0³ | zlib + BE⁷ | Apache-2.0 + şartlar⁴ | MIT |

<sub>¹ Coolify v4 sunucuları tek tek yönetir (yerleşik kümeleme yok). ² Resmî bir sürüm değil, üçüncü taraf, erken aşamada bir Dokku MCP projesi. ³ Dokploy'un çekirdeği Apache-2.0'dır; ayrı bir Source-Available lisansı kurumsal `proprietary/` dizinini (SSO, denetim kayıtları, whitelabel) kapsar — Tugra'nın kullandığı aynı açık çekirdek biçimi. ⁴ CapRover'ın `LICENSE` dosyası Apache-2.0'dır ve ücretli özelliklerin değiştirilmesini/yeniden dağıtılmasını kısıtlayan bir ek içerir. ⁵ Tugra, Coolify ve Dokploy'un üçü de okuma ve yazma araçlı MCP sunucuları sunar, dolayısıyla ajan kontrolünde eşitlik vardır; Tugra buna filo çapında eylemler (bir kümede tek çağrı), yıkıcı araçlarda ad onayı ve gizli değer maskeleme ekler. ⁶ Dokku'da Docker Swarm desteği yoktur; çok düğümlü seçeneği farklı bir mimari olan `scheduler-k3s` eklentisidir (k3s/Kubernetes). ⁷ Portainer'ın RBAC, SSO ve denetim kayıtları ücretli Business Edition'ın parçasıdır. ⁸ Tugra'nın çekirdeği ücretsiz ve tam özelliklidir (ekipler/RBAC, denetim kaydı, yedekler, izleme, MCP, migrator, çok düğümlü HA); SSO/OIDC bir Pro özelliğidir. ⁹ Coolify uygulamalarını ve yapılandırmalarını/env değerlerini yeni Tugra kaynakları olarak içe aktarır (kopyalama modu); ayrı bir yerel Docker benimseyicisi aynı ana makinedeki konteynerleri yerinde devralır (adlandırılmış disklerini koruyarak). Postgres, MySQL, MariaDB, Redis, KeyDB ve Dragonfly için veritabanı **verisi**, Coolify ana makinesine yapıştırdığın tek komutluk bir migrator ile ana makineler arasında taşınır; MongoDB verisi rehberli bir dump-ve-restore ile (import-from-url), LibSQL ve uygulama **disk** verisi `tar`/`rsync` ile taşınır ve ClickHouse için henüz bir taşıma aracı yoktur ([docs/coolify-migration.md](docs/coolify-migration.md)). Ürün adları ilgili sahiplerinin ticari markalarıdır; Tugra onlarla bağlantılı değildir ve onlar tarafından onaylanmamıştır.</sub>

## Hızlı başlangıç

Yeni bir Linux ana makinesinde **tek bir komut** ön koşulları (git, Docker) kurar, depoyu klonlar ve yığını ayağa kaldırır:

```bash
curl -fsSL https://raw.githubusercontent.com/SimerayCom/tugra/main/scripts/bootstrap.sh | sh
```

<p align="center"><img src="docs/assets/install.png" alt="Yeni bir Ubuntu ana makinesinde Tugra tek komutla kurulum: ön koşullar kuruldu, yapılandırma yazıldı, yığın sağlıklı şekilde ayağa kalkıyor ve sahip kurulum kodu" width="840" /></p>

Çalıştırmadan önce okumayı mı tercih edersin (root'a yakın Docker erişimi verdiğin her betik için mantıklı)? Depoyu klonla ve kurulum betiğini kendin çalıştır — yalnızca yerel bir `.env` yazar ve `docker compose` çağırır, eksikse Docker'ı kurar ve idempotent'tir (yeniden çalıştırması güvenlidir):

```bash
git clone https://github.com/SimerayCom/tugra.git
cd tugra
less scripts/install.sh   # review it first
./scripts/install.sh
```

Kurulum betiği güçlü gizli değerleri yerel bir `.env` dosyasına üretir (yeniden çalıştırmak bunları korur), ardından `docker compose` ile hub'ı, web arayüzünü, PostgreSQL'i ve Redis'i ayağa kaldırır. İş bittiğinde yazdırılan **Web UI** URL'sini (`http://<host-ip>:3001`; hub/API tabanı `http://<host-ip>:3000`) aç ve ilk hesabı oluştur — bu hesap örneğin **sahibi** olur. Yeni bir kurulumda betik ayrıca, o hesabı oluştururken girmen gereken tek seferlik bir **kurulum kodu** yazdırır (`grep SETUP_CODE .env` ile geri bulabilirsin). Ardından ilk sunucunu bağlamak için karşılama sihirbazını izle.

`./scripts/install.sh` dosyasını yeniden çalıştırmak (ör. `git pull` sonrası) güvenlidir — gizli değerlerini korur ve yalnızca yapılandırmayı günceller, bu yüzden aynı zamanda yükseltme yolu işlevi görür.

**Üretim (TLS + alan adı).** Yığın, hızlı başlangıç için bu ana makinenin portlarında düz HTTP sunar; onu TLS'i sonlandıran kendi ters vekil sunucunun arkasına koy ve alan adınla yeniden çalıştır:

```bash
./scripts/install.sh --domain tugra.example.com
```

Trafiğin çoğunu **web**'e (`:3001`) yönlendir — REST API'yi ve OAuth başlangıcını senin için hub'a vekiller — ve yalnızca web'in işleyemediği yolları **hub**'a (`:3000`) gönder:

| Yol öneki | → |
|---|---|
| `/agent`, `/terminal` (WebSocket), `/install`, `/webhooks`, `/auth/oauth` | hub `:3000` |
| geri kalan her şey (`/`, `/api/*`) | web `:3001` |

Notlar:

- **TLS pakete dahil değildir** — kendi ters vekil sunucunu getir (Caddy, Traefik, nginx, …). `--domain`, bu kurulum için `COOKIE_SECURE=true` + `HUB_TRUSTED_PROXY=true` ayarlar.
- **Ham portları kilitle.** `HUB_TRUSTED_PROXY=true` ile hub `X-Forwarded-For` başlığına güvenir, bu yüzden ham `:3000`/`:3001` portlarına **yalnızca** vekil sunucu erişebilmelidir. Yeni bir `--domain` kurulumu bunları `127.0.0.1`'e bağlar (aynı ana makinedeki vekil). Vekil başka bir ana makinede çalışıyorsa `HUB_BIND`/`WEB_BIND` değerini bu kutunun özel arayüz IP'sine ayarla ve portları güvenlik duvarıyla koru — Docker'ın yayımladığı portlar `ufw`'yi atlar.
- **"Sign in with GitHub"** yalnızca bu tek kaynaklı (single-origin) vekil dağıtımında çalışır (oturum çerezinin SPA tarafından görülebilmesi için hub ve web ortak bir genel kaynağı paylaşır); düz iki portlu hızlı başlangıçta kullanılamaz.

> Yayımlanmış imajlar (`ghcr.io/simeraycom/tugra-*`) ilk etiketli sürümle birlikte gelir. O zamana kadar kurulum betiği otomatik olarak senin checkout'undan derler — aynı komut, hiçbir değişiklik gerekmez.

**MCP hızlı başlangıç.** Tugra ayağa kalktıktan sonra bir kişisel erişim token'ı oluştur (**Settings → API tokens**) ve herhangi bir MCP istemcisini ona yönlendir:

```bash
curl -s http://<web-url>/api/v1/mcp \
  -H "Authorization: Bearer $TUGRA_PAT" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize"}'
```

## Kendi sunucunda barındırma ve bulut

Yukarıdaki [Neden Tugra](#neden-tugra) bölümündeki her şey, AGPL-3.0 altında, kendi sunucularında barındırılarak **sonsuza dek ücretsiz ve açık kaynaktır** — yapay bir sınır yok, para karşılığı açılmayı bekleyen bir özellik bayrağı yok. Bu depodaki Community edisyonu gerçek üründür, sakatlanmış bir demo değil.

Pro ve Cloud edisyonları (SSO, denetim kaydı dışa aktarma, whitelabel, yönetilen kontrol düzlemi) ayrı bir ticari lisans altında sunulur. AGPL dışı bir lisans için ya da Community'nin yapamadığı bir şey için **license@tugra.io** ile iletişime geç.

## Mimari

| Bileşen | Teknoloji |
|---|---|
| Hub (API + beyin) | NestJS · PostgreSQL (Prisma) · Redis / BullMQ |
| Web | Next.js |
| Ajan | Go (sunucu başına tek binary) |
| Vekil sunucu | Traefik (otomatik SSL, DNS-01 wildcard dahil) |

Canlı loglar, metrikler ve terminal WebSocket'ler üzerinden akar. Ayrıntılı döküm [docs/architecture.md](docs/architecture.md) içinde.

## Yol haritası

**Yayımlananlar**

- [x] Hub ↔ Ajan protokolü + sunucu kaydı (dışa bağlanan WSS · ed25519 · imzalı komutlar + yetenek kapsamı)
- [x] Git / Docker Compose / imajdan dağıtım (Nixpacks · Dockerfile · statik site)
- [x] Ters vekil sunucu + otomatik SSL (Traefik · Let's Encrypt, DNS-01 wildcard dahil)
- [x] Canlı metrikler, derleme logları ve web terminali (WebSocket akışları)
- [x] Yedekleme ve geri yüklemeli veritabanları (9 motor) (yerel + S3/R2 uzak konum)
- [x] Çok sunuculu kümeler + Docker Swarm oluşturma, filo genelinde toplu işlemler
- [x] Yerel MCP sunucusu — 48 araç (okuma + PAT kapsamlı değiştirme/filo operasyonları) + rehberli istemler
- [x] Uygulama mağazası — tek tıkla şablon kataloğu + Home modu başlatıcısı
- [x] Uygulama diskleri için salt okunur dosya tarayıcısı (web arayüzü + MCP `list_files`)
- [x] Önizleme dağıtımları (pull request başına)
- [x] Çalışma süresi izleme (HTTP/TCP/metrik) + bildirim kanalları
- [x] Zamanlanmış görevler (cron) · geri almalar · kaynak limitleri ve sağlık kontrolleri
- [x] Projeler / ortamlar · ekipler, roller ve davetler · etiketler · paylaşılan değişkenler
- [x] Genel API (OpenAPI) + CLI (`tugra`)
- [x] Sunucu yamalama (işletim sistemi paket güncellemeleri)
- [x] Kendi kendini güncelleme (imzalı sürümler) + rehberli karşılama
- [x] Migrator — yerel Docker konteynerlerini benimseme + Coolify'dan içe aktarma (bağlan · planla · uygula · geri al) + tek komutla ana makineler arası veritabanı verisi taşıma (Postgres · MySQL · MariaDB · Redis · KeyDB · Dragonfly)

**Sırada**

- [ ] Üçüncü taraf istemciler için MCP OAuth (dinamik istemci kaydı, PKCE)
- [ ] Dosya yöneticisi — yazma desteği (yükleme / yeniden adlandırma / silme)
- [ ] ClickHouse + MongoDB verisi ve uygulama disk verisi için tek tıkla taşıma
- [ ] Daha fazla taşıma kaynağı (Dokploy, CapRover)
- [ ] Mobil uygulama

## Topluluk ve dokümantasyon

- [Tam dokümantasyon](docs/README.md) — kurulum, mimari, API, CLI, güvenlik, açık çekirdek
- [Issues](https://github.com/SimerayCom/tugra/issues) — hata bildirimleri ve özellik istekleri
- [Discussions](https://github.com/SimerayCom/tugra/discussions) — sorular, fikirler, göster-ve-anlat
- [Katkıda bulunma](CONTRIBUTING.md) · [Davranış Kuralları](CODE_OF_CONDUCT.md) · [CLA](CLA.md)
- [Güvenlik politikası](SECURITY.md)

## Katkıda bulunanlar

<a href="https://github.com/SimerayCom/tugra/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=SimerayCom/tugra" alt="Katkıda bulunanlar" />
</a>

## Sponsorlar

Tugra açıkça geliştirilir ve sürdürülür. Sana ya da ekibine faydalıysa [projeye GitHub'da sponsor olmayı](https://github.com/sponsors/mrcandev) düşün — henüz bir sponsor kademesi yok, yani ilk sen olursun ve her katkı geliştirmeyi bağımsız tutmaya yardım eder.

## Yıldız geçmişi

[![Star History Chart](https://api.star-history.com/svg?repos=SimerayCom/tugra&type=Date)](https://star-history.com/#SimerayCom/tugra&Date)

## Lisans

Tugra bir **açık çekirdek** modeli kullanır:

- **Çekirdek** (bu depo) — [GNU AGPLv3](LICENSE). Kullanması, kendi sunucunda barındırması, incelemesi ve değiştirmesi ücretsiz. Değiştirilmiş bir sürümü ağ hizmeti olarak çalıştırırsan, değişikliklerini aynı lisans altında paylaşmak zorundasın.
- **Ajan ve CLI** — [MIT](agent/LICENSE). Her yerde kullan, hiçbir şart yok.
- **Tugra Cloud ve Pro özellikleri** — kapalı kaynak, henüz yayımlanmadı ([Kendi sunucunda barındırma ve bulut](#kendi-sunucunda-barındırma-ve-bulut) bölümüne bak).

**Ticari lisans:** AGPLv3'e uyamıyorsan (ör. Tugra'nın üzerine kapalı kaynaklı veya SaaS bir ürün inşa etmek istiyorsan), ticari bir lisans mevcuttur. **license@tugra.io** ile iletişime geç. Ayrıntılı döküm [docs/open-core.md](docs/open-core.md) içinde.

---

<div align="center"><sub>AGPL-3.0 © Simeray Ltd — bkz. <a href="LICENSE">LICENSE</a>.</sub></div>
