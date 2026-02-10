import { Api } from "telegram";
import { TelegramService } from "./telegram.service";
import {
  MediaArchiveConnectivityError,
  MediaArchiveReadinessError,
} from "../database/media-archive-readiness";

describe("TelegramService", () => {
  function createService() {
    const configService: any = {
      get: jest.fn((key: string) => {
        if (key === "AI_MODEL_NAME") return "gemini-2.5-flash";
        return undefined;
      }),
    };
    const settingsService: any = {
      getSettings: jest.fn().mockResolvedValue({ systemPrompt: "Base prompt" }),
    };
    const userProfilesService: any = {
      getProfileForPromptContext: jest
        .fn()
        .mockResolvedValue({ status: "no_profile" }),
    };
    const db: any = {
      execute: jest.fn().mockResolvedValue({
        rows: [
          { column_name: "archive_group_id" },
          { column_name: "archive_topic_id" },
          { column_name: "archive_message_id" },
        ],
      }),
    };
    return new TelegramService(
      configService,
      settingsService,
      userProfilesService,
      db,
    );
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

  it("blocks template helper command when posting context is not active", async () => {
    const service = createService();

    jest.spyOn(service as any, "getOpenAdOrder").mockResolvedValue(undefined);
    const sendAdminResponse = jest
      .spyOn(service as any, "sendAdminResponse")
      .mockResolvedValue(undefined);
    const executeCommand = jest
      .spyOn(service as any, "executeTemplateLinkCommand")
      .mockResolvedValue(undefined);

    const handled = await (service as any).handleTemplateLinkAssistantOutput({
      senderId: "777",
      responseText: "send_template_link",
    });

    expect(handled).toBe(true);
    expect(executeCommand).not.toHaveBeenCalled();
    expect(sendAdminResponse).toHaveBeenCalledWith(
      "777",
      expect.stringContaining("e'lon jarayonini boshlang"),
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

  it("classifies sticker media using Telegram sticker attributes", () => {
    const service = createService();
    const stickerAttr = Object.create(Api.DocumentAttributeSticker.prototype);
    const media = Object.create(Api.MessageMediaDocument.prototype);
    media.document = {
      mimeType: "video/webm",
      attributes: [stickerAttr],
    };

    const mediaType = (service as any).resolveMediaType({ media });

    expect(mediaType).toBe("sticker");
  });

  it("treats common payment commitment phrases as affirmative", () => {
    const service = createService();

    expect((service as any).isAffirmative("hozir yuboraman")).toBe(true);
    expect((service as any).isAffirmative("kartaga tashlayman")).toBe(true);
  });

  it("does not queue Gemini reply after media routing is handled", async () => {
    const service = createService();
    (service as any).model = {};

    jest
      .spyOn(service as any, "getOrCreateChatSession")
      .mockResolvedValue({ id: 10 });
    jest
      .spyOn(service as any, "insertChatMessage")
      .mockResolvedValue({ id: 55 });
    jest.spyOn(service as any, "isUserBlocked").mockReturnValue(false);
    jest.spyOn(service as any, "isAiPausedForUser").mockReturnValue(false);
    jest
      .spyOn(service as any, "forwardIncomingMedia")
      .mockResolvedValue(true);

    const maybeCreateAnketaTask = jest
      .spyOn(service as any, "maybeCreateAnketaTask")
      .mockResolvedValue(undefined);
    const handleOrderFlow = jest
      .spyOn(service as any, "handleOrderFlow")
      .mockResolvedValue(false);
    const queueBufferedReply = jest
      .spyOn(service as any, "queueBufferedReply")
      .mockImplementation(() => undefined);

    await service.handleIncomingMessage({
      isPrivate: true,
      message: {
        id: 1,
        out: false,
        media: {},
        message: "",
        senderId: {
          toString: () => "777",
        },
      },
    });

    expect(maybeCreateAnketaTask).not.toHaveBeenCalled();
    expect(handleOrderFlow).not.toHaveBeenCalled();
    expect(queueBufferedReply).not.toHaveBeenCalled();
  });

  it("rejects non-image payment evidence and keeps receipt waiting step", async () => {
    const service = createService();
    (service as any).paymentsTopicId = 123;

    const setStep = jest
      .spyOn(service as any, "setUserCurrentStep")
      .mockResolvedValue("awaiting_payment_receipt");
    const sendAdminResponse = jest
      .spyOn(service as any, "sendAdminResponse")
      .mockResolvedValue(undefined);
    const createAdminTask = jest
      .spyOn(service as any, "createAdminTask")
      .mockResolvedValue(undefined);

    const handled = await (service as any).handlePaymentReceiptMedia({
      senderId: "777",
      sessionId: 10,
      incomingText: "chek",
      message: { id: 5, peerId: "peer" },
      mediaType: "sticker",
      openOrder: {
        id: 101,
        status: "awaiting_check",
        orderType: "ad",
        userId: "777",
      },
    });

    expect(handled).toBe(true);
    expect(setStep).toHaveBeenCalledWith("777", "awaiting_payment_receipt");
    expect(sendAdminResponse).toHaveBeenCalledWith(
      "777",
      expect.stringContaining("To'lov cheki rasm bo'lishi kerak"),
    );
    expect(createAdminTask).not.toHaveBeenCalled();
  });

  it("accepts payment receipt photo and creates moderation task", async () => {
    const service = createService();
    (service as any).paymentsTopicId = 123;
    (service as any).adminGroupId = "-1001";
    (service as any).db = {
      update: jest.fn(() => ({
        set: jest.fn(() => ({
          where: jest.fn().mockResolvedValue(undefined),
        })),
      })),
    };

    const forwardToTopic = jest
      .spyOn(service as any, "forwardMessageToTopic")
      .mockResolvedValue(undefined);
    const setStep = jest
      .spyOn(service as any, "setUserCurrentStep")
      .mockResolvedValue("payment_receipt_submitted");
    const createAdminTask = jest
      .spyOn(service as any, "createAdminTask")
      .mockResolvedValue(1);
    const analyzeReceipt = jest
      .spyOn(service as any, "analyzePaymentReceiptStep")
      .mockResolvedValue(undefined);
    const sendAdminResponse = jest
      .spyOn(service as any, "sendAdminResponse")
      .mockResolvedValue(undefined);

    const handled = await (service as any).handlePaymentReceiptMedia({
      senderId: "777",
      sessionId: 10,
      incomingText: "chek",
      message: { id: 7, peerId: "peer" },
      mediaType: "photo",
      openOrder: {
        id: 201,
        status: "awaiting_check",
        orderType: "ad",
        amount: 90_000,
        adId: 8,
        userId: "777",
      },
    });

    expect(handled).toBe(true);
    expect(forwardToTopic).toHaveBeenCalled();
    expect(setStep).toHaveBeenCalledWith("777", "payment_receipt_submitted");
    expect(createAdminTask).toHaveBeenCalled();
    expect(analyzeReceipt).toHaveBeenCalled();
    expect(sendAdminResponse).toHaveBeenCalledWith(
      "777",
      "To'lov tushgach, anketangizni yuborasiz.",
    );
  });

  it("runs candidate analysis only for photos in candidate step", async () => {
    const service = createService();
    (service as any).client = {};
    (service as any).adminGroupId = "-1001";

    jest.spyOn(service as any, "resolveCurrentStep").mockResolvedValue(
      "awaiting_candidate_media",
    );
    jest.spyOn(service as any, "getLatestOpenOrder").mockResolvedValue({
      id: 31,
      status: "awaiting_content",
      orderType: "ad",
    });
    jest.spyOn(service as any, "getOpenAdOrder").mockResolvedValue({
      id: 31,
      status: "awaiting_content",
      orderType: "ad",
    });
    jest.spyOn(service as any, "getAdMediaCounts").mockResolvedValue({
      photos: 1,
      videos: 0,
      ready: false,
    });
    jest.spyOn(service as any, "storeUserMedia").mockResolvedValue(undefined);
    jest.spyOn(service as any, "forwardBlurredPhoto").mockResolvedValue(undefined);
    jest.spyOn(service as any, "sendAdminResponse").mockResolvedValue(undefined);
    jest
      .spyOn(service as any, "setUserCurrentStep")
      .mockResolvedValue("awaiting_candidate_media");
    jest
      .spyOn(service as any, "syncCandidateMediaCurrentStep")
      .mockResolvedValue(undefined);

    const analyzeCandidate = jest
      .spyOn(service as any, "analyzeCandidatePhotoStep")
      .mockResolvedValue(undefined);

    const mediaTypeSpy = jest
      .spyOn(service as any, "resolveMediaType")
      .mockReturnValueOnce("photo")
      .mockReturnValueOnce("video");
    await (service as any).forwardIncomingMedia({
      senderId: "777",
      sessionId: 10,
      incomingText: "",
      message: { id: 1, media: {} },
    });

    await (service as any).forwardIncomingMedia({
      senderId: "777",
      sessionId: 10,
      incomingText: "",
      message: { id: 2, media: {} },
    });

    expect(mediaTypeSpy).toHaveBeenCalledTimes(2);
    expect(analyzeCandidate).toHaveBeenCalledTimes(1);
  });

  it("routes media via context matrix for candidate and receipt happy paths", () => {
    const service = createService();

    const candidateDecision = (service as any).resolveImageRoutingDecision({
      senderId: "777",
      mediaType: "photo",
      currentStep: "awaiting_candidate_media",
      incomingText: "",
      openOrder: {
        id: 31,
        status: "awaiting_content",
        orderType: "ad",
      },
    });

    const receiptDecision = (service as any).resolveImageRoutingDecision({
      senderId: "777",
      mediaType: "photo",
      currentStep: "awaiting_payment_receipt",
      incomingText: "chek",
      openOrder: {
        id: 32,
        status: "awaiting_check",
        orderType: "ad",
      },
    });

    const receiptFromOrderDecision = (service as any).resolveImageRoutingDecision({
      senderId: "777",
      mediaType: "photo",
      currentStep: "idle",
      incomingText: "",
      openOrder: {
        id: 33,
        status: "awaiting_payment",
        orderType: "ad",
      },
    });

    expect(candidateDecision.target).toBe("candidate_media");
    expect(receiptDecision.target).toBe("payment_receipt");
    expect(receiptFromOrderDecision.target).toBe("payment_receipt");
  });

  it("blocks receipt-intent uploads during candidate flow and avoids payment moderation side effects", async () => {
    const service = createService();
    (service as any).client = {};
    (service as any).adminGroupId = "-1001";

    jest.spyOn(service as any, "resolveCurrentStep").mockResolvedValue(
      "awaiting_candidate_media",
    );
    jest.spyOn(service as any, "getLatestOpenOrder").mockResolvedValue({
      id: 31,
      status: "awaiting_content",
      orderType: "ad",
    });
    jest.spyOn(service as any, "resolveMediaType").mockReturnValue("photo");

    const handlePayment = jest
      .spyOn(service as any, "handlePaymentReceiptMedia")
      .mockResolvedValue(true);
    const storeUserMedia = jest
      .spyOn(service as any, "storeUserMedia")
      .mockResolvedValue(undefined);
    const sendAdminResponse = jest
      .spyOn(service as any, "sendAdminResponse")
      .mockResolvedValue(undefined);
    jest
      .spyOn(service as any, "setUserCurrentStep")
      .mockResolvedValue("awaiting_candidate_media");

    await (service as any).forwardIncomingMedia({
      senderId: "777",
      sessionId: 10,
      incomingText: "bu to'lov cheki",
      message: { id: 1, media: {} },
    });

    expect(handlePayment).not.toHaveBeenCalled();
    expect(storeUserMedia).not.toHaveBeenCalled();
    expect(sendAdminResponse).toHaveBeenCalledWith(
      "777",
      expect.stringContaining("nomzod media"),
    );
  });

  it("prevents candidate-side effects when receipt pipeline is selected", async () => {
    const service = createService();
    (service as any).client = {};
    (service as any).adminGroupId = "-1001";
    (service as any).paymentsTopicId = 123;

    jest.spyOn(service as any, "resolveCurrentStep").mockResolvedValue(
      "awaiting_payment_receipt",
    );
    jest.spyOn(service as any, "getLatestOpenOrder").mockResolvedValue({
      id: 41,
      status: "awaiting_check",
      orderType: "ad",
      userId: "777",
    });
    jest.spyOn(service as any, "resolveMediaType").mockReturnValue("photo");

    const handlePayment = jest
      .spyOn(service as any, "handlePaymentReceiptMedia")
      .mockResolvedValue(true);
    const storeUserMedia = jest
      .spyOn(service as any, "storeUserMedia")
      .mockResolvedValue(undefined);
    const analyzeCandidate = jest
      .spyOn(service as any, "analyzeCandidatePhotoStep")
      .mockResolvedValue(undefined);

    await (service as any).forwardIncomingMedia({
      senderId: "777",
      sessionId: 10,
      incomingText: "chek",
      message: { id: 2, media: {} },
    });

    expect(handlePayment).toHaveBeenCalled();
    expect(storeUserMedia).not.toHaveBeenCalled();
    expect(analyzeCandidate).not.toHaveBeenCalled();
  });

  it("stores candidate archive references only with candidate routing context", async () => {
    const service = createService();
    (service as any).client = {};
    (service as any).adminGroupId = "-1001";

    jest.spyOn(service as any, "resolveCurrentStep").mockResolvedValue(
      "awaiting_candidate_media",
    );
    jest.spyOn(service as any, "getLatestOpenOrder").mockResolvedValue({
      id: 52,
      status: "awaiting_content",
      orderType: "ad",
      userId: "777",
    });
    jest.spyOn(service as any, "getOpenAdOrder").mockResolvedValue({
      id: 52,
      status: "awaiting_content",
      orderType: "ad",
      userId: "777",
    });
    jest.spyOn(service as any, "resolveMediaType").mockReturnValue("photo");
    jest
      .spyOn(service as any, "ensureMediaArchiveSchemaReadiness")
      .mockResolvedValue(undefined);
    jest.spyOn(service as any, "getAdMediaCounts").mockResolvedValue({
      photos: 0,
      videos: 0,
      ready: false,
    });
    jest.spyOn(service as any, "forwardBlurredPhoto").mockResolvedValue(undefined);
    jest
      .spyOn(service as any, "syncCandidateMediaCurrentStep")
      .mockResolvedValue(undefined);
    jest.spyOn(service as any, "analyzeCandidatePhotoStep").mockResolvedValue(undefined);

    const storeUserMedia = jest
      .spyOn(service as any, "storeUserMedia")
      .mockResolvedValue(undefined);

    await (service as any).forwardIncomingMedia({
      senderId: "777",
      sessionId: 10,
      incomingText: "",
      message: { id: 3, media: {} },
    });

    expect(storeUserMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        routingContext: "candidate_media",
        orderId: 52,
      }),
    );
  });

  it("emits routing telemetry for accepted and blocked image decisions", async () => {
    const service = createService();
    (service as any).client = {};
    (service as any).adminGroupId = "-1001";

    const logSpy = jest
      .spyOn((service as any).logger, "log")
      .mockImplementation(() => undefined);

    jest.spyOn(service as any, "resolveCurrentStep").mockResolvedValue(
      "awaiting_candidate_media",
    );
    jest.spyOn(service as any, "getLatestOpenOrder").mockResolvedValue({
      id: 61,
      status: "awaiting_content",
      orderType: "ad",
      userId: "777",
    });
    jest.spyOn(service as any, "getOpenAdOrder").mockResolvedValue({
      id: 61,
      status: "awaiting_content",
      orderType: "ad",
      userId: "777",
    });
    jest.spyOn(service as any, "getAdMediaCounts").mockResolvedValue({
      photos: 0,
      videos: 0,
      ready: false,
    });
    jest.spyOn(service as any, "resolveMediaType").mockReturnValue("photo");
    jest
      .spyOn(service as any, "ensureMediaArchiveSchemaReadiness")
      .mockResolvedValue(undefined);
    jest.spyOn(service as any, "storeUserMedia").mockResolvedValue(undefined);
    jest.spyOn(service as any, "forwardBlurredPhoto").mockResolvedValue(undefined);
    jest
      .spyOn(service as any, "syncCandidateMediaCurrentStep")
      .mockResolvedValue(undefined);
    jest.spyOn(service as any, "analyzeCandidatePhotoStep").mockResolvedValue(undefined);
    jest.spyOn(service as any, "sendAdminResponse").mockResolvedValue(undefined);
    jest
      .spyOn(service as any, "setUserCurrentStep")
      .mockResolvedValue("awaiting_candidate_media");

    await (service as any).forwardIncomingMedia({
      senderId: "777",
      sessionId: 10,
      incomingText: "",
      message: { id: 5, media: {} },
    });

    await (service as any).forwardIncomingMedia({
      senderId: "777",
      sessionId: 10,
      incomingText: "chek",
      message: { id: 6, media: {} },
    });

    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('"event":"telegram.image_routing"'),
    );
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('"decision":"accepted"'),
    );
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('"decision":"blocked"'),
    );
  });

  it("builds prompt context with whitelisted profile fields", async () => {
    const service = createService();
    jest.spyOn(service as any, "getLatestOpenOrder").mockResolvedValue({
      status: "awaiting_check",
      orderType: "ad",
    });
    jest
      .spyOn(service as any, "resolveCurrentStep")
      .mockResolvedValue("awaiting_payment_receipt");

    (service as any).userProfilesService.getProfileForPromptContext.mockResolvedValue({
      status: "found",
      profile: {
        displayName: "Aziza",
        preferredLanguage: "uz",
        roleUseCase: "candidate",
        timezone: "Asia/Tashkent",
        gender: "female",
        email: "sensitive@example.com",
      },
    });

    const prompt = await (service as any).buildSystemPrompt("777");

    expect(prompt).toContain("[USER_PROFILE_CONTEXT]");
    expect(prompt).toContain("display_name=Aziza");
    expect(prompt).toContain("preferred_language=uz");
    expect(prompt).toContain("role_use_case=candidate");
    expect(prompt).toContain("timezone=Asia/Tashkent");
    expect(prompt).toContain("gender=female");
    expect(prompt).toContain("prompt_context_status=included");
    expect(prompt).not.toContain("sensitive@example.com");
  });

  it("marks prompt context as partial when only subset is available", async () => {
    const service = createService();
    jest.spyOn(service as any, "getLatestOpenOrder").mockResolvedValue({
      status: "awaiting_check",
      orderType: "ad",
    });
    jest
      .spyOn(service as any, "resolveCurrentStep")
      .mockResolvedValue("awaiting_payment_receipt");

    (service as any).userProfilesService.getProfileForPromptContext.mockResolvedValue({
      status: "found",
      profile: {
        displayName: "Only Name",
      },
    });

    const prompt = await (service as any).buildSystemPrompt("777");

    expect(prompt).toContain("display_name=Only Name");
    expect(prompt).toContain("prompt_context_status=partial");
  });

  it("falls back to baseline prompt context when profile is missing", async () => {
    const service = createService();
    jest.spyOn(service as any, "getLatestOpenOrder").mockResolvedValue({
      status: "awaiting_check",
      orderType: "ad",
    });
    jest
      .spyOn(service as any, "resolveCurrentStep")
      .mockResolvedValue("awaiting_payment_receipt");

    (service as any).userProfilesService.getProfileForPromptContext.mockResolvedValue({
      status: "no_profile",
    });

    const prompt = await (service as any).buildSystemPrompt("777");

    expect(prompt).not.toContain("[USER_PROFILE_CONTEXT]");
    expect(prompt).toContain("prompt_context_status=skipped");
  });

  it("injects persisted current step into AI prompt context", async () => {
    const service = createService();
    jest.spyOn(service as any, "getLatestOpenOrder").mockResolvedValue({
      status: "awaiting_check",
      orderType: "ad",
    });
    jest
      .spyOn(service as any, "resolveCurrentStep")
      .mockResolvedValue("awaiting_payment_receipt");

    const prompt = await (service as any).buildSystemPrompt("777");

    expect(prompt).toContain("current_step=awaiting_payment_receipt");
    expect(prompt).toContain("allowed_next_actions=");
    expect(prompt).toContain("order_status=awaiting_check");
  });

  it("passes startup when archive schema readiness succeeds", async () => {
    const service = createService();

    jest
      .spyOn(service as any, "ensureUserProfileSchema")
      .mockResolvedValue(undefined);
    const ensureArchive = jest
      .spyOn(service as any, "ensureMediaArchiveSchemaReadiness")
      .mockResolvedValue(undefined);
    const loadSession = jest
      .spyOn(service as any, "loadSession")
      .mockResolvedValue(undefined);
    const startUserbot = jest
      .spyOn(service as any, "startUserbot")
      .mockResolvedValue(undefined);

    await expect(service.onModuleInit()).resolves.toBeUndefined();

    expect(ensureArchive).toHaveBeenCalledWith("startup");
    expect(loadSession).toHaveBeenCalled();
    expect(startUserbot).toHaveBeenCalled();
  });

  it("fails startup with migration-specific message when schema is missing", async () => {
    const service = createService();

    jest
      .spyOn(service as any, "ensureUserProfileSchema")
      .mockResolvedValue(undefined);
    jest
      .spyOn(service as any, "ensureMediaArchiveSchemaReadiness")
      .mockRejectedValue(
        new MediaArchiveReadinessError(["archive_topic_id", "archive_message_id"]),
      );
    const loadSession = jest
      .spyOn(service as any, "loadSession")
      .mockResolvedValue(undefined);

    await expect(service.onModuleInit()).rejects.toThrow(
      "Media archive startup blocked: missing migration columns",
    );

    expect(loadSession).not.toHaveBeenCalled();
  });

  it("fails startup with connectivity-specific message when db is unreachable", async () => {
    const service = createService();

    jest
      .spyOn(service as any, "ensureUserProfileSchema")
      .mockResolvedValue(undefined);
    jest
      .spyOn(service as any, "ensureMediaArchiveSchemaReadiness")
      .mockRejectedValue(new MediaArchiveConnectivityError(new Error("down")));

    await expect(service.onModuleInit()).rejects.toThrow(
      "Media archive startup blocked: database connectivity check failed",
    );
  });

  it("fails closed before media persistence when runtime schema readiness fails", async () => {
    const service = createService();
    (service as any).client = {};
    (service as any).adminGroupId = "-1001";

    jest
      .spyOn(service as any, "resolveCurrentStep")
      .mockResolvedValue("awaiting_candidate_media");
    jest.spyOn(service as any, "getLatestOpenOrder").mockResolvedValue(undefined);
    jest.spyOn(service as any, "resolveMediaType").mockReturnValue("photo");
    jest
      .spyOn(service as any, "ensureMediaArchiveSchemaReadiness")
      .mockRejectedValue(new MediaArchiveReadinessError(["archive_group_id"]));
    const storeUserMedia = jest
      .spyOn(service as any, "storeUserMedia")
      .mockResolvedValue(undefined);

    await expect(
      (service as any).forwardIncomingMedia({
        senderId: "777",
        sessionId: 10,
        incomingText: "",
        message: { id: 1, media: {} },
      }),
    ).rejects.toBeInstanceOf(MediaArchiveReadinessError);

    expect(storeUserMedia).not.toHaveBeenCalled();
  });

  it("propagates explicit readiness error on archive column mismatch during persistence", async () => {
    const service = createService();
    (service as any).db = {
      insert: jest.fn(() => ({
        values: jest.fn().mockRejectedValue({
          code: "42703",
          message:
            'column "archive_topic_id" of relation "user_media" does not exist',
        }),
      })),
    };

    await expect(
      (service as any).storeUserMedia({
        sessionId: 10,
        userId: "777",
        messageId: 123,
        mediaType: "photo",
        routingContext: "candidate_media",
        orderId: 55,
        archiveGroupId: "-1001",
        archiveTopicId: 11,
        archiveMessageId: 12,
      }),
    ).rejects.toBeInstanceOf(MediaArchiveReadinessError);
  });
});
