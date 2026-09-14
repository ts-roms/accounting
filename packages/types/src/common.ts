export const ENTITY_STATUSES = ['ACTIVE', 'INACTIVE'] as const;
export type EntityStatus = (typeof ENTITY_STATUSES)[number];

export const USER_STATUSES = ['ACTIVE', 'INACTIVE', 'LOCKED'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

/** ISO-4217 currency code (3 uppercase letters). Default base currency is PHP. */
export type CurrencyCode = string;
export const DEFAULT_BASE_CURRENCY: CurrencyCode = 'PHP';

export interface PaginatedResult<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

/** Standard API error envelope. */
export interface ApiErrorBody {
  code: string;
  message: string;
  details?: Record<string, unknown>;
  correlationId?: string;
}
