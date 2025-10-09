import {
  Module,
  MiddlewareConsumer,
  NestModule,
  OnModuleInit,
  RequestMethod,
} from '@nestjs/common';
import { HealthController } from './controllers/health.controller';
import { RootController } from './controllers/root.controller';
import { ProfilesController } from './controllers/profiles.controller';
import { MediaController } from './controllers/media.controller';
import { AuthController } from './controllers/auth.controller';
import { CsrfMiddleware, SessionMiddleware } from './middlewares/security';
import { eventBus } from '@shared/event-bus';
import { PrismaClient } from '@prisma/client';

@Module({
  controllers: [
    HealthController,
    RootController,
    ProfilesController,
    AuthController,
    MediaController,
  ],
})
export class AppModule implements NestModule, OnModuleInit {
  configure(consumer: MiddlewareConsumer) {
    // Apply security to all routes except public ones
    consumer
      .apply(CsrfMiddleware, SessionMiddleware)
      .exclude(
        { path: 'health/(.*)', method: RequestMethod.ALL },
        { path: 'v1/auth/(.*)', method: RequestMethod.ALL },
        { path: 'v1', method: RequestMethod.GET },
      )
      .forRoutes({ path: '*', method: RequestMethod.ALL });
  }
  async onModuleInit() {
    const db = new PrismaClient() as any;
    eventBus.on('profile.submitted', async (evt: any) => {
      const profileId = BigInt(evt.payload.profileId);
      await db.moderationTask.create({ data: { profileId, kind: 'profile_full' } });
    });
  }
}
