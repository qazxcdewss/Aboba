import express, { Request, Response, NextFunction } from 'express';
import dotenv from 'dotenv';
import { PrismaClient, Prisma } from '@prisma/client';
import crypto from 'crypto';
import cookie from 'cookie';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';

dotenv.config();

const app = express();
app.use(express.json());

const prisma = new PrismaClient();
// Temporary loose typing to avoid generated Prisma Client type issues during bootstrap
const db = prisma as unknown as any;

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

// BullMQ queue (uses same Redis URL as docker-compose)
const redisForApi = new IORedis(process.env.REDIS_URL || 'redis://redis:6379', {
  maxRetriesPerRequest: null as unknown as number,
  enableReadyCheck: false,
});
const mediaQueue = new Queue('media.process_photo', { connection: redisForApi as unknown as any });
// ADR-006 readiness check for submit
async function isReadyToSubmit(profileId: bigint) {
  const photosProcessed = await db.profilePhoto.count({
    where: { profileId, processingState: 'processed' },
  });
  const pricesCount = await db.profilePrice.count({ where: { profileId } });
  const p = await db.profile.findUnique({ where: { id: profileId } });
  const reasons: string[] = [];
  if (!p) reasons.push('profiles.not_found');
  if (photosProcessed < 3) reasons.push('photos.lt3');
  if (pricesCount < 1) reasons.push('prices.missing');
  if (!p?.nickname) reasons.push('nickname.missing');
  return { ok: reasons.length === 0, reasons };
}

// Simple Redis-based rate limit helper (windowed counter)
async function rateLimit(key: string, limit: number, windowSeconds: number) {
  const k = `rl:${key}`;
  const tx = (redisForApi as any).multi();
  tx.incr(k);
  tx.expire(k, windowSeconds, 'NX');
  const [count] = await tx.exec();
  const current = Array.isArray(count) ? Number(count[1]) : Number(count);
  if (Number.isNaN(current)) return { allowed: true, remaining: limit };
  return { allowed: current <= limit, remaining: Math.max(0, limit - current) };
}

function generateCsrfToken() {
  return crypto.randomBytes(16).toString('hex');
}

// CSRF guard: double-submit cookie + header; Origin/Referer presence check
app.use((req, res, next) => {
  const method = (req.method || 'GET').toUpperCase();
  if (!['POST', 'PATCH', 'PUT', 'DELETE'].includes(method)) return next();
  const origin = req.headers['origin'] || req.headers['referer'];
  if (!origin) return res.status(400).json({ code: 'csrf.missing_origin' });
  const cookieHeader = req.headers['cookie'] || '';
  const cookies = cookie.parse(Array.isArray(cookieHeader) ? cookieHeader.join(';') : cookieHeader);
  const csrfCookie = cookies['csrf'];
  const csrfHeader = String(req.headers['x-csrf-token'] || '');
  if (!csrfCookie || !csrfHeader || csrfCookie !== csrfHeader) {
    return res.status(403).json({ code: 'csrf.invalid_token' });
  }
  return next();
});

async function findSessionByCookie(req: Request) {
  const cookieHeader = req.headers['cookie'] || '';
  const cookies = cookie.parse(Array.isArray(cookieHeader) ? cookieHeader.join(';') : cookieHeader);
  const raw = cookies['sid'];
  if (!raw) return null;
  const sidHash = crypto.createHash('sha256').update(raw).digest('hex');
  const now = new Date();
  const session = await db.session.findFirst({
    where: { tokenHash: sidHash, revokedAt: null, expiresAt: { gt: now } },
  });
  return { raw, session } as const;
}

