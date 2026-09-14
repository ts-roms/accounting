import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { P } from '@accounting/types';
import {
  createDimensionSchema,
  listDimensionsQuerySchema,
  updateDimensionSchema,
} from '@accounting/validation';
import type { AuthenticatedUser } from '@/common/auth/authenticated-user';
import { CompanyScoped } from '@/common/decorators/company-scoped.decorator';
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import { RequirePermissions } from '@/common/decorators/require-permissions.decorator';
import { DimensionsService } from './dimensions.service';

class CreateDimensionDto extends createZodDto(createDimensionSchema) {}
class UpdateDimensionDto extends createZodDto(updateDimensionSchema) {}
class ListDimensionsQueryDto extends createZodDto(listDimensionsQuerySchema) {}

@ApiTags('Dimensions')
@Controller('dimensions')
@CompanyScoped()
export class DimensionsController {
  constructor(private readonly dimensions: DimensionsService) {}

  @Get()
  @RequirePermissions(P['dimension.view'])
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: ListDimensionsQueryDto) {
    return this.dimensions.list(user.companyId!, query);
  }

  @Get(':id')
  @RequirePermissions(P['dimension.view'])
  get(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.dimensions.get(user.companyId!, id);
  }

  @Post()
  @RequirePermissions(P['dimension.manage'])
  create(@CurrentUser() user: AuthenticatedUser, @Body() body: CreateDimensionDto) {
    return this.dimensions.create(user.companyId!, user, body);
  }

  @Patch(':id')
  @RequirePermissions(P['dimension.manage'])
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateDimensionDto,
  ) {
    return this.dimensions.update(user.companyId!, user, id, body);
  }
}
