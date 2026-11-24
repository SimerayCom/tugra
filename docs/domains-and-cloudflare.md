# Domains and Cloudflare

Give the panel and your apps real addresses with HTTPS. This guide covers the panel's own domain, an app's domain, and the Cloudflare settings that cause most problems.

## Before you start

- A domain you control, with access to its DNS (at Cloudflare or anywhere else).
- The server's **public IP address**. In the panel it is on the server's page.
- Ports **80 and 443** open to the internet on that server, including any cloud firewall your provider adds in front of it. Let's Encrypt validates on port 80.
- Optional, for one-click DNS: a Cloudflare API token that can **edit DNS** for the zone.

## Steps

### The panel's domain

1. At your DNS provider, create an **A record** (for example `panel.example.com`) pointing at the server's IP.
2. In Tugra open **Settings, Instance, Panel domain**, enter the domain and press **Set domain**. The email is optional and only gets certificate expiry notices.
3. Tugra adds the domain next to the current address, waits for the certificate, switches the panel's public address and checks that `https://panel.example.com/health` answers. Then open the new address and sign in again.

Your old address keeps working until the new one is verified.

### An app's domain

1. Create the A record for the app's domain pointing at the server's IP. Use **DNS only** (grey cloud) at Cloudflare for now.
2. Open the app, then **Domain**, enter the domain and save.
3. Redeploy so the proxy picks it up. Tugra requests a Let's Encrypt certificate on the first request.
4. Press **Verify** to see what the domain resolves to and whether it matches the server.

Without a custom domain, an app gets a **magic domain** such as `web-1a2b3c.203-0-113-10.sslip.io`. It is plain HTTP by design and handy for testing.

### One-click DNS on Cloudflare

1. Open **Domains & SSL** (or the app's domain section) and add a Cloudflare credential for your team: an API token with **Zone, DNS, Edit** on the zone.
2. Pick the domain. Tugra shows what it would create without writing anything.
3. Confirm. It creates the A records as **DNS only**, sets the app's domain and wires the `www` redirect. A record that already points elsewhere is reported as a conflict and left alone until you choose to overwrite it.

If you do not use Cloudflare, the app's domain section shows the exact records to create by hand.

### Cloudflare settings that matter

| Setting | Use | Why |
|---|---|---|
| Proxy status of the record | **DNS only** while the certificate is first issued | Lets Let's Encrypt reach port 80 on your server |
| SSL/TLS mode | **Full** (never *Flexible*) | Flexible talks plain HTTP to your server, which redirects to HTTPS: an endless loop |
| Always Use HTTPS | **Off** while the first certificate issues | Its redirect can break the HTTP validation |

The panel works behind Cloudflare's orange cloud without a token. If you would rather not depend on port 80 at all, a Cloudflare API token on the server switches certificates to **DNS-01**, which also gives you wildcard domains while the record stays proxied.

## Does it affect the source?

Setting a domain changes only Tugra's own proxy routes and, if you use one-click DNS, the records it creates. Records it did not create are never deleted, and Cloudflare settings are never changed by Tugra. When you move a site from another host, change its DNS last: see [Move from Coolify](move-from-coolify.md).

## Roll back

- **Panel domain:** **Remove domain** goes back to `http://<server-ip>/`. If a change fails halfway, Tugra restores the previous address by itself and tells you why.
- **App domain:** clear the domain in the app and redeploy.
- **DNS records Tugra created:** removed from the app's domain section. Records that existed before are left alone.

## FAQ

**The certificate is not issued.** Check, in order: the A record points at this server (and not at an old one: lower its TTL first), port 80 is open to the internet, the Cloudflare record is DNS only, and the SSL/TLS mode is Full. The proxy log names the exact error. More in [Troubleshooting: domains, 404 / 502 and TLS](troubleshooting/domains-and-tls.md).

**I get a redirect loop.** Almost always Cloudflare in *Flexible* mode. Set it to **Full**.

**My site shows 404 or 502.** 404 means no route matched the domain, 502 means the app did not answer. The troubleshooting page above has a checklist for each.

**Can I use a wildcard domain?** Yes, with DNS-01 on a supported DNS provider. See the troubleshooting page.

**My server has only a private IP.** Magic domains need a public IP. Set the real one in the server's network settings.
