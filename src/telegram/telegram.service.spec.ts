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

  it("asks gender and blocks template handoff when command is used without profile gender", async () => {
    const service = createService();

    const ensureAwaitingGender = jest
      .spyOn(service as any, "ensureAdOrderAwaitingGender")
      .mockResolvedValue(undefined);
    const sendAdminResponse = jest
      .spyOn(service as any, "sendAdminResponse")
      .mockResolvedValue(undefined);
    const sendTemplate = jest
      .spyOn(service as any, "sendPostingTemplateForGender")
      .mockResolvedValue(undefined);
    jest
      .spyOn(service as any, "getOrCreateUserProfile")
      .mockResolvedValue({ userId: "777", gender: undefined, adCount: 0 });

    await (service as any).executeTemplateLinkCommand({
      senderId: "777",
      order: { id: 42, status: "awaiting_content" },
    });

    expect(ensureAwaitingGender).toHaveBeenCalledWith(42);
    expect(sendAdminResponse).toHaveBeenCalledWith("777", "Ayolmisiz yoki erkak?");
    expect(sendTemplate).not.toHaveBeenCalled();
  });

  it("handles send_template_link in valid gender flow", async () => {
    const service = createService();

    const sendAdminResponse = jest
      .spyOn(service as any, "sendAdminResponse")
      .mockResolvedValue(undefined);
    const sendTemplate = jest
      .spyOn(service as any, "sendPostingTemplateForGender")
      .mockResolvedValue(undefined);
    jest
      .spyOn(service as any, "getOrCreateUserProfile")
      .mockResolvedValue({ userId: "777", gender: "female", adCount: 1 });

    await (service as any).executeTemplateLinkCommand({
      senderId: "777",
      order: { id: 43, status: "awaiting_content" },
    });

    expect(sendTemplate).toHaveBeenCalledWith("777", "female");
    expect(sendAdminResponse).toHaveBeenCalledWith(
      "777",
      "Keyin 2 ta rasm va 1 ta yumaloq video yuboring.",
    );
  });

  it("enforces command-only output for template delivery", () => {
    const service = createService();

    expect((service as any).isTemplateLinkCommand("send_template_link")).toBe(
      true,
    );
    expect(
      (service as any).isTemplateLinkCommand(
        "send_template_link https://example.com/template",
      ),
    ).toBe(false);
  });

  it("blocks raw template URL output and records diagnostic warning", async () => {
    const service = createService();

    const warnSpy = jest
      .spyOn((service as any).logger, "warn")
      .mockImplementation(() => undefined);
    const executeCommand = jest
      .spyOn(service as any, "executeTemplateLinkCommand")
      .mockResolvedValue(undefined);
    jest.spyOn(service as any, "getOpenAdOrder").mockResolvedValue({
      id: 44,
      status: "awaiting_content",
      orderType: "ad",
    });

    const handled = await (service as any).handleTemplateLinkAssistantOutput({
      senderId: "777",
      responseText: "https://cdn.example.com/template/form-1",
    });

    expect(handled).toBe(true);
    expect(executeCommand).toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("blocked raw template URL output"),
    );
  });

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