app.get('/health/live', (_req, res) => res.status(200).send('OK'));
app.get('/health/ready', async (_req, res) => {
  const result: any = {};
  try {
    await prisma.$queryRaw`SELECT 1`;
    result.db = 'ok';
  } catch (e) {
    return res.status(503).json({ db: 'down', error: String(e) });
  }

  // Redis ping via BullMQ connection
  try {
    const pong = await (redisForApi as any).ping?.();
    result.redis = pong ? 'ok' : 'unknown';
  } catch {
    result.redis = 'down';
  }

  // S3: try to put a tiny object into original bucket (best effort)
  try {
    await s3.send(new PutObjectCommand({ Bucket: BUCKET_ORIG, Key: '__health', Body: '' }));
    result.s3 = 'ok';
  } catch {
    result.s3 = 'down';
  }

  const ok = result.db === 'ok' && result.redis !== 'down' && result.s3 !== 'down';
  res.status(ok ? 200 : 503).json(result);
});

app.get('/v1', (_req, res) => {
  res.json({ name: 'aboba-api', version: '0.1.0' });
});

// In-memory profiles store (until DB migration applied)
type InMemProfile = {
  id: number;
  userId: number;
  status: string;
  nickname: string;
  isVisible: boolean;
  createdAt: string;
  updatedAt: string;
};
const inMemProfiles: InMemProfile[] = [];
const inMemProfileId = 1;

function requireSession(req: Request, res: Response, next: NextFunction) {
  findSessionByCookie(req)
    .then((found) => {
      if (!found || !found.session) return res.status(401).json({ code: 'auth.unauthorized' });
      (req as any).userId = found.session.userId; // BigInt
      next();
    })
    .catch(() => res.status(401).json({ code: 'auth.unauthorized' }));
}

app.get('/v1/me/profiles', requireSession, async (req, res) => {
  const userId = (req as any).userId as bigint;
  const rows = await db.profile.findMany({ where: { userId } });
  const items = rows.map((p) => ({
    id: Number(p.id),
    userId: Number(p.userId),
    status: p.status,
    nickname: p.nickname,
    isVisible: p.isVisible,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
    publishedAt: p.publishedAt ? p.publishedAt.toISOString() : null,
    expiresAt: p.expiresAt ? p.expiresAt.toISOString() : null,
  }));
  res.json(items);
});

app.post('/v1/me/profiles', requireSession, async (req, res) => {
  const userId = (req as any).userId as bigint;
  const nickname = String(req.body?.nickname || '').trim();
  if (!nickname)
    return res.status(400).json({ code: 'profiles.invalid', message: 'nickname required' });
  const p = await db.profile.create({
    data: { userId, status: 'draft', nickname, isVisible: false },
  });
  res.status(201).json({
    id: Number(p.id),
    userId: Number(p.userId),
    status: p.status,
    nickname: p.nickname,
    isVisible: p.isVisible,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
    publishedAt: p.publishedAt ? p.publishedAt.toISOString() : null,
    expiresAt: p.expiresAt ? p.expiresAt.toISOString() : null,
  });
});

app.patch('/v1/me/profiles/:id', requireSession, async (req, res) => {
  const userId = (req as any).userId as bigint;
  const idStr = String(req.params.id || '');
  if (!/^\d+$/.test(idStr)) return res.status(400).json({ code: 'profiles.invalid_id' });
  const id = BigInt(idStr);
  const p = await db.profile.findFirst({ where: { id, userId } });
  if (!p) return res.status(404).json({ code: 'profiles.not_found' });
  if (!['draft', 'needs_fix'].includes(p.status))
    return res.status(400).json({ code: 'profiles.invalid_state' });
  const data: any = {};
  if (typeof req.body?.nickname === 'string') data.nickname = String(req.body.nickname).trim();
  data.updatedAt = new Date();
  const upd = await db.profile.update({ where: { id }, data });
  res.json({
    id: Number(upd.id),
    userId: Number(upd.userId),
    status: upd.status,
    nickname: upd.nickname,
    isVisible: upd.isVisible,
    createdAt: upd.createdAt.toISOString(),
    updatedAt: upd.updatedAt.toISOString(),
    publishedAt: upd.publishedAt ? upd.publishedAt.toISOString() : null,
    expiresAt: upd.expiresAt ? upd.expiresAt.toISOString() : null,
  });
});

