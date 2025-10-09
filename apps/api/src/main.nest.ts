import 'reflect-metadata';
import dotenv from 'dotenv';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

dotenv.config();

async function bootstrap() {
  const app = await NestFactory.create(AppModule); // enable Nest logger
  app.use((require('express') as any).json());
  const port = Number(process.env.API_PORT || 3000);
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`API (Nest) listening on http://localhost:${port}`);
}

bootstrap();
