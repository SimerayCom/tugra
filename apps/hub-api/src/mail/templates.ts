/**
 * Typed transactional email templates. Each returns a subject + an HTML body (inline,
 * responsive, email-client safe) + a plain-text alternative. User-controlled variables
 * (name, team name) are HTML-escaped; URLs are hub-generated (WEB_PUBLIC_URL + token).
 */

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

/** Escape the five HTML-significant characters so a user's name can't inject markup. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Shared responsive wrapper — inline styles only (email clients strip <style>/<head>). */
function layout(preheader: string, bodyHtml: string): string {
  return [
    `<!doctype html><html><body style="margin:0;padding:0;background:#f5f5f7;">`,
    `<span style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(preheader)}</span>`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f7;padding:24px 0;">`,
    `<tr><td align="center">`,
    `<table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px;width:100%;background:#ffffff;border-radius:12px;padding:32px;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1a1a1a;">`,
    `<tr><td style="font-size:18px;font-weight:700;padding-bottom:16px;">Tugra</td></tr>`,
    `<tr><td style="font-size:14px;line-height:1.6;color:#333;">${bodyHtml}</td></tr>`,
    `<tr><td style="font-size:12px;color:#999;padding-top:24px;border-top:1px solid #eee;">If you didn't expect this email you can safely ignore it.</td></tr>`,
    `</table></td></tr></table></body></html>`,
  ].join("");
}

/** A primary call-to-action button (bulletproof for email clients). */
function button(url: string, label: string): string {
  return `<a href="${escapeHtml(url)}" style="display:inline-block;background:#1a1a1a;color:#ffffff;text-decoration:none;padding:11px 20px;border-radius:8px;font-weight:600;font-size:14px;">${escapeHtml(label)}</a>`;
}

export function resetPasswordEmail(v: { name: string | null; resetUrl: string }): RenderedEmail {
  const hi = v.name ? `Hi ${escapeHtml(v.name)},` : "Hi,";
  return {
    subject: "Reset your Tugra password",
    html: layout(
      "Reset your Tugra password",
      `<p style="margin:0 0 12px;">${hi}</p>` +
        `<p style="margin:0 0 20px;">We received a request to reset your password. Click the button below to choose a new one. This link expires in 45 minutes.</p>` +
        `<p style="margin:0 0 20px;">${button(v.resetUrl, "Reset password")}</p>` +
        `<p style="margin:0;color:#666;font-size:13px;">Or paste this link into your browser:<br><span style="color:#1a1a1a;">${escapeHtml(v.resetUrl)}</span></p>`,
    ),
    text: `${v.name ? `Hi ${v.name},` : "Hi,"}\n\nReset your Tugra password using this link (expires in 45 minutes):\n${v.resetUrl}\n\nIf you didn't request this, ignore this email.`,
  };
}

export function verifyEmail(v: { name: string | null; verifyUrl: string }): RenderedEmail {
  const hi = v.name ? `Hi ${escapeHtml(v.name)},` : "Hi,";
  return {
    subject: "Verify your Tugra email address",
    html: layout(
      "Verify your Tugra email address",
      `<p style="margin:0 0 12px;">${hi}</p>` +
        `<p style="margin:0 0 20px;">Confirm your email address to finish setting up your account.</p>` +
        `<p style="margin:0 0 20px;">${button(v.verifyUrl, "Verify email")}</p>` +
        `<p style="margin:0;color:#666;font-size:13px;">Or paste this link into your browser:<br><span style="color:#1a1a1a;">${escapeHtml(v.verifyUrl)}</span></p>`,
    ),
    text: `${v.name ? `Hi ${v.name},` : "Hi,"}\n\nVerify your Tugra email address:\n${v.verifyUrl}`,
  };
}

export function teamInviteEmail(v: { inviterName: string | null; teamName: string; acceptUrl: string }): RenderedEmail {
  const who = v.inviterName ? escapeHtml(v.inviterName) : "Someone";
  return {
    subject: `You've been invited to ${v.teamName} on Tugra`,
    html: layout(
      `Join ${v.teamName} on Tugra`,
      `<p style="margin:0 0 20px;">${who} invited you to join the team <strong>${escapeHtml(v.teamName)}</strong> on Tugra.</p>` +
        `<p style="margin:0 0 20px;">${button(v.acceptUrl, "Accept invitation")}</p>` +
        `<p style="margin:0;color:#666;font-size:13px;">Or paste this link into your browser:<br><span style="color:#1a1a1a;">${escapeHtml(v.acceptUrl)}</span></p>`,
    ),
    text: `${v.inviterName ?? "Someone"} invited you to join the team "${v.teamName}" on Tugra.\n\nAccept the invitation:\n${v.acceptUrl}`,
  };
}