// Media upload-url (presigned POST) — stub, no DB yet
app.post('/v1/me/profiles/:id/photos/upload-url', requireSession, async (req, res) => {
  const id = Number(req.params.id);
  const mime = String(req.body?.mime || 'image/jpeg');
  const sizeBytes = Number(req.body?.sizeBytes || 0);
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(mime))
    return res.status(400).json({ code: 'media.unsupported_mime' });
  if (sizeBytes <= 0 || sizeBytes > 25 * 1024 * 1024)
    return res.status(400).json({ code: 'media.size_too_large' });
  const tmp = `profiles/${id}/photos/tmp_${crypto.randomBytes(6).toString('hex')}/orig`;
  // ensure bucket exists (best effort)
  try {
    await s3.send(new PutObjectCommand({ Bucket: BUCKET_ORIG, Key: `__keepalive`, Body: '' }));
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
});

// Confirm (stub) — no DB yet, just echo
app.post('/v1/me/profiles/:id/photos/confirm', requireSession, async (req, res) => {
  const userId = (req as any).userId as bigint;
  const idStr = String(req.params.id || '');
  if (!/^\d+$/.test(idStr)) return res.status(400).json({ code: 'profiles.invalid_id' });
  const profileId = BigInt(idStr);
  const p = await db.profile.findFirst({ where: { id: profileId, userId } });
  if (!p) return res.status(404).json({ code: 'profiles.not_found' });

  const storageKey = String(req.body?.storageKey || '');
  const sha256 = String(req.body?.sha256 || '');
  const sizeBytes = Number(req.body?.sizeBytes || 0);
  const mime = String(req.body?.mime || 'image/jpeg');
  if (!storageKey || !sha256 || !sizeBytes) return res.status(400).json({ code: 'media.invalid' });

  const count = await db.profilePhoto.count({ where: { profileId } });
  const isCover = count === 0;
  // pick next free position (avoid UNIQUE(profileId, position))
  const aggr = await db.profilePhoto.aggregate({ _max: { position: true }, where: { profileId } });
  let nextPos = (aggr._max.position ?? 0) + 10;
  // tiny safeguard loop (very unlikely to iterate >1)
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const exists = await db.profilePhoto.count({ where: { profileId, position: nextPos } });
    if (exists === 0) break;
    nextPos += 1;
  }
  // Idempotency guards: first try by storageKey (unique), then by (profileId, sha256Hex)
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
      profileId: profileId,
      storageKey: storageKey,
      sha256Hex: sha256,
      isCover: isCover,
      position: nextPos,
      sizeBytes: sizeBytes,
      mime,
    },
  });
  // enqueue processing job
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
});

