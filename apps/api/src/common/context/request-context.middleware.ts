import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { HEADERS } from '@accounting/config';
import { RequestContext } from './request-context';

@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const incoming = req.header(HEADERS.CORRELATION_ID);
    const correlationId = incoming && incoming.length <= 128 ? incoming : randomUUID();
    res.setHeader(HEADERS.CORRELATION_ID, correlationId);

    RequestContext.run(
      {
        correlationId,
        ipAddress: req.ip,
        userAgent: req.header('user-agent')?.slice(0, 512),
      },
      () => next(),
    );
  }
}
