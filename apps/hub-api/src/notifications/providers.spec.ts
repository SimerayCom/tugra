import { getProvider } from "./providers";

describe("notification providers", () => {
  afterEach(() => jest.restoreAllMocks());

  it("webhook posts the message to the configured url", async () => {
    const fetchMock = jest
      .spyOn(global, "fetch")
      .mockResolvedValue({ ok: true, status: 200 } as Response);
    await getProvider("webhook").send({ url: "http://hook.test/x" }, "hi");
    expect(fetchMock).toHaveBeenCalledWith(
      "http://hook.test/x",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("telegram hits the bot API", async () => {
    const fetchMock = jest
      .spyOn(global, "fetch")
      .mockResolvedValue({ ok: true, status: 200 } as Response);
    await getProvider("telegram").send({ botToken: "T", chatId: "1" }, "hi");
    expect(String(fetchMock.mock.calls[0][0])).toContain("api.telegram.org/botT");
  });

  it("throws on an unknown channel type", () => {
    expect(() => getProvider("nope")).toThrow(/unknown channel type/);
  });
});