// List photos of a profile
app.get('/v1/me/profiles/:id/photos', requireSession, async (req, res) => {
  const userId = (req as any).userId as bigint;
  const idStr = String(req.params.id || '');
  if (!/^\d+$/.test(idStr)) return res.status(400).json({ code: 'profiles.invalid_id' });
  const profileId = BigInt(idStr);
  const p = await db.profile.findFirst({ where: { id: profileId, userId } });
  if (!p) return res.status(404).json({ code: 'profiles.not_found' });
  const rows = await db.profilePhoto.findMany({
    where: { profileId },
    orderBy: { position: 'asc' },
  });
  return res.json(
    rows.map((r) => ({
      photoId: Number(r.id),
      isCover: r.isCover,
      orderIndex: r.position,
      mime: r.mime,
      storageKey: r.storageKey,
      createdAt: r.createdAt.toISOString(),
      variants:
        r.processingState === 'processed'
          ? {
              thumbUrl: `http://localhost:9000/${BUCKET_DER}/profiles/${Number(profileId)}/photos/${Number(r.id)}/thumb.jpg`,
              cardUrl: `http://localhost:9000/${BUCKET_DER}/profiles/${Number(profileId)}/photos/${Number(r.id)}/card.jpg`,
              watermarkedUrl: `http://localhost:9000/${BUCKET_DER}/profiles/${Number(profileId)}/photos/${Number(r.id)}/watermarked.jpg`,
            }
          : undefined,
    })),
  );
});
// Upsert full prices matrix (PUT replaces snapshot)
app.put('/v1/me/profiles/:id/prices', requireSession, async (req, res) => {
  const userId = (req as any).userId as bigint;
  const idStr = String(req.params.id || '');
  if (!/^\d+$/.test(idStr)) return res.status(400).json({ code: 'profiles.invalid_id' });
  const profileId = BigInt(idStr);
  const p = await db.profile.findFirst({ where: { id: profileId, userId } });
  if (!p) return res.status(404).json({ code: 'profiles.not_found' });
  const body = Array.isArray(req.body) ? req.body : [];
  // Validate minimal fields
  for (const it of body) {
    if (!it || typeof it !== 'object')
      return res.status(400).json({ code: 'profiles.validation_failed' });
    if (!['day', 'night'].includes(it.timeBand))
      return res.status(400).json({ code: 'prices.invalid_time_band' });
    if (!['incall', 'outcall'].includes(it.visitType))
      return res.status(400).json({ code: 'prices.invalid_visit_type' });
    if (!['1h', '2h', 'night', 'other'].includes(it.unit))
      return res.status(400).json({ code: 'prices.invalid_unit' });
    if (!(Number(it.amountMinor) > 0))
      return res.status(400).json({ code: 'prices.invalid_amount' });
    if (it.unit === 'other' && !it.note)
      return res.status(400).json({ code: 'prices.note_required' });
    if (it.visitType === 'incall' && it.outcallTravel && it.outcallTravel !== 'none')
      return res.status(400).json({ code: 'prices.outcall_travel_invalid' });
  }
  await db.$transaction(async (tx: any) => {
    await tx.profilePrice.deleteMany({ where: { profileId } });
    for (const it of body) {
      await tx.profilePrice.create({
        data: {
          profileId,
          timeBand: it.timeBand,
          visitType: it.visitType,
          unit: it.unit === '1h' ? ('_1h' as any) : it.unit === '2h' ? ('_2h' as any) : it.unit,
          amountMinor: BigInt(it.amountMinor),
          currency: it.currency || 'RUB',
          outcallTravel: it.outcallTravel || 'none',
          note: it.note || null,
        },
      });
    }
  });
  const saved = await db.profilePrice.findMany({ where: { profileId } });
  res.json(
    saved.map((r: any) => ({
      timeBand: r.timeBand,
      visitType: r.visitType,
      unit: r.unit === '_1h' ? '1h' : r.unit === '_2h' ? '2h' : r.unit,
      amountMinor: String(r.amountMinor),
      currency: r.currency,
      outcallTravel: r.outcallTravel,
      note: r.note,
    })),
  );
});

// Bind services list (replace snapshot)
app.put('/v1/me/profiles/:id/services', requireSession, async (req, res) => {
  const userId = (req as any).userId as bigint;
  const idStr = String(req.params.id || '');
  if (!/^\d+$/.test(idStr)) return res.status(400).json({ code: 'profiles.invalid_id' });
  const profileId = BigInt(idStr);
  const p = await db.profile.findFirst({ where: { id: profileId, userId } });
  if (!p) return res.status(404).json({ code: 'profiles.not_found' });
  const { serviceIds, custom } = req.body || {};
  if (!Array.isArray(serviceIds)) return res.status(400).json({ code: 'services.invalid' });
  if (serviceIds.length > 25) return res.status(400).json({ code: 'services.limit_exceeded' });
  await db.$transaction(async (tx: any) => {
    await tx.profileService.deleteMany({ where: { profileId } });
    for (const sid of serviceIds) {
      await tx.profileService.create({ data: { profileId, serviceId: BigInt(sid) } });
    }
    await tx.profileCustomService.deleteMany({ where: { profileId } });
    if (Array.isArray(custom)) {
      for (const t of custom) {
        const text = String(t || '').trim();
        if (text) await tx.profileCustomService.create({ data: { profileId, text } });
      }
    }
  });
  return res.status(204).send();
});

