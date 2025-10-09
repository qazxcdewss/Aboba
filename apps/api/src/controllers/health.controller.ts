import { Controller, Get, Res } from '@nestjs/common';
import type { Response } from 'express';
import { PrismaClient } from '@prisma/client';
import IORedis from 'ioredis';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

const prisma = new PrismaClient();
const redis = new IORedis(process.env.REDIS_URL || 'redis://redis:6379', {
  maxRetriesPerRequest: null as any,
  enableReadyCheck: false,
});
const s3 = new S3Client({
  region: 'us-east-1',
  forcePathStyle: true,
  endpoint: process.env.S3_ENDPOINT || 'http://localhost:9000',
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY || 'minioadmin',
    secretAccessKey: process.env.S3_SECRET_KEY || 'minioadmin',
  },
});
const BUCKET_ORIG = process.env.S3_BUCKET_ORIGINAL || 'aboba-media-original';

@Controller()
export class HealthController {
  @Get('/health/live')
  live(@Res() res: Response) {
    return res.status(200).send('OK');
  }

  @Get('/health/ready')
  async ready(@Res() res: Response) {
    const result: any = {};
    try {
      await prisma.$queryRaw`SELECT 1`;
      result.db = 'ok';
    } catch (e) {
      return res.status(503).json({ db: 'down', error: String(e) });
    }
    try {
      const pong = await (redis as any).ping?.();
      result.redis = pong ? 'ok' : 'unknown';
    } catch {
      result.redis = 'down';
    }
    try {
      await s3.send(new PutObjectCommand({ Bucket: BUCKET_ORIG, Key: '__health', Body: '' }));
      result.s3 = 'ok';
    } catch {
      result.s3 = 'down';
    }
    const ok = result.db === 'ok' && result.redis !== 'down' && result.s3 !== 'down';
    return res.status(ok ? 200 : 503).json(result);
  }
}
