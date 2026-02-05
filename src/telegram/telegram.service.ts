import {
  Injectable,
  OnModuleInit,
  Logger,
  Inject,
  BadRequestException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { TelegramClient, Api } from "telegram";
import { StringSession } from "telegram/sessions";
import { computeCheck } from "telegram/Password";
import { DRIZZLE } from "../database/database.module";
import { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../database/schema";
import { sessions } from "../database/schema";
import { eq } from "drizzle-orm";
import { GoogleGenerativeAI, GenerativeModel } from "@google/generative-ai";
import { NewMessage } from "telegram/events";

@Injectable()
export class TelegramService implements OnModuleInit {
  private client: TelegramClient;
  private readonly logger = new Logger(TelegramService.name);
  private stringSession: StringSession;
  private genAI: GoogleGenerativeAI;
  private model: GenerativeModel;
  private sessions: Map<string, any> = new Map();

  constructor(
    private configService: ConfigService,
    @Inject(DRIZZLE) private db: NodePgDatabase<typeof schema>,
  ) {
    const apiKey = this.configService.get<string>("GEMINI_API_KEY");
    const modelName = this.configService.get<string>("AI_MODEL_NAME");

    if (apiKey && modelName) {
      this.genAI = new GoogleGenerativeAI(apiKey);
      this.model = this.genAI.getGenerativeModel({ model: modelName });
      this.logger.log(
        `Gemini (Vertex AI) initialized with model: ${modelName}`,
      );
    } else {
      this.logger.warn(
        "GEMINI_API_KEY or AI_MODEL_NAME not found. AI features disabled.",
      );
    }
  }

  async onModuleInit() {
    await this.loadSession();
    await this.startUserbot();
  }

  async loadSession() {
    const result = await this.db.select().from(sessions).limit(1);
    if (result.length > 0) {
      this.stringSession = new StringSession(result[0].sessionString);
      this.logger.log(`Loaded session for ${result[0].phoneNumber}`);
    } else {
      this.stringSession = new StringSession("");
    }
  }

  async startUserbot() {
    const apiId = this.configService.get<number>("API_ID");
    const apiHash = this.configService.get<string>("API_HASH");

    const numericApiId = Number(apiId);

    if (!numericApiId || !apiHash) {
      this.logger.error("API_ID or API_HASH not found in env");
      return;
    }

    this.client = new TelegramClient(
      this.stringSession,
      numericApiId,
      apiHash,
      {
        connectionRetries: 5,
        useWSS: true, // Try using WSS for better stability
      },
    );

    try {
      await this.client.connect();
      this.logger.log("Client connected to Telegram servers.");

      this.client.addEventHandler(
        this.handleIncomingMessage.bind(this),
        new NewMessage({ incoming: true }),
      );
      this.logger.log("AI Userbot handler attached.");
    } catch (e: any) {
      if (e.code === 401 || e.errorMessage === "AUTH_KEY_UNREGISTERED") {
        this.logger.warn("Session is invalid or expired. Resetting session.");
        this.stringSession = new StringSession("");
        // Re-create client with empty session
        this.client = new TelegramClient(
          this.stringSession,
          numericApiId,
          apiHash,
          { connectionRetries: 5, useWSS: true },
        );
        await this.client.connect();
        this.logger.log(
          "Client connected with empty session (ready to login).",
        );
      } else {
        this.logger.error("Initial connection failed", e);
      }
    }
  }

  async handleIncomingMessage(event: any) {
    if (!this.model) {
      this.logger.debug("Gemini model not initialized, ignoring message.");
      return;
    }

    const message = event.message;
    const senderId = message?.senderId?.toString();
    const isPrivate = event.isPrivate;
    const isOut = message?.out;

    this.logger.debug(
      `Event received: Sender=${senderId}, Private=${isPrivate}, Out=${isOut}, Text=${message?.message?.substring(0, 20)}...`,
    );

    if (isPrivate && message && !isOut) {
      if (!senderId) return;

      this.logger.debug(
        `Processing message from ${senderId}: ${message.message}`,
      );

      try {
        const result = await this.model.generateContent(message.message);
        const response = await result.response;
        const responseText = response.text();

        if (responseText) {
          await this.client.sendMessage(message.senderId, {
            message: responseText,
          });
          this.logger.log(`Gemini replied to ${senderId}: ${responseText}`);
        } else {
          this.logger.warn(`Empty response from Gemini for ${senderId}`);
        }
      } catch (error) {
        this.logger.error(`Error in Gemini handler for ${senderId}`, error);
      }
    }
  }

  async sendCode(phoneNumber: string) {
    if (!this.client) await this.startUserbot();
    try {
      const result = await this.client.sendCode(
        {
          apiId: Number(this.configService.get("API_ID")),
          apiHash: this.configService.get("API_HASH")!,
        },
        phoneNumber,
      );
      this.logger.log(`Code sent to ${phoneNumber}`);
      return result;
    } catch (error) {
      this.logger.error("Error sending code", error);
      throw error;
    }
  }

  async signIn(phoneNumber: string, phoneCodeHash: string, phoneCode: string) {
    try {
      const result = await this.client.invoke(
        new Api.auth.SignIn({
          phoneNumber: phoneNumber,
          phoneCodeHash: phoneCodeHash,
          phoneCode: phoneCode,
        }),
      );

      const sessionString = this.stringSession.save();
      await this.saveSessionToDb(phoneNumber, sessionString);

      this.logger.log("Signed in successfully");
      return sessionString;
    } catch (error) {
      this.logger.error("Error signing in", error);
      if (error.errorMessage) {
        throw new BadRequestException(error.errorMessage);
      }
      throw error;
    }
  }

  async signInWithPassword(password: string) {
    try {
      const passwordSrpResult = await this.client.invoke(
        new Api.account.GetPassword(),
      );
      const passwordSrpCheck = await computeCheck(passwordSrpResult, password);

      await this.client.invoke(
        new Api.auth.CheckPassword({
          password: passwordSrpCheck,
        }),
      );

      const sessionString = this.stringSession.save();
      const me = await this.client.getMe();
      if (me && !(me instanceof Promise) && (me as any).phone) {
        await this.saveSessionToDb((me as any).phone, sessionString);
      } else {
        this.logger.warn(
          "Could not retrieve phone number after password login to save session DB",
        );
      }

      this.logger.log("Signed in with password successfully");
      return sessionString;
    } catch (error) {
      this.logger.error("Error signing in with password", error);
      if (error.errorMessage) {
        throw new BadRequestException(error.errorMessage);
      }
      throw error;
    }
  }

  async saveSessionToDb(phoneNumber: string, sessionString: string) {
    const existing = await this.db
      .select()
      .from(sessions)
      .where(eq(sessions.phoneNumber, phoneNumber));
    if (existing.length > 0) {
      await this.db
        .update(sessions)
        .set({ sessionString, updatedAt: new Date() })
        .where(eq(sessions.phoneNumber, phoneNumber));
    } else {
      await this.db.insert(sessions).values({
        phoneNumber,
        sessionString,
      });
    }
  }

  async getStatus() {
    if (!this.client) return { connected: false };
    if (!this.client.connected) return { connected: false };

    try {
      if (!(await this.client.checkAuthorization())) {
        return { connected: false };
      }

      const me = await this.client.getMe();
      if (me && !(me instanceof Promise)) {
        return {
          connected: true,
          user: {
            id: me.id.toString(),
            username: me.username,
            firstName: me.firstName,
          },
        };
      }
    } catch (e) {}

    return { connected: false };
  }

  getClient() {
    return this.client;
  }
}
