import { doLogin } from "./auth";
import { maskToken } from "../session";
import { TugraClient } from "../client";

function ok(): Response {
  return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
}
function fail(status: number, message: string): Response {
  return new Response(JSON.stringify({ message }), { status, headers: { "content-type": "application/json" } });
}

describe("doLogin", () => {
  it("validates the token against the hub, then saves the normalized profile", async () => {
    const saved: { name: string; profile: { hub: string; token: string } }[] = [];
    const stub = jest.fn(async () => ok());
    const r = await doLogin(
      { hub: "https://h.example/", token: "  tugra_pat_abc  ", profile: "prod" },
      { makeClient: (o) => new TugraClient(o, stub), save: (name, profile) => saved.push({ name, profile }) },
    );
    expect(r).toEqual({ profile: "prod", hub: "https://h.example" });
    expect(saved).toEqual([{ name: "prod", profile: { hub: "https://h.example", token: "tugra_pat_abc" } }]);
    expect(stub).toHaveBeenCalledTimes(1); // validated via GET /servers
  });

  it("surfaces a 401 from the hub verbatim and does NOT save", async () => {
    const save = jest.fn();
    const stub = jest.fn(async () => fail(401, "invalid or expired api token"));
    await expect(
      doLogin({ hub: "https://h", token: "tugra_pat_x", profile: "p" }, { makeClient: (o) => new TugraClient(o, stub), save }),
    ).rejects.toMatchObject({ status: 401, message: "invalid or expired api token" });
    expect(save).not.toHaveBeenCalled();
  });

  it("rejects a token that isn't a tugra PAT before touching the network", async () => {
    const stub = jest.fn();
    await expect(
      doLogin({ hub: "https://h", token: "randomstring", profile: "p" }, { makeClient: (o) => new TugraClient(o, stub), save: () => undefined }),
    ).rejects.toThrow(/tugra_pat_/);
    expect(stub).not.toHaveBeenCalled();
  });

  it("rejects a non-http hub URL", async () => {
    await expect(doLogin({ hub: "ftp://h", token: "tugra_pat_x", profile: "p" }, { save: () => undefined })).rejects.toThrow(/http/);
  });

  it("rejects a hub whose 200 response isn't a Tugra API (non-array body) and does NOT save", async () => {
    const save = jest.fn();
    const stub = jest.fn(async () => new Response("<html>not tugra</html>", { status: 200, headers: { "content-type": "text/html" } }));
    await expect(
      doLogin({ hub: "https://wrong", token: "tugra_pat_x", profile: "p" }, { makeClient: (o) => new TugraClient(o, stub), save }),
    ).rejects.toThrow(/doesn't look like a Tugra hub/);
    expect(save).not.toHaveBeenCalled();
  });
});

describe("maskToken", () => {
  it("shows only a short prefix", () => {
    expect(maskToken("tugra_pat_abcdefghijklmnop")).toBe("tugra_pat_abcd…");
    expect(maskToken("short")).toBe("****");
  });
});
