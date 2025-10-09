import { Controller, Get, Post, Patch, Put, Res, Req, Param, Body } from '@nestjs/common';
import type { Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { eventBus } from '@shared/event-bus';

const db = new PrismaClient() as any;

@Controller('/v1/me/profiles')
export class ProfilesController {
  private async isReadyToSubmit(profileId: bigint) {
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
  @Get()
  async list(@Req() req: Request, @Res() res: Response) {
    const userId = (req as any).userId as bigint;
    const rows = await db.profile.findMany({ where: { userId } });
    const items = rows.map((p: any) => ({
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
    return res.json(items);
  }

  @Post()
  async create(@Req() req: Request, @Res() res: Response) {
    const userId = (req as any).userId as bigint;
    const nickname = String((req.body as any)?.nickname || '').trim();
    if (!nickname)
      return res.status(400).json({ code: 'profiles.invalid', message: 'nickname required' });
    const p = await db.profile.create({
      data: { userId, status: 'draft', nickname, isVisible: false },
    });
    return res.status(201).json({
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
  }

  @Patch('/:id')
  async patch(@Req() req: Request, @Res() res: Response) {
    const userId = (req as any).userId as bigint;
    const idStr = String(req.params.id || '');
    if (!/^\d+$/.test(idStr)) return res.status(400).json({ code: 'profiles.invalid_id' });
    const id = BigInt(idStr);
    const p = await db.profile.findFirst({ where: { id, userId } });
    if (!p) return res.status(404).json({ code: 'profiles.not_found' });
    if (!['draft', 'needs_fix'].includes(p.status))
      return res.status(400).json({ code: 'profiles.invalid_state' });
    const data: any = {};
    if (typeof (req.body as any)?.nickname === 'string')
      data.nickname = String((req.body as any).nickname).trim();
    data.updatedAt = new Date();
    const upd = await db.profile.update({ where: { id }, data });
    return res.json({
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
  }

  // PUT /v1/me/profiles/:id/prices — полная замена матрицы
  @Put('/:id/prices')
  async upsertPrices(@Req() req: Request, @Res() res: Response) {
    const userId = (req as any).userId as bigint;
    const idStr = String(req.params.id || '');
    if (!/^\d+$/.test(idStr)) return res.status(400).json({ code: 'profiles.invalid_id' });
    const profileId = BigInt(idStr);
    const p = await db.profile.findFirst({ where: { id: profileId, userId } });
    if (!p) return res.status(404).json({ code: 'profiles.not_found' });
    const body = Array.isArray(req.body) ? req.body : [];
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
        const unitEnum = it.unit === '1h' ? 'ONE_H' : it.unit === '2h' ? 'TWO_H' : it.unit;
        await tx.profilePrice.create({
          data: {
            profileId,
            timeBand: it.timeBand,
            visitType: it.visitType,
            unit: unitEnum,
            amountMinor: BigInt(it.amountMinor),
            currency: it.currency || 'RUB',
            outcallTravel: it.outcallTravel || 'none',
            note: it.note || null,
          },
        });
      }
    });
    const saved = await db.profilePrice.findMany({ where: { profileId } });
    return res.json(
      saved.map((r: any) => ({
        timeBand: r.timeBand,
        visitType: r.visitType,
        unit: r.unit === 'ONE_H' ? '1h' : r.unit === 'TWO_H' ? '2h' : r.unit,
        amountMinor: String(r.amountMinor),
        currency: r.currency,
        outcallTravel: r.outcallTravel,
        note: r.note,
      })),
    );
  }

  // PUT /v1/me/profiles/:id/services — замена snapshot
  @Put('/:id/services')
  async upsertServices(@Req() req: Request, @Res() res: Response) {
    const userId = (req as any).userId as bigint;
    const idStr = String(req.params.id || '');
    if (!/^\d+$/.test(idStr)) return res.status(400).json({ code: 'profiles.invalid_id' });
    const profileId = BigInt(idStr);
    const p = await db.profile.findFirst({ where: { id: profileId, userId } });
    if (!p) return res.status(404).json({ code: 'profiles.not_found' });
    const { serviceIds, custom } = (req.body as any) || {};
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
  }

  // POST /v1/me/profiles/:id/submit
  @Post('/:id/submit')
  async submit(@Req() req: Request, @Res() res: Response) {
    const userId = (req as any).userId as bigint;
    const idStr = String(req.params.id || '');
    if (!/^\d+$/.test(idStr)) return res.status(400).json({ code: 'profiles.invalid_id' });
    const profileId = BigInt(idStr);
    const p = await db.profile.findFirst({ where: { id: profileId, userId } });
    if (!p) return res.status(404).json({ code: 'profiles.not_found' });
    if (!['draft', 'needs_fix'].includes(p.status))
      return res.status(400).json({ code: 'profiles.invalid_state' });
    const ready = await this.isReadyToSubmit(profileId);
    if (!ready.ok)
      return res.status(400).json({ code: 'profiles.not_ready_to_submit', reasons: ready.reasons });
    await db.profile.update({
      where: { id: profileId },
      data: { status: 'submitted', updatedAt: new Date() },
    });
    await eventBus.emit({
      name: 'profile.submitted',
      id: crypto.randomUUID(),
      at: new Date().toISOString(),
      actor: { type: 'user', id: String(userId) },
      payload: { profileId: String(profileId), userId: String(userId) },
    });
    await db.profile.update({
      where: { id: profileId },
      data: { status: 'pending_moderation', updatedAt: new Date() },
    });
    return res.status(202).send();
  }
}
