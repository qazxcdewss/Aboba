import dotenv from 'dotenv';
import { Worker, Queue, QueueEvents } from 'bullmq';
import IORedis from 'ioredis';
import { PrismaClient } from '@prisma/client';
import { eventBus } from '@shared/event-bus';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

dotenv.config();

const redis = new IORedis({
  host: process.env.REDIS_HOST || 'localhost',
  port: Number(process.env.REDIS_PORT || 6379),
  // BullMQ requires these for blocking commands
  maxRetriesPerRequest: null as unknown as number,
  enableReadyCheck: false,
});

export type ProcessPhotoJob = {
  profileId: number;
  photoId: number;
  storageKey: string;
};

export const mediaQueueName = 'media.process_photo';

const connection = redis as unknown as any;

export const mediaQueue = new Queue<ProcessPhotoJob>(mediaQueueName, { connection });
const mediaEvents = new QueueEvents(mediaQueueName, { connection });
mediaEvents.on('completed', ({ jobId }) => console.log(`[worker] media ${jobId} completed`));
mediaEvents.on('failed', ({ jobId, failedReason }) =>
  console.error(`[worker] media ${jobId} failed: ${failedReason}`),
);

const prisma = new PrismaClient() as any;

const s3 = new S3Client({
  region: 'us-east-1',
  forcePathStyle: true,
  endpoint: process.env.S3_ENDPOINT || 'http://localhost:9000',
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY || 'minioadmin',
    secretAccessKey: process.env.S3_SECRET_KEY || 'minioadmin',
  },
});
const BUCKET_DER = process.env.S3_BUCKET_DERIVED || 'aboba-media-derived';

const worker = new Worker<ProcessPhotoJob>(
  mediaQueueName,
  async (job) => {
    const { profileId, photoId, storageKey } = job.data;
    console.log(`[worker] processing photo p=${profileId} id=${photoId} key=${storageKey}`);
    // TODO: antivirus, exif-strip, resize, watermark, derived upload
    // simulate work
    await new Promise((r) => setTimeout(r, 500));
    // mark as processed per ADR-004
    try {
      // simulate derived upload placeholders
      await s3.send(
        new PutObjectCommand({
          Bucket: BUCKET_DER,
          Key: `profiles/${profileId}/photos/${photoId}/thumb.jpg`,
          Body: Buffer.from('thumb'),
        }),
      );
      await s3.send(
        new PutObjectCommand({
          Bucket: BUCKET_DER,
          Key: `profiles/${profileId}/photos/${photoId}/card.jpg`,
          Body: Buffer.from('card'),
        }),
      );
      await s3.send(
        new PutObjectCommand({
          Bucket: BUCKET_DER,
          Key: `profiles/${profileId}/photos/${photoId}/watermarked.jpg`,
          Body: Buffer.from('wm'),
        }),
      );
      await prisma.profilePhoto.update({
        where: { id: BigInt(photoId) },
        data: {
          virusScanned: true,
          exifStripped: true,
          watermarkApplied: true,
          processingState: 'processed' as any,
          processedAt: new Date(),
          nsfwScore: 0.0 as any,
        },
      });
      await eventBus.emit({
        name: 'media.photo.processed',
        id: String(photoId),
        at: new Date().toISOString(),
        payload: { profileId, photoId, storageKey },
      });
    } catch (e) {
      console.error('[worker] db update failed', e);
      throw e;
    }
  },
  { connection },
);

worker.on('ready', () => console.log('Workers ready'));
worker.on('error', (err) => console.error('Worker error', err));
