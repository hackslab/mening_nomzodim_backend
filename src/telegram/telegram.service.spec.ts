import { TelegramService } from "./telegram.service";

describe("TelegramService", () => {
  function createService() {
    const configService: any = {
      get: jest.fn((key: string) => {
        if (key === "AI_MODEL_NAME") return "gemini-2.5-flash";
        return undefined;
      }),
    };
    const settingsService: any = { getSettings: jest.fn() };
    const db: any = {};
    return new TelegramService(configService, settingsService, db);
  }

  it("filters contact details from open-channel message", () => {
    const service = createService();
    const source = [
      "Ism: Test",
      "Yosh: 21",
      "Tel: +998901112233",
      "Talab: samimiy",
    ].join("\n");

    const openText = (service as any).buildOpenChannelMessage(source);
    const closedText = (service as any).buildClosedChannelMessage(source);

    expect(openText).toContain("Ism: Test");
    expect(openText).toContain("Talab: samimiy");
    expect(openText).not.toContain("Tel:");
    expect(closedText).toContain("Tel: +998901112233");
  });

  it("uses archived media reference before user dialog reference", async () => {
    const service = createService();
    const buffer = Buffer.from("file");

    const getInputEntity = jest
      .fn()
      .mockResolvedValueOnce("archive-peer")
      .mockResolvedValueOnce("user-peer");
    const getMessages = jest
      .fn()
      .mockResolvedValueOnce([{ downloadMedia: jest.fn().mockResolvedValue(buffer) }]);

    (service as any).client = { getInputEntity, getMessages };

    const row: any = {
      messageId: 10,
      archiveGroupId: "-1003836539598",
      archiveMessageId: 99,
    };

    const downloaded = await (service as any).downloadUserMedia(row, "777");

    expect(downloaded).toEqual(buffer);
    expect(getInputEntity).toHaveBeenCalledWith("-1003836539598");
    expect(getMessages).toHaveBeenCalledWith("archive-peer", { ids: [99] });
  });
});
