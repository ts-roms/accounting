/*
 * Prompt #13 - lease accounting (lessee) & fixed-asset extensions.
 * Enumerations shared by the API, validation schemas and the web client.
 */

/**
 * FINANCE: on-balance-sheet (IFRS 16 / ASC 842 lessee model) - a right-of-use
 * asset and a lease liability are recognized at commencement; runs post
 * interest accretion and straight-line depreciation. SHORT_TERM and
 * LOW_VALUE are the recognition exemptions: nothing is capitalised and each
 * payment is expensed when it is paid.
 */
export const LEASE_CLASSIFICATIONS = ['FINANCE', 'SHORT_TERM', 'LOW_VALUE'] as const;
export type LeaseClassification = (typeof LEASE_CLASSIFICATIONS)[number];

export const LEASE_PAYMENT_FREQUENCIES = ['MONTHLY', 'QUARTERLY', 'ANNUAL'] as const;
export type LeasePaymentFrequency = (typeof LEASE_PAYMENT_FREQUENCIES)[number];

/** IN_ADVANCE: paid at the start of each period (first payment on commencement); IN_ARREARS: at the end. */
export const LEASE_PAYMENT_TIMINGS = ['IN_ADVANCE', 'IN_ARREARS'] as const;
export type LeasePaymentTiming = (typeof LEASE_PAYMENT_TIMINGS)[number];

/**
 * DRAFT: contract captured, nothing in the ledger. ACTIVE: commenced (finance
 * leases carry a right-of-use asset and a liability). COMPLETED: every
 * schedule line posted and paid. TERMINATED: derecognized before the end of
 * the term.
 */
export const LEASE_STATUSES = ['DRAFT', 'ACTIVE', 'COMPLETED', 'TERMINATED'] as const;
export type LeaseStatus = (typeof LEASE_STATUSES)[number];

/**
 * PENDING: waiting for its run. POSTED: interest and depreciation in the
 * ledger (or, for exempt leases, nothing to post - lines flip to POSTED when
 * paid). CANCELLED: superseded by a remeasurement or termination.
 */
export const LEASE_LINE_STATUSES = ['PENDING', 'POSTED', 'CANCELLED'] as const;
export type LeaseLineStatus = (typeof LEASE_LINE_STATUSES)[number];

export const LEASE_RUN_STATUSES = ['POSTED', 'REVERSED'] as const;
export type LeaseRunStatus = (typeof LEASE_RUN_STATUSES)[number];

/** Every change to a lease's carrying amounts, with its ledger link. */
export const LEASE_EVENT_TYPES = [
  'COMMENCEMENT',
  'INTEREST',
  'DEPRECIATION',
  'PAYMENT',
  'REMEASUREMENT',
  'TERMINATION',
] as const;
export type LeaseEventType = (typeof LEASE_EVENT_TYPES)[number];

/** Integrity checks run by `GET /leases/integrity`. */
export const LEASE_INTEGRITY_CHECKS = [
  'LEASE_LIABILITY_VS_LEDGER',
  'ROU_ASSET_VS_LEDGER',
  'LEASE_SCHEDULE_TOTALS',
  'LEASE_RUNS_OVERDUE',
  'LEASE_PAYMENTS_OVERDUE',
] as const;
export type LeaseIntegrityCheck = (typeof LEASE_INTEGRITY_CHECKS)[number];
