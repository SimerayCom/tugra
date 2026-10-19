/**
 * Pure builder for the DNS records a self-hosted mail setup needs to actually DELIVER — the part people get
 * wrong (so mail lands in spam or bounces). Given a mail domain + the host that handles its mail, it produces
 * MX + SPF + DMARC (+ DKIM when the mail server's public key is supplied, e.g. mailcow generates one). These
 * feed the existing Cloudflare automation (same {type,name,content} shape) or the manual-records view. No I/O.
 *
 * It does NOT run a mail server (out of scope — use a mailcow app-store template or an external provider);
 * it makes "connect mail and have it deliver" correct by default, with a monitor-first DMARC policy.
 */

export interface MailDnsRecord {
  type: "MX" | "TXT";
  name: string; // FQDN the record lives at
  content: string;
  priority?: number; // MX only
  purpose: "mx" | "spf" | "dmarc" | "dkim";
}

export interface MailDnsInput {
  domain: string; // the mail domain, e.g. example.com
  mailHost: string; // host that receives/sends the mail, e.g. mail.example.com (must already have an A/AAAA)
  dkim?: { selector: string; publicKey: string }; // supplied by the mail server (mailcow/etc.)
  dmarcPolicy?: "none" | "quarantine" | "reject"; // default "none" — monitor first, tighten once aligned
  dmarcReportTo?: string; // mailbox for aggregate reports; default postmaster@domain
}

const FQDN_RE = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;
// Dot-separated labels, each starting/ending alphanumeric — no empty labels / trailing dot or dash.
const SELECTOR_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/i;
// An email with a dotted domain and no DMARC-tag metacharacters (';' ',' '!') that could inject extra tags/targets.
const RUA_RE = /^[^\s@;,!]+@[^\s@;,!]+\.[^\s@;,!]+$/;
const DMARC_POLICIES = new Set(["none", "quarantine", "reject"]);

export function buildMailDnsRecords(input: MailDnsInput): MailDnsRecord[] {
  const domain = input.domain.trim().toLowerCase().replace(/\.$/, "");
  const mailHost = input.mailHost.trim().toLowerCase().replace(/\.$/, "");
  if (!FQDN_RE.test(domain)) throw new Error("invalid mail domain");
  if (!FQDN_RE.test(mailHost)) throw new Error("invalid mail host");

  const records: MailDnsRecord[] = [
    // Where mail for the domain is delivered.
    { type: "MX", name: domain, content: `${mailHost}.`, priority: 10, purpose: "mx" },
    // Authorize the MX host to send for the domain; ~all = soft-fail (safe while verifying), not -all.
    { type: "TXT", name: domain, content: "v=spf1 mx ~all", purpose: "spf" },
  ];

  const policy = input.dmarcPolicy ?? "none";
  if (!DMARC_POLICIES.has(policy)) throw new Error("invalid DMARC policy"); // runtime guard (inputs come from an API body)
  const rua = (input.dmarcReportTo ?? `postmaster@${domain}`).trim();
  if (!RUA_RE.test(rua)) throw new Error("invalid DMARC report address");
  records.push({
    type: "TXT",
    name: `_dmarc.${domain}`,
    content: `v=DMARC1; p=${policy}; rua=mailto:${rua}; adkim=s; aspf=s`,
    purpose: "dmarc",
  });

  if (input.dkim) {
    const sel = input.dkim.selector.trim();
    const key = input.dkim.publicKey.trim();
    if (!SELECTOR_RE.test(sel)) throw new Error("invalid DKIM selector");
    if (!key) throw new Error("missing DKIM public key");
    // The mail server owns the key; we publish it verbatim (Cloudflare chunks a long TXT automatically).
    records.push({ type: "TXT", name: `${sel}._domainkey.${domain}`, content: key, purpose: "dkim" });
  }

  return records;
}
