import { decodeExact, digestsFor, encodeExact, exactImageFor, isDigestPinned, isExactPinFor, isFloatingTag, normalizedRepo, shortDigest, splitImage } from "./exact-image";

const D1 = `sha256:${"1".repeat(64)}`;
const D2 = `sha256:${"2".repeat(64)}`;

describe("splitImage / normalizedRepo", () => {
  it("cuts an image into repository, tag and digest and keeps a registry port", () => {
    expect(splitImage("postgres")).toEqual({ repo: "postgres", tag: null, digest: null });
    expect(splitImage("postgres:16-alpine")).toEqual({ repo: "postgres", tag: "16-alpine", digest: null });
    expect(splitImage(`ghcr.io/x/y:1.2@${D1}`)).toEqual({ repo: "ghcr.io/x/y", tag: "1.2", digest: D1 });
    expect(splitImage("localhost:5000/app")).toEqual({ repo: "localhost:5000/app", tag: null, digest: null });
    expect(splitImage("localhost:5000/app:v2")).toEqual({ repo: "localhost:5000/app", tag: "v2", digest: null });
  });
  it("folds the Docker Hub aliases the way docker prints RepoDigests", () => {
    expect(normalizedRepo("docker.io/library/nginx:1")).toBe("nginx");
    expect(normalizedRepo("index.docker.io/getmeili/meilisearch")).toBe("getmeili/meilisearch");
    expect(normalizedRepo("GHCR.io/Org/App:1")).toBe("ghcr.io/org/app");
  });
  it("tells a floating tag and a digest pin apart", () => {
    expect(isFloatingTag("redis")).toBe(true);
    expect(isFloatingTag("redis:latest")).toBe(true);
    expect(isFloatingTag("redis:7.2")).toBe(false);
    expect(isFloatingTag(`redis@${D1}`)).toBe(false);
    expect(isDigestPinned(`redis:7@${D1}`)).toBe(true);
    expect(isDigestPinned("redis:7")).toBe(false);
  });
});

describe("digestsFor", () => {
  it("keeps only the digests of the image's own repository, distinct and valid", () => {
    expect(digestsFor("getmeili/meilisearch:latest", [`getmeili/meilisearch@${D1}`, `ghcr.io/other/x@${D2}`, `docker.io/getmeili/meilisearch@${D1}`, "getmeili/meilisearch@sha256:short"])).toEqual([D1]);
    expect(digestsFor("nginx", [`nginx@${D1}`, `docker.io/library/nginx@${D2}`])).toEqual([D1, D2]);
    expect(digestsFor("nginx", undefined)).toEqual([]);
  });
});

