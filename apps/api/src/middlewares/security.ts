import { Injectable, NestMiddleware } from '@nestjs/common';
import type { Request, Response, NextFunction } from 'express';
import cookie from 'cookie';
import crypto from 'crypto';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient() as any;

@Injectable()
export class CsrfMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction) {
    const method = (req.method || 'GET').toUpperCase();
    if (!['POST', 'PATCH', 'PUT', 'DELETE'].includes(method)) return next();
    const origin = req.headers['origin'] || req.headers['referer'];
    if (!origin) return res.status(400).json({ code: 'csrf.missing_origin' });
    const cookieHeader = req.headers['cookie'] || '';
    const cookies = cookie.parse(
      Array.isArray(cookieHeader) ? cookieHeader.join(';') : cookieHeader,
    );
    const csrfCookie = cookies['csrf'];
    const csrfHeader = String(req.headers['x-csrf-token'] || '');
    if (!csrfCookie || !csrfHeader || csrfCookie !== csrfHeader) {
      return res.status(403).json({ code: 'csrf.invalid_token' });
    }
    return next();
  }
}

@Injectable()
export class SessionMiddleware implements NestMiddleware {
  async use(req: Request, res: Response, next: NextFunction) {
    const cookieHeader = req.headers['cookie'] || '';
    const cookies = cookie.parse(
      Array.isArray(cookieHeader) ? cookieHeader.join(';') : cookieHeader,
    );
    const raw = cookies['sid'];
    if (!raw) return res.status(401).json({ code: 'auth.unauthorized' });
    const sidHash = crypto.createHash('sha256').update(raw).digest('hex');
    const now = new Date();
    const session = await prisma.session.findFirst({
      where: { tokenHash: sidHash, revokedAt: null, expiresAt: { gt: now } },
    });
    if (!session) return res.status(401).json({ code: 'auth.unauthorized' });
    (req as any).userId = session.userId;
    return next();
  }
}
