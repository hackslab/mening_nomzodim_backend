import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { UserProfilesService } from "./user-profiles.service";
import { UserProfilesController } from "./user-profiles.controller";
import { UserProfilesRepository } from "./user-profiles.repository";

@Module({
  imports: [ConfigModule],
  providers: [UserProfilesService, UserProfilesRepository],
  controllers: [UserProfilesController],
  exports: [UserProfilesService],
})
export class UserProfilesModule {}