describe("exactImageFor: the pin of the image the source runs", () => {
  it("a floating tag with a digest is pinned to repo:latest@digest (the tag stays readable)", () => {
    expect(exactImageFor("getmeili/meilisearch:latest", [`getmeili/meilisearch@${D1}`], "1.11.3")).toEqual({ ref: `getmeili/meilisearch:latest@${D1}`, tag: "latest", digest: D1, version: "1.11.3", via: "digest" });
    expect(exactImageFor("gotenberg/gotenberg", [`gotenberg/gotenberg@${D1}`])).toEqual({ ref: `gotenberg/gotenberg:latest@${D1}`, tag: "latest", digest: D1, version: null, via: "digest" });
  });
  it("a MOVING tag (postgres:16-alpine, redis:7.2) is pinned too, on the tag the source runs", () => {
    expect(exactImageFor("postgres:16-alpine", [`postgres@${D1}`])?.ref).toBe(`postgres:16-alpine@${D1}`);
    expect(exactImageFor("redis:7.2", [`redis@${D2}`])?.ref).toBe(`redis:7.2@${D2}`);
    expect(exactImageFor("ghcr.io/x/y:1.2.3", [`ghcr.io/x/y@${D2}`])?.ref).toBe(`ghcr.io/x/y:1.2.3@${D2}`);
  });
  it("with no digest nothing is guessed, even when the image labels its version (a label is not a tag)", () => {
    expect(exactImageFor("minio/minio:latest", [], "RELEASE.2024-05-10T01-41-38Z")).toBeNull();
    expect(exactImageFor("ghcr.io/willnorris/imageproxy:latest", undefined, "0.13.0")).toBeNull();
  });
  it("with no digest, a tag that is not floating is not rewritten to the label (the label may name another variant)", () => {
    expect(exactImageFor("postgres:16-alpine", [], "16.4")).toBeNull();
  });
  it("nothing is guessed: no digest and no label, two different digests, a foreign repository, a bad label", () => {
    expect(exactImageFor("x/y:latest", [])).toBeNull();
    expect(exactImageFor("x/y:latest", undefined, undefined)).toBeNull();
    expect(exactImageFor("x/y:latest", [`x/y@${D1}`, `docker.io/x/y@${D2}`])).toBeNull();
    expect(exactImageFor("x/y:latest", [`other/z@${D1}`])).toBeNull();
    expect(exactImageFor("x/y:latest", [], "not a version")).toBeNull();
    expect(exactImageFor("x/y:latest", [], "latest")).toBeNull();
  });
  it("a ref the apply schemas would refuse (a registry with a port) is not offered as a pin", () => {
    expect(exactImageFor("localhost:5000/app:latest", [`localhost:5000/app@${D1}`])).toBeNull();
  });
  it("an image already on a digest (the owner's own pin, or an earlier import) is never replaced", () => {
    expect(exactImageFor(`x/y:1@${D1}`, [`x/y@${D2}`], "9")).toBeNull();
    expect(exactImageFor("", [`x/y@${D1}`])).toBeNull();
  });
  it("a digest wins over the version label when both are known, and the label rides along for the preview", () => {
    expect(exactImageFor("x/y:latest", [`x/y@${D1}`], "3.0.1")).toMatchObject({ via: "digest", version: "3.0.1" });
  });
});

describe("recorded form of a pin", () => {
  it("round-trips the ref and the version", () => {
    const e = exactImageFor("x/y:latest", [`x/y@${D1}`], "3.0.1")!;
    expect(encodeExact(e)).toBe(`x/y:latest@${D1} 3.0.1`);
    expect(decodeExact(encodeExact(e))).toEqual({ ref: e.ref, version: "3.0.1", tag: "latest", digest: D1 });
    expect(decodeExact(`x/y:1@${D1}`)).toEqual({ ref: `x/y:1@${D1}`, version: null, tag: "1", digest: D1 });
  });
  it("refuses a value that is not a plain ref", () => {
    expect(decodeExact("x/y; id")).toBeNull();
    expect(decodeExact(`x/y@${D1} bad version`)).toBeNull();
    expect(decodeExact("x/y@sha256:short")).toBeNull();
  });
  it("shortDigest keeps sha256: and twelve hex digits", () => {
    expect(shortDigest(D1)).toBe("sha256:111111111111");
  });
});

describe("isExactPinFor: a pin may only replace its own repository", () => {
  it("accepts a digest pin or a version tag of the same repository", () => {
    expect(isExactPinFor("x/y:latest", `x/y:latest@${D1}`)).toBe(true);
    expect(isExactPinFor("docker.io/library/postgres:16", `postgres:16@${D1}`)).toBe(true);
    expect(isExactPinFor("x/y", "x/y:2.4.1")).toBe(true);
  });
  it("refuses another repository, a floating pin and an image that is already pinned", () => {
    expect(isExactPinFor("x/y:latest", `z/y:latest@${D1}`)).toBe(false);
    expect(isExactPinFor("x/y:latest", "x/y:latest")).toBe(false);
    expect(isExactPinFor(`x/y:1@${D1}`, `x/y:1@${D2}`)).toBe(false);
    expect(isExactPinFor("x/y:latest", "x/y; id")).toBe(false);
  });
});
