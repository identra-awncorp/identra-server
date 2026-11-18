import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { AppController } from './app.controller';
import { AppService } from './app.service';
import { RateLimitModule } from './common/rate-limit';
import { validateEnv } from './config/env.validation';
import { IdentraGraphqlModule } from './graphql/graphql.module';
import { PrismaModule } from './infrastructure/prisma/prisma.module';
import { RedisModule } from './infrastructure/redis/redis.module';
import { AuditModule } from './modules/audit/audit.module';
import { AuthModule } from './modules/auth/auth.module';
import { ChatModule } from './modules/chat/chat.module';
import { CredentialsModule } from './modules/credentials/credentials.module';
import { DemoScenariosModule } from './modules/demo-scenarios/demo-scenarios.module';
import { FeedModule } from './modules/feed/feed.module';
import { HealthModule } from './modules/health/health.module';
import { IdentityModule } from './modules/identity/identity.module';
import { MiniAppsModule } from './modules/mini-apps/mini-apps.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { PaymentsModule } from './modules/payments/payments.module';
import { SharingModule } from './modules/sharing/sharing.module';
import { UsersModule } from './modules/users/users.module';
import { VerificationModule } from './modules/verification/verification.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      envFilePath: ['.env.local', '.env'],
      validate: validateEnv
    }),
    PrismaModule,
    RedisModule,
    RateLimitModule,
    IdentraGraphqlModule,
    HealthModule,
    AuthModule,
    UsersModule,
    IdentityModule,
    CredentialsModule,
    SharingModule,
    VerificationModule,
    ChatModule,
    FeedModule,
    PaymentsModule,
    NotificationsModule,
    MiniAppsModule,
    DemoScenariosModule,
    AuditModule
  ],
  controllers: [AppController],
  providers: [AppService]
})
export class AppModule {}
