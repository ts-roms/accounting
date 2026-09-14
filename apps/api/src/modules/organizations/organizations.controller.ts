import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { P } from '@accounting/types';
import {
  createBranchSchema,
  createCompanySchema,
  updateBranchSchema,
  updateCompanySchema,
  updateOrganizationSchema,
  uuidSchema,
} from '@accounting/validation';
import type { AuthenticatedUser } from '@/common/auth/authenticated-user';
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import { RequirePermissions } from '@/common/decorators/require-permissions.decorator';
import { OrganizationsService } from './organizations.service';

class UpdateOrganizationDto extends createZodDto(updateOrganizationSchema) {}
class CreateCompanyDto extends createZodDto(createCompanySchema) {}
class UpdateCompanyDto extends createZodDto(updateCompanySchema) {}
class CreateBranchDto extends createZodDto(createBranchSchema) {}
class UpdateBranchDto extends createZodDto(updateBranchSchema) {}
class ListBranchesQueryDto extends createZodDto(z.object({ companyId: uuidSchema.optional() })) {}

@ApiTags('Organization')
@Controller()
export class OrganizationsController {
  constructor(private readonly service: OrganizationsService) {}

  @Get('organization')
  @RequirePermissions(P['organization.view'])
  @ApiOperation({ summary: 'Get the caller organization' })
  getOrganization(@CurrentUser() user: AuthenticatedUser) {
    return this.service.getOrganization(user.organizationId);
  }

  @Patch('organization')
  @RequirePermissions(P['organization.manage'])
  updateOrganization(@CurrentUser() user: AuthenticatedUser, @Body() body: UpdateOrganizationDto) {
    return this.service.updateOrganization(user.organizationId, body);
  }

  @Get('companies')
  @RequirePermissions(P['company.view'])
  @ApiOperation({ summary: 'List companies (legal entities) of the organization' })
  listCompanies(@CurrentUser() user: AuthenticatedUser) {
    return this.service.listCompanies(user.organizationId);
  }

  @Get('companies/:id')
  @RequirePermissions(P['company.view'])
  getCompany(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.getCompany(user.organizationId, id);
  }

  @Post('companies')
  @RequirePermissions(P['company.manage'])
  createCompany(@CurrentUser() user: AuthenticatedUser, @Body() body: CreateCompanyDto) {
    return this.service.createCompany(user.organizationId, body);
  }

  @Patch('companies/:id')
  @RequirePermissions(P['company.manage'])
  updateCompany(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateCompanyDto,
  ) {
    return this.service.updateCompany(user.organizationId, id, body);
  }

  @Get('branches')
  @RequirePermissions(P['branch.view'])
  @ApiOperation({ summary: 'List branches, optionally filtered by company' })
  listBranches(@CurrentUser() user: AuthenticatedUser, @Query() query: ListBranchesQueryDto) {
    return this.service.listBranches(user.organizationId, query.companyId);
  }

  @Get('branches/:id')
  @RequirePermissions(P['branch.view'])
  getBranch(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.getBranch(user.organizationId, id);
  }

  @Post('branches')
  @RequirePermissions(P['branch.manage'])
  createBranch(@CurrentUser() user: AuthenticatedUser, @Body() body: CreateBranchDto) {
    return this.service.createBranch(user.organizationId, body);
  }

  @Patch('branches/:id')
  @RequirePermissions(P['branch.manage'])
  updateBranch(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateBranchDto,
  ) {
    return this.service.updateBranch(user.organizationId, id, body);
  }
}
