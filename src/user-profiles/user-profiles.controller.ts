import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Headers,
  UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { UserProfilesService } from "./user-profiles.service";

@Controller("profiles")
export class UserProfilesController {
  constructor(
    private readonly profilesService: UserProfilesService,
    private readonly configService: ConfigService,
  ) {}

  @Get(":userId")
  async getProfile(
    @Param("userId") userId: string,
    @Headers("x-admin-key") adminKey?: string,
  ) {
    this.requireAdmin(adminKey);
    return this.profilesService.getProfile(userId);
  }

  @Patch(":userId")
  async updateProfile(
    @Param("userId") userId: string,
    @Body() payload: Record<string, unknown>,
    @Headers("x-admin-key") adminKey?: string,
  ) {
    this.requireAdmin(adminKey);
    return this.profilesService.updateProfile(userId, payload ?? {});
  }

  @Post(":userId")
  async createProfile(
    @Param("userId") userId: string,
    @Body() payload: Record<string, unknown>,
    @Headers("x-admin-key") adminKey?: string,
  ) {
    this.requireAdmin(adminKey);
    return this.profilesService.createProfile(userId, payload ?? {});
  }

  @Post("backfill")
  async backfill(@Headers("x-admin-key") adminKey?: string) {
    this.requireAdmin(adminKey);
    return this.profilesService.backfillFromAdPosts();
  }

  private requireAdmin(adminKey?: string) {
    const expected = this.configService.get<string>("ADMIN_API_KEY");
    if (expected && adminKey !== expected) {
      throw new UnauthorizedException("Invalid admin key");
    }
  }
}
