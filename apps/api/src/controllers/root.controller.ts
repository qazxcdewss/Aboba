import { Controller, Get, Res } from '@nestjs/common';
import type { Response } from 'express';

@Controller('/v1')
export class RootController {
  @Get()
  root(@Res() res: Response) {
    return res.json({ name: 'aboba-api', version: '0.1.0' });
  }
}
