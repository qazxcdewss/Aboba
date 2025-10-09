import { Module, MiddlewareConsumer, NestModule, RequestMethod } from '@nestjs/common';
import { HealthController } from './controllers/health.controller';
import { RootController } from './controllers/root.controller';
import { ProfilesController } from './controllers/profiles.controller';
import { MediaController } from './controllers/media.controller';
import { AuthController } from './controllers/auth.controller';
import { CsrfMiddleware, SessionMiddleware } from './middlewares/security';

@Module({
  controllers: [
    HealthController,
    RootController,
    ProfilesController,
    AuthController,
    MediaController,
  ],
})
export class AppModule implements NestModule {
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
}
