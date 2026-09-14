import { SetMetadata } from '@nestjs/common';

export const COMPANY_SCOPED_KEY = 'companyScoped';

/**
 * Requires the X-Company-Id header. Accounting endpoints (Phase 2+) are always
 * company-scoped because every ledger record belongs to one legal entity.
 */
export const CompanyScoped = () => SetMetadata(COMPANY_SCOPED_KEY, true);
