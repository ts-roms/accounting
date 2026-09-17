import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { P } from '@accounting/types';
import type { AuthenticatedUser } from '@/common/auth/authenticated-user';
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import { RequirePermissions } from '@/common/decorators/require-permissions.decorator';
import { DEAD_LETTER_KINDS, DeadLettersService } from './dead-letters.service';
import { IntegrationRetentionService } from './integration-retention.service';

class DeadLetterRefDto extends createZodDto(
  z.object({ kind: z.enum(DEAD_LETTER_KINDS), id: z.string().uuid() }),
) {}
class ReplayAllDto extends createZodDto(z.object({ kind: z.enum(DEAD_LETTER_KINDS).optional() })) {}

/** Operator's view of the integration platform: the dead-letter queue and the retention policy. */
@ApiTags('Integrations')
@Controller('integrations/ops')
export class IntegrationOpsController {
  constructor(
    private readonly deadLetters: DeadLettersService,
    private readonly retention: IntegrationRetentionService,
  ) {}

  @Get('dead-letters')
  @RequirePermissions(P['integration.view'])
  @ApiOperation({
    summary:
      'Exhausted deliveries, failed events and failed jobs waiting for a replay or a discard',
  })
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.deadLetters.list(user.organizationId);
  }

  @Post('dead-letters/replay')
  @HttpCode(200)
  @RequirePermissions(P['integration.manage'])
  @ApiOperation({ summary: 'Replay one dead letter through its own idempotent path' })
  replay(@CurrentUser() user: AuthenticatedUser, @Body() body: DeadLetterRefDto) {
    return this.deadLetters.replay(user, body.kind, body.id);
  }

  @Post('dead-letters/replay-all')
  @HttpCode(200)
  @RequirePermissions(P['integration.manage'])
  @ApiOperation({
    summary: 'Replay every dead letter (optionally of one kind); returns counts per kind',
  })
  replayAll(@CurrentUser() user: AuthenticatedUser, @Body() body: ReplayAllDto) {
    return this.deadLetters.replayAll(user, body.kind);
  }

  @Post('dead-letters/discard')
  @HttpCode(200)
  @RequirePermissions(P['integration.manage'])
  @ApiOperation({ summary: 'Acknowledge a dead letter without processing it' })
  discard(@CurrentUser() user: AuthenticatedUser, @Body() body: DeadLetterRefDto) {
    return this.deadLetters.discard(user, body.kind, body.id);
  }

  @Get('retention')
  @RequirePermissions(P['integration.view'])
  @ApiOperation({ summary: 'Retention policy applied by the nightly integration cleanup' })
  retentionPolicy() {
    return this.retention.policy();
  }
}
