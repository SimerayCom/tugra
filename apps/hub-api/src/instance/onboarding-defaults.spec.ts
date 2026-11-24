import { isPlaceholderEmail, suggestOnboardingDefaults } from "./onboarding-defaults";

describe("suggestOnboardingDefaults", () => {
  it("prefers HUB_PUBLIC_URL and strips the path/trailing slash", () => {
    expect(suggestOnboardingDefaults({ envPublicUrl: "https://hub.acme.test/", panelDomain: "other.acme.test", requestUrl: "http://10.0.0.5" }).publicUrl).toBe("https://hub.acme.test");
  });

  it("falls back to the panel domain as https, then to the request origin", () => {
    expect(suggestOnboardingDefaults({ envPublicUrl: "", panelDomain: "hub.acme.test" }).publicUrl).toBe("https://hub.acme.test");
    expect(suggestOnboardingDefaults({ requestUrl: "http://203.0.113.7" }).publicUrl).toBe("http://203.0.113.7");
    expect(suggestOnboardingDefaults({}).publicUrl).toBeNull();
  });

  it("ignores values that are not http(s) URLs", () => {
    expect(suggestOnboardingDefaults({ envPublicUrl: "ftp://x.test", panelDomain: "  " }).publicUrl).toBeNull();
  });

  it("uses ACME_EMAIL unless it is the shipped placeholder, then the owner email", () => {
    expect(suggestOnboardingDefaults({ envAcmeEmail: "ops@acme.test", ownerEmail: "me@acme.test" }).acmeEmail).toBe("ops@acme.test");
    expect(suggestOnboardingDefaults({ envAcmeEmail: "admin@example.com", ownerEmail: "me@acme.test" }).acmeEmail).toBe("me@acme.test");
    expect(suggestOnboardingDefaults({ ownerEmail: "me@acme.test" }).acmeEmail).toBe("me@acme.test");
  });

  it("never suggests a placeholder owner email either", () => {
    expect(suggestOnboardingDefaults({ ownerEmail: "owner@example.com" }).acmeEmail).toBeNull();
  });
});

describe("isPlaceholderEmail", () => {
  it("flags example domains and non-emails, not real ones", () => {
    expect(isPlaceholderEmail("admin@example.com")).toBe(true);
    expect(isPlaceholderEmail("a@Example.ORG")).toBe(true);
    expect(isPlaceholderEmail("")).toBe(true);
    expect(isPlaceholderEmail(undefined)).toBe(true);
    expect(isPlaceholderEmail("a@acme.test")).toBe(false);
  });
});