// Submit profile
app.post('/v1/me/profiles/:id/submit', requireSession, async (req, res) => {
  const userId = (req as any).userId as bigint;
  const idStr = String(req.params.id || '');
  if (!/^\d+$/.test(idStr)) return res.status(400).json({ code: 'profiles.invalid_id' });
  const profileId = BigInt(idStr);
  const p = await db.profile.findFirst({ where: { id: profileId, userId } });
  if (!p) return res.status(404).json({ code: 'profiles.not_found' });
  if (!['draft', 'needs_fix'].includes(p.status))
    return res.status(400).json({ code: 'profiles.invalid_state' });
  const ready = await isReadyToSubmit(profileId);
  if (!ready.ok)
    return res.status(400).json({ code: 'profiles.not_ready_to_submit', reasons: ready.reasons });
  await db.profile.update({
    where: { id: profileId },
    data: { status: 'submitted', updatedAt: new Date() },
  });
  // here: emit profile.submitted and create moderation task in future step
  await db.profile.update({
    where: { id: profileId },
    data: { status: 'pending_moderation', updatedAt: new Date() },
  });
  return res.status(202).send();
});

// Patch photo: setCover or reorder (orderIndex)
app.patch('/v1/me/profiles/:id/photos/:photoId', requireSession, async (req, res) => {
  const userId = (req as any).userId as bigint;
  const idStr = String(req.params.id || '');
  const photoStr = String(req.params.photoId || '');
  if (!/^\d+$/.test(idStr) || !/^\d+$/.test(photoStr))
    return res.status(400).json({ code: 'media.invalid_id' });
  const profileId = BigInt(idStr);
  const photoId = BigInt(photoStr);
  const p = await db.profile.findFirst({ where: { id: profileId, userId } });
  if (!p) return res.status(404).json({ code: 'profiles.not_found' });
  const photo = await db.profilePhoto.findFirst({ where: { id: photoId, profileId } });
  if (!photo) return res.status(404).json({ code: 'media.not_found' });

  const wantsCover = typeof req.body?.isCover === 'boolean' ? Boolean(req.body.isCover) : undefined;
  const desiredOrder =
    req.body?.orderIndex !== undefined && req.body?.orderIndex !== null
      ? Number(req.body.orderIndex)
      : undefined;

  if (wantsCover === undefined && desiredOrder === undefined) {
    return res.status(400).json({ code: 'media.nothing_to_update' });
  }

  if (wantsCover === true) {
    // Ensure only one cover per profile
    await db.$transaction([
      db.profilePhoto.updateMany({ where: { profileId, isCover: true }, data: { isCover: false } }),
      db.profilePhoto.update({ where: { id: photoId }, data: { isCover: true } }),
    ]);
  } else if (wantsCover === false) {
    await db.profilePhoto.update({ where: { id: photoId }, data: { isCover: false } });
  }

  if (desiredOrder !== undefined && Number.isFinite(desiredOrder)) {
    let position = Math.max(1, Math.floor(desiredOrder)) * 10;
    // Find a free position to keep unique constraint
    // (simple linear probe; fine for small counts)
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const exists = await db.profilePhoto.count({
        where: { profileId, position, NOT: { id: photoId } },
      });
      if (exists === 0) break;
      position += 1;
    }
    await db.profilePhoto.update({ where: { id: photoId }, data: { position } });
  }

  const updated = await db.profilePhoto.findUnique({ where: { id: photoId } });
  return res.json({
    photoId: Number(updated!.id),
    isCover: updated!.isCover,
    orderIndex: updated!.position,
  });
});

app.post('/v1/auth/email/request', (req, res) => {
  const email = String(req.body?.email || '')
    .trim()
    .toLowerCase();
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!email || !emailRegex.test(email)) {
    return res.status(400).json({ code: 'auth.invalid_email', message: 'Invalid email' });
  }
  // Create challenge (passwordless) per ADR-003. Always 204 to avoid enumeration.
  (async () => {
    const rl = await rateLimit(`auth:email_request:${email}`, 5, 3600);
    if (!rl.allowed) return; // 204 regardless
    const code = Math.floor(100000 + Math.random() * 900000).toString(); // 6 digits
    const tokenHash = crypto.createHash('sha256').update(code).digest('hex');
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes
    try {
      await db.authChallenge.create({
        data: {
          channel: 'email',
          purpose: 'login_otp',
          target: email,
          tokenHash,
          state: 'pending',
          expiresAt,
          meta: { ip: req.ip },
        },
      });
      // For local dev visibility only (no leak in response)
      // eslint-disable-next-line no-console
      console.log(`[dev] email OTP for ${email}: ${code} (expires ${expiresAt.toISOString()})`);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('challenge.create failed', e);
    }
  })();
  return res.status(204).send();
});

