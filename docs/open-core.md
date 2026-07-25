# Open-core & editions

Tugra is **open-core**. The Community edition in this repository is the complete,
production-grade self-hosted product — not a crippled demo. A separate proprietary
layer (Pro and Cloud) is built on top of it and is kept entirely outside this
repository and the OSS Docker image.

## Licensing

| Component | License | Notes |
|-----------|---------|-------|
| Core (this repo: hub + web) | [AGPL-3.0](../LICENSE) | Free to self-host, study, modify. Run a modified network service → share your changes under the same license. |
| Agent & CLI | [MIT](../agent/LICENSE) | Use anywhere, no strings attached. |
| Pro & Cloud | Proprietary | Not in this repo / OSS image. Separate private packages. |

Contributions are accepted under a [CLA](../CLA.md) so the core can be
dual-licensed (AGPL-3.0 + a commercial license). This is what lets us offer a
proprietary Pro/Cloud layer without relicensing the community core. Need to build
a proprietary or SaaS product on top of Tugra and can't comply with the AGPL?
A commercial license is available at **license@tugra.io**.

## Editions

Editions are ordered `community < pro < cloud`. The edition is a **deployment
signal**, injected at build/license time via the `TUGRA_EDITION` build arg — it is
**not** a runtime setting an operator can flip (otherwise anyone could unlock Pro
for free). It is surfaced read-only on `GET /version`, `GET /instance/status`, and
the owner's `GET /instance/settings`.

The core also **verifies a signed license** to raise the edition at runtime: a
Tugra-issued EdDSA (ed25519) JWT is checked against a public key **compiled into the
build** (never sourced from the environment, so an operator can't substitute their
own key and self-sign). The matching private key is held in Tugra's own infrastructure, outside this
repository; the community core only *verifies* license tokens, it never issues them. Community builds run as the community edition.

| Feature area | Community | Pro | Cloud |
|--------------|:---------:|:---:|:-----:|
| Deploy, rollback, build/registry | ✅ | ✅ | ✅ |
| Fleet / bulk operations | ✅ | ✅ | ✅ |
| Monitoring, live logs, uptime | ✅ | ✅ | ✅ |
| Backups & restore | ✅ | ✅ | ✅ |
| RBAC — teams, custom roles & granular permissions | ✅ | ✅ | ✅ |
| Web terminal | ✅ | ✅ | ✅ |
| Public API + CLI | ✅ | ✅ | ✅ |
| Self-update & onboarding | ✅ | ✅ | ✅ |
| Notifications (12 providers) | ✅ | ✅ | ✅ |
| SSO / SAML / OIDC | — | ✅ | ✅ |
| Audit-log export & retention policy | — | ✅ | ✅ |
| Whitelabel / branding | — | ✅ | ✅ |
| Advanced backup policy | — | ✅ | ✅ |
| Priority support | — | ✅ | ✅ |
| Multi-tenant control plane | — | — | ✅ |
| Billing & metering | — | — | ✅ |
| Managed backup storage | — | — | ✅ |
| Team SLA | — | — | ✅ |

Everything in the Community column is what ships in this repository today. The Pro
and Cloud columns describe the proprietary layer; **none of that code lives here.**

## The gating primitive

`requireEdition` is the enforcement scaffold. A future Pro/Cloud-only route opts in
with the decorator + guard:

```ts
import { RequireEdition, RequireEditionGuard } from "../common/edition";

@Controller("sso")
@UseGuards(JwtAuthGuard, RequireEditionGuard)
export class SsoController {
  @Post("saml")
  @RequireEdition("pro") // 403 "requires the pro edition" in community
  configure() { /* ... */ }
}
```

In the Community edition every route is un-gated (no decorator), so the guard is a
no-op for everything shipped today — it exists only so proprietary features can
attach later. The tier comparison (`editionAtLeast`) and normalization live in
[`@tugra/shared` `editions.ts`](../packages/shared/src/editions.ts); the hub guard
is in [`apps/hub-api/src/common/edition.ts`](../apps/hub-api/src/common/edition.ts).

## Where proprietary code lives

Proprietary Pro/Cloud packages use the reserved `@tugra/cloud-*` npm namespace and
live in a **separate private repository**, never merged into this AGPL core. The
top-level [`proprietary/`](../proprietary/README.md) directory documents that
convention and is intentionally empty in the open-source repository.
