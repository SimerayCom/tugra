# Email

Tugra sends email for exactly three things: **password reset**, **email verification** and **team
invites**. It is outbound only (SMTP); Tugra never receives mail. Email is **optional** — with no
mailer configured the panel is fully usable, those flows simply don't deliver anything (see
[Without a mailer](#without-a-mailer)).

## Configure a mailer

Set the `MAIL_*` keys in the hub's `.env` (the installer generates this file; every key is listed in
[`.env.example`](../.env.example)), then restart the hub:

```bash
docker compose --env-file .env -f deploy/docker-compose.yml up -d
```

| Key | Meaning |
| --- | --- |
| `MAIL_HOST` | SMTP server. **Leaving it empty turns email off.** |
| `MAIL_PORT` | `587` (STARTTLS, default) or `465` (implicit TLS). |
| `MAIL_SECURE` | `"true"` for implicit TLS on 465, `"false"` for STARTTLS on 587. |
| `MAIL_USER` / `MAIL_PASS` | SMTP credentials. |
| `MAIL_FROM` | The sender, e.g. `Tugra <no-reply@yourdomain.com>`. |

### Resend

Verify your sending domain in [Resend](https://resend.com) first (add its DKIM + SPF DNS records), then:

```bash
MAIL_HOST="smtp.resend.com"
MAIL_PORT="465"
MAIL_SECURE="true"
MAIL_USER="resend"            # literally "resend"
MAIL_PASS="re_your_api_key"
MAIL_FROM="Tugra <no-reply@yourdomain.com>"
```

### Any other SMTP provider

Any provider that speaks SMTP works (Postmark, SES, Mailgun, your own relay):

```bash
MAIL_HOST="smtp.example.com"
MAIL_PORT="587"
MAIL_SECURE="false"
MAIL_USER="your-smtp-user"
MAIL_PASS="your-smtp-password"
MAIL_FROM="Tugra <no-reply@yourdomain.com>"
```

### `MAIL_FROM` must be a real, verified domain

Providers reject (or silently drop) mail from a domain you haven't verified. The default
`no-reply@localhost` will not be accepted by a real provider — set `MAIL_FROM` to an address on a
domain you own and have verified with that provider (DKIM/SPF), or messages will not arrive.

## Without a mailer

When `MAIL_HOST` is empty the hub does not send anything, and the web UI says so:

- The "verify your email" banner is hidden (nobody could receive the link), and the **forgot
  password** screen shows a hint that this hub has no email configured.
- Password-reset and verification flows still return success (they never reveal whether an account
  exists), and the hub writes the link to its **server console** instead. To retrieve a reset link,
  run on the hub host:

  ```bash
  docker compose --env-file .env -f deploy/docker-compose.yml logs hub-api | grep -E "password reset|email verification"
  ```

  Look for `password reset for <email>: mail not delivered — link: …` and open that URL.
- Team invites still work: the invite response contains a copy-link you can hand over directly.

Treat those log lines as secrets — anyone who can read them can reset that account.

## Email verification is off by default

Verification is **not required** out of the box (`REQUIRE_EMAIL_VERIFICATION="false"`), so the panel
is usable without email: unverified users are not blocked. Only enable
`REQUIRE_EMAIL_VERIFICATION="true"` once a mailer is configured and tested — otherwise unverified
users could never receive the link to unblock themselves.

The installer prints a one-line reminder when `MAIL_HOST` is empty.