const port = Number(process.env.API_PORT || 3000);
app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`API listening on http://localhost:${port}`);
});

app.get('/v1/auth/session', async (req, res) => {
  const found = await findSessionByCookie(req);
  if (!found || !found.session) return res.status(401).json({ code: 'auth.unauthorized' });
  const sess = found.session;
  return res
    .status(200)
    .json({ userId: String(sess.userId), expiresAt: sess.expiresAt.toISOString() });
});

app.delete('/v1/auth/session', async (req, res) => {
  const found = await findSessionByCookie(req);
  if (!found || !found.session) return res.status(204).send();
  await db.session.update({ where: { id: found.session.id }, data: { revokedAt: new Date() } });
  const clear = cookie.serialize('sid', '', {
    httpOnly: true,
    secure: false,
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  });
  res.setHeader('Set-Cookie', clear);
  return res.status(204).send();
});
app.post('/v1/auth/email/verify', async (req, res) => {
  try {
    const email = String(req.body?.email || '')
      .trim()
      .toLowerCase();
    const code = String(req.body?.code || '').trim();
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!email || !emailRegex.test(email) || !/^\d{6}$/.test(code)) {
      return res.status(400).json({ code: 'auth.invalid_input', message: 'Invalid input' });
    }
    const rl = await rateLimit(`auth:email_verify:${email}`, 10, 3600);
    if (!rl.allowed) return res.status(429).json({ code: 'rate_limited' });
    const tokenHash = crypto.createHash('sha256').update(code).digest('hex');
    const ch = await db.authChallenge.findFirst({
      where: {
        target: email,
        channel: 'email',
        purpose: 'login_otp',
        tokenHash,
        state: 'pending',
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (!ch) {
      return res.status(400).json({ code: 'auth.invalid_code', message: 'Invalid code' });
    }
    // create or update by email (email may not be unique in current schema)
    let user = await db.user.findFirst({ where: { email } });
    if (user) {
      user = await db.user.update({
        where: { id: user.id },
        data: { emailVerified: true, updatedAt: new Date() },
      });
    } else {
      user = await db.user.create({ data: { email, emailVerified: true } });
    }
    // issue session (opaque)
    const raw = crypto.randomBytes(32).toString('hex');
    const sidHash = crypto.createHash('sha256').update(raw).digest('hex');
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    await db.session.create({
      data: {
        userId: user.id, // Prisma maps to BigInt
        tokenHash: sidHash,
        expiresAt,
        ip: req.ip,
        userAgent: (req.headers['user-agent'] as string) || null,
      },
    });
    await db.authChallenge.update({
      where: { id: ch.id },
      data: { state: 'verified', verifiedAt: new Date() },
    });
    const sidCookie = cookie.serialize('sid', raw, {
      httpOnly: true,
      secure: false,
      sameSite: 'lax',
      path: '/',
      maxAge: 30 * 24 * 60 * 60,
    });
    const csrf = generateCsrfToken();
    const csrfCookie = cookie.serialize('csrf', csrf, {
      httpOnly: false,
      secure: false,
      sameSite: 'lax',
      path: '/',
      maxAge: 30 * 24 * 60 * 60,
    });
    res.setHeader('Set-Cookie', sidCookie);
    res.appendHeader('Set-Cookie', csrfCookie);
    return res.status(200).json({ userId: String(user.id), csrfToken: csrf });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('verify error', err);
    return res.status(500).json({ code: 'internal_error' });
  }
});
