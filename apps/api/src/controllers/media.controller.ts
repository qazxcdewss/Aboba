import { Controller, Post, Get, Req, Res, Param } from '@nestjs/common';
import type { Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import crypto from 'crypto';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';

const db = new PrismaClient() as any;

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
const BUCKET_DER = process.env.S3_BUCKET_DERIVED || 'aboba-media-derived';

const redis = new IORedis(process.env.REDIS_URL || 'redis://redis:6379', {
  maxRetriesPerRequest: null as unknown as number,
  enableReadyCheck: false,
});
const mediaQueue = new Queue('media.process_photo', { connection: redis as unknown as any });

@Controller('/v1/me/profiles/:id/photos')
export class MediaController {
  @Get()
  async list(@Req() req: Request, @Res() res: Response, @Param('id') idParam: string) {
    const userId = (req as any).userId as bigint;
    const profileId = BigInt(String(idParam));
    const p = await db.profile.findFirst({ where: { id: profileId, userId } });
    if (!p) return res.status(404).json({ code: 'profiles.not_found' });
    const rows = await db.profilePhoto.findMany({
      where: { profileId },
      orderBy: { position: 'asc' },
    });

    const ttlSeconds = 600; // 10 minutes per ADR-004
    const data = await Promise.all(
      rows.map(async (r: any) => {
        let variants: any = undefined;
        if (r.processingState === 'processed') {
          const baseKey = `profiles/${Number(profileId)}/photos/${Number(r.id)}`;
          const [thumbUrl, cardUrl, watermarkedUrl] = await Promise.all([
            getSignedUrl(
              s3,
              new GetObjectCommand({ Bucket: BUCKET_DER, Key: `${baseKey}/thumb.jpg` }),
              { expiresIn: ttlSeconds },
            ),
            getSignedUrl(
              s3,
              new GetObjectCommand({ Bucket: BUCKET_DER, Key: `${baseKey}/card.jpg` }),
              { expiresIn: ttlSeconds },
            ),
            getSignedUrl(
              s3,
              new GetObjectCommand({ Bucket: BUCKET_DER, Key: `${baseKey}/watermarked.jpg` }),
              { expiresIn: ttlSeconds },
            ),
          ]);
          variants = { thumbUrl, cardUrl, watermarkedUrl, expiresIn: ttlSeconds };
        }
        return {
          photoId: Number(r.id),
          isCover: r.isCover,
          orderIndex: r.position,
          mime: r.mime,
          storageKey: r.storageKey,
          createdAt: r.createdAt.toISOString(),
          variants,
        };
      }),
    );
    return res.json(data);
  }
  @Post('upload-url')
  async uploadUrl(@Req() req: Request, @Res() res: Response, @Param('id') idParam: string) {
    const userId = (req as any).userId as bigint;
    const id = Number(idParam);
    const mime = String((req.body as any)?.mime || 'image/jpeg');
    const sizeBytes = Number((req.body as any)?.sizeBytes || 0);
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(mime))
      return res.status(400).json({ code: 'media.unsupported_mime' });
    if (sizeBytes <= 0 || sizeBytes > 25 * 1024 * 1024)
      return res.status(400).json({ code: 'media.size_too_large' });
    const prof = await db.profile.findFirst({ where: { id: BigInt(id), userId } });
    if (!prof) return res.status(404).json({ code: 'profiles.not_found' });
    const tmp = `profiles/${id}/photos/tmp_${crypto.randomBytes(6).toString('hex')}/orig`;
    try {
      await s3.send(new PutObjectCommand({ Bucket: BUCKET_ORIG, Key: '__keepalive', Body: '' }));
    } catch {}
    const presigned = await createPresignedPost(s3, {
      Bucket: BUCKET_ORIG,
      Key: tmp,
      Conditions: [['content-length-range', 1, 25 * 1024 * 1024], { 'Content-Type': mime }],
      Expires: 600,
      Fields: { 'Content-Type': mime },
    });
    return res.json({
      upload: {
        url: presigned.url,
        fields: presigned.fields,
        key: tmp,
        expiresAt: new Date(Date.now() + 600000).toISOString(),
      },
      constraints: {
        maxBytes: 25 * 1024 * 1024,
        allowedMime: ['image/jpeg', 'image/png', 'image/webp'],
      },
    });
  }

  @Post('confirm')
  async confirm(@Req() req: Request, @Res() res: Response, @Param('id') idParam: string) {
    const userId = (req as any).userId as bigint;
    const profileId = BigInt(String(idParam));
    const p = await db.profile.findFirst({ where: { id: profileId, userId } });
    if (!p) return res.status(404).json({ code: 'profiles.not_found' });

    const storageKey = String((req.body as any)?.storageKey || '');
    const sha256 = String((req.body as any)?.sha256 || '');
    const sizeBytes = Number((req.body as any)?.sizeBytes || 0);
    const mime = String((req.body as any)?.mime || 'image/jpeg');
    if (!storageKey || !sha256 || !sizeBytes)
      return res.status(400).json({ code: 'media.invalid' });

    const count = await db.profilePhoto.count({ where: { profileId } });
    const isCover = count === 0;
    const aggr = await db.profilePhoto.aggregate({
      _max: { position: true },
      where: { profileId },
    });
    let nextPos = (aggr._max.position ?? 0) + 10;
    while (true) {
      const exists = await db.profilePhoto.count({ where: { profileId, position: nextPos } });
      if (exists === 0) break;
      nextPos += 1;
    }

    const existingByKey = await db.profilePhoto.findUnique({ where: { storageKey } });
    if (existingByKey) {
      return res
        .status(201)
        .json({
          photoId: Number(existingByKey.id),
          isCover: existingByKey.isCover,
          orderIndex: existingByKey.position,
          state: 'processing',
          variants: [],
        });
    }
    const existingBySha = await db.profilePhoto.findFirst({
      where: { profileId, sha256Hex: sha256 },
    });
    if (existingBySha) {
      return res
        .status(201)
        .json({
          photoId: Number(existingBySha.id),
          isCover: existingBySha.isCover,
          orderIndex: existingBySha.position,
          state: 'processing',
          variants: [],
        });
    }

    const photo = await db.profilePhoto.create({
      data: {
        profileId,
        storageKey,
        sha256Hex: sha256,
        isCover,
        position: nextPos,
        sizeBytes,
        mime,
      },
    });

    const job = await mediaQueue.add(
      'process',
      { profileId: Number(profileId), photoId: Number(photo.id), storageKey },
      { attempts: 3 } as any,
    );
    // eslint-disable-next-line no-console
    console.log('[api] enqueued media.process_photo', {
      jobId: job.id,
      profileId: Number(profileId),
      photoId: Number(photo.id),
    });
    return res
      .status(201)
      .json({
        photoId: Number(photo.id),
        isCover,
        orderIndex: photo.position,
        state: 'processing',
        variants: [],
      });
  }
}
