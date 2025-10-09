import { Controller, Get, Post, Delete, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import IORedis from 'ioredis';
import crypto from 'crypto';
import cookie from 'cookie';

const db = new PrismaClient() as any;
const redis = new IORedis(process.env.REDIS_URL || 'redis://redis:6379', {
  maxRetriesPerRequest: null as any,
  enableReadyCheck: false,
});

async function rateLimit(key: string, limit: number, windowSeconds: number) {
  const k = `rl:${key}`;
  const tx = (redis as any).multi();
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

@Controller('/v1/auth')
export class AuthController {
  @Get('/session')
  async session(@Req() req: Request, @Res() res: Response) {
    const cookieHeader = req.headers['cookie'] || '';
    const cookies = cookie.parse(
      Array.isArray(cookieHeader) ? cookieHeader.join(';') : cookieHeader,
    );
    const raw = cookies['sid'];
    if (!raw) return res.status(401).json({ code: 'auth.unauthorized' });
    const sidHash = crypto.createHash('sha256').update(raw).digest('hex');
    const now = new Date();
    const session = await db.session.findFirst({
      where: { tokenHash: sidHash, revokedAt: null, expiresAt: { gt: now } },
    });
    if (!session) return res.status(401).json({ code: 'auth.unauthorized' });
    return res.json({ userId: String(session.userId), expiresAt: session.expiresAt.toISOString() });
  }

  @Delete('/session')
  async logout(@Req() req: Request, @Res() res: Response) {
    const cookieHeader = req.headers['cookie'] || '';
    const cookies = cookie.parse(
      Array.isArray(cookieHeader) ? cookieHeader.join(';') : cookieHeader,
    );
    const raw = cookies['sid'];
    if (!raw) return res.status(204).send();
    const sidHash = crypto.createHash('sha256').update(raw).digest('hex');
    const now = new Date();
    const session = await db.session.findFirst({
      where: { tokenHash: sidHash, revokedAt: null, expiresAt: { gt: now } },
    });
    if (session) {
      await db.session.update({ where: { id: session.id }, data: { revokedAt: new Date() } });
    }
    const clear = cookie.serialize('sid', '', {
      httpOnly: true,
      secure: false,
      sameSite: 'lax',
      path: '/',
      maxAge: 0,
    });
    res.setHeader('Set-Cookie', clear);
    return res.status(204).send();
  }

  @Post('/email/request')
  async emailRequest(@Req() req: Request, @Res() res: Response) {
    const email = String((req.body as any)?.email || '')
      .trim()
      .toLowerCase();
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!email || !emailRegex.test(email)) {
      return res.status(400).json({ code: 'auth.invalid_email', message: 'Invalid email' });
    }
    const rl = await rateLimit(`auth:email_request:${email}`, 5, 3600);
    if (!rl.allowed) return res.status(204).send();
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const tokenHash = crypto.createHash('sha256').update(code).digest('hex');
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
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
      // eslint-disable-next-line no-console
      console.log(`[dev] email OTP for ${email}: ${code} (expires ${expiresAt.toISOString()})`);
    } catch {}
    return res.status(204).send();
  }

  @Post('/email/verify')
  async emailVerify(@Req() req: Request, @Res() res: Response) {
    const email = String((req.body as any)?.email || '')
      .trim()
      .toLowerCase();
    const code = String((req.body as any)?.code || '').trim();
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
    if (!ch) return res.status(400).json({ code: 'auth.invalid_code', message: 'Invalid code' });
    let user = await db.user.findFirst({ where: { email } });
    user = user
      ? await db.user.update({
          where: { id: user.id },
          data: { emailVerified: true, updatedAt: new Date() },
        })
      : await db.user.create({ data: { email, emailVerified: true } });
    const raw = crypto.randomBytes(32).toString('hex');
    const sidHash = crypto.createHash('sha256').update(raw).digest('hex');
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    await db.session.create({
      data: {
        userId: user.id,
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
    res.setHeader('Set-Cookie', [sidCookie, csrfCookie]);
    return res.status(200).json({ userId: String(user.id), csrfToken: csrf });
  }
}
