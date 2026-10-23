import { archPinLines, assertPinnable } from "./image-pin";

const IMAGE = "ghcr.io/simeraycom/tugra-agent:0.1.0";
const A = "a".repeat(64);
const B = "b".repeat(64);

describe("image-pin", () => {
  describe("assertPinnable", () => {
    it("accepts a plain tag, a registry:port/repo:tag, and a tag@digest", () => {
      for (const img of [IMAGE, "host:5000/repo/img:tag", `${IMAGE}@sha256:${A}`]) {
        expect(() => assertPinnable(img)).not.toThrow();
      }
    });

    it("throws /unsafe image ref/ for injection-shaped refs (same message the agent spec asserts)", () => {
      for (const bad of ["img; rm -rf /", 'x"$(whoami)', "a b", "a\nb", "", "a`id`"]) {
        expect(() => assertPinnable(bad)).toThrow(/unsafe image ref/);
      }
    });

    it("throws /invalid agent image digest/ for a non-64-hex digest (each arch independently)", () => {
      expect(() => assertPinnable(IMAGE, { amd64: "short", arm64: B })).toThrow(/invalid agent image digest/);
      expect(() => assertPinnable(IMAGE, { amd64: A, arm64: "ZZZ" })).toThrow(/invalid agent image digest/);
      expect(() => assertPinnable(IMAGE, { amd64: "A".repeat(64), arm64: B })).toThrow(/invalid agent image digest/); // uppercase
      expect(() => assertPinnable(IMAGE, { amd64: A, arm64: B })).not.toThrow();
    });
  });

  describe("archPinLines", () => {
    it("returns [] when no digests", () => {
      expect(archPinLines(IMAGE)).toEqual([]);
    });

    it("returns exactly the 5 legacy pin lines (pins the agent-script extract)", () => {
      expect(archPinLines(IMAGE, { amd64: A, arm64: B })).toEqual([
        '_arch="$(uname -m 2>/dev/null || echo unknown)"',
        'case "$_arch" in',
        `  x86_64|amd64) IMAGE="${IMAGE}@sha256:${A}" ;;`,
        `  aarch64|arm64) IMAGE="${IMAGE}@sha256:${B}" ;;`,
        "esac",
      ]);
    });
  });
});
