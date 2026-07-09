import { escapeHtml, resetPasswordEmail, verifyEmail, teamInviteEmail } from "./templates";

describe("mail templates", () => {
  it("escapeHtml neutralizes the HTML-significant characters", () => {
    expect(escapeHtml(`<script>alert("x")&'`)).toBe("&lt;script&gt;alert(&quot;x&quot;)&amp;&#39;");
  });

  it("resetPasswordEmail renders subject/html/text with the reset URL", () => {
    const url = "https://tugra.example.com/reset-password?token=abc123";
    const e = resetPasswordEmail({ name: "Ada", resetUrl: url });
    expect(e.subject).toMatch(/reset your tugra password/i);
    expect(e.html).toContain(url);
    expect(e.text).toContain(url);
    expect(e.html).toContain("Ada");
  });

  it("verifyEmail + teamInviteEmail carry their URLs in html and text", () => {
    const v = verifyEmail({ name: null, verifyUrl: "https://x/verify?token=t" });
    expect(v.html).toContain("https://x/verify?token=t");
    expect(v.text).toContain("https://x/verify?token=t");
    const inv = teamInviteEmail({ inviterName: "Bob", teamName: "Acme", acceptUrl: "https://x/invite/tok" });
    expect(inv.subject).toContain("Acme");
    expect(inv.html).toContain("https://x/invite/tok");
    expect(inv.text).toContain("https://x/invite/tok");
  });

  it("HTML-escapes user-controlled name/teamName (no markup injection)", () => {
    const e = resetPasswordEmail({ name: "<script>evil</script>", resetUrl: "https://x/r" });
    expect(e.html).not.toContain("<script>evil</script>");
    expect(e.html).toContain("&lt;script&gt;evil&lt;/script&gt;");
    const inv = teamInviteEmail({ inviterName: "<img src=x>", teamName: "<b>Team</b>", acceptUrl: "https://x/i" });
    expect(inv.html).not.toContain("<img src=x>");
    expect(inv.html).not.toContain("<b>Team</b>");
    expect(inv.subject).toContain("<b>Team</b>"); // subject is plain text (no HTML context)
  });
});
