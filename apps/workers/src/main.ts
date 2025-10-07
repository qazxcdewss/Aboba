import dotenv from 'dotenv';
import { Worker, Queue, QueueEvents, JobsOptions } from 'bullmq';
import IORedis from 'ioredis';

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
mediaEvents.on('failed', ({ jobId, failedReason }) => console.error(`[worker] media ${jobId} failed: ${failedReason}`));

const worker = new Worker<ProcessPhotoJob>(mediaQueueName, async job => {
  const { profileId, photoId, storageKey } = job.data;
  console.log(`[worker] processing photo p=${profileId} id=${photoId} key=${storageKey}`);
  // TODO: antivirus, exif-strip, resize, watermark, derived upload
  // simulate work
  await new Promise(r => setTimeout(r, 500));
}, { connection });

worker.on('ready', () => console.log('Workers ready'));
worker.on('error', err => console.error('Worker error', err));


