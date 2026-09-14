import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { P } from '@accounting/types';
import {
  consolidationQuerySchema,
  createIntercompanySchema,
  listIntercompanyQuerySchema,
} from '@accounting/validation';
import type { AuthenticatedUser } from '@/common/auth/authenticated-user';
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import { RequirePermissions } from '@/common/decorators/require-permissions.decorator';
import { ConsolidationService } from './consolidation.service';
import { IntercompanyService } from './intercompany.service';

class ConsolidationQueryDto extends createZodDto(consolidationQuerySchema) {}
class CreateIntercompanyDto extends createZodDto(createIntercompanySchema) {}
class ListIntercompanyQueryDto extends createZodDto(listIntercompanyQuerySchema) {}
class ReasonDto extends createZodDto(z.object({ reason: z.string().trim().min(1).max(500) })) {}

/** Organization-level: these read across companies, so no X-Company-Id is required. */
@ApiTags('Consolidation')
@Controller('consolidation')
export class ConsolidationController {
  constructor(private readonly consolidation: ConsolidationService) {}

  @Get('trial-balance')
  @RequirePermissions(P['consolidation.view'])
  @ApiOperation({
    summary: 'Group trial balance translated at closing rates with intercompany eliminations',
  })
  trialBalance(@CurrentUser() user: AuthenticatedUser, @Query() query: ConsolidationQueryDto) {
    return this.consolidation.trialBalance(user.organizationId, query);
  }
}

@ApiTags('Intercompany')
@Controller('intercompany')
export class IntercompanyController {
  constructor(private readonly intercompany: IntercompanyService) {}

  @Get()
  @RequirePermissions(P['intercompany.view'])
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: ListIntercompanyQueryDto) {
    return this.intercompany.list(user.organizationId, query);
  }

  @Get(':id')
  @RequirePermissions(P['intercompany.view'])
  get(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.intercompany.get(user.organizationId, id);
  }

  @Post()
  @RequirePermissions(P['intercompany.post'])
  create(@CurrentUser() user: AuthenticatedUser, @Body() body: CreateIntercompanyDto) {
    return this.intercompany.create(user.organizationId, user, body);
  }

  @Post(':id/post')
  @RequirePermissions(P['intercompany.post'])
  @ApiOperation({ summary: 'Post the mirrored entries in both companies atomically' })
  post(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.intercompany.post(user.organizationId, user, id);
  }

  @Post(':id/reverse')
  @RequirePermissions(P['intercompany.post'])
  reverse(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ReasonDto,
  ) {
    return this.intercompany.reverse(user.organizationId, user, id, body.reason);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermissions(P['intercompany.post'])
  async remove(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    await this.intercompany.remove(user.organizationId, id);
  }
}
