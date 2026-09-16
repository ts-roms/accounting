/**
 * Phase 9 - AI assistance. Everything here is advisory: the AI module drafts,
 * suggests, flags and answers; a person reviews and the ordinary services
 * (with their permissions, approvals and posting rules) do the writing.
 */

// --------------------------------------------------------------------- intake

/** Lifecycle of a document dropped into the intake tray. */
export const AI_DOCUMENT_STATUSES = ['EXTRACTED', 'NEEDS_REVIEW', 'DRAFTED', 'DISMISSED'] as const;
export type AiDocumentStatus = (typeof AI_DOCUMENT_STATUSES)[number];

/** What the intake believes the document is. */
export const AI_DOCUMENT_KINDS = ['BILL', 'EXPENSE_CLAIM', 'UNKNOWN'] as const;
export type AiDocumentKind = (typeof AI_DOCUMENT_KINDS)[number];

// ---------------------------------------------------------------- suggestions

export const AI_SUGGESTION_STATUSES = ['OPEN', 'ACCEPTED', 'DISMISSED'] as const;
export type AiSuggestionStatus = (typeof AI_SUGGESTION_STATUSES)[number];

export const AI_ANOMALY_TYPES = [
  'DUPLICATE_DOCUMENT',
  'UNUSUAL_AMOUNT',
  'ROUND_AMOUNT',
  'WEEKEND_POSTING',
  'BACKDATED_ENTRY',
  'MANUAL_CONTROL_POSTING',
  'SAME_PERSON_LIFECYCLE',
] as const;
export type AiAnomalyType = (typeof AI_ANOMALY_TYPES)[number];

export const AI_SEVERITIES = ['LOW', 'MEDIUM', 'HIGH'] as const;
export type AiSeverity = (typeof AI_SEVERITIES)[number];

/** Which side of the books a classification request is for. */
export const AI_CLASSIFY_SIDES = ['PURCHASE', 'SALE', 'EXPENSE'] as const;
export type AiClassifySide = (typeof AI_CLASSIFY_SIDES)[number];

// ------------------------------------------------------------------ assistant

export const AI_MESSAGE_ROLES = ['USER', 'ASSISTANT'] as const;
export type AiMessageRole = (typeof AI_MESSAGE_ROLES)[number];

export const AI_FORECAST_METRICS = ['REVENUE', 'EXPENSES', 'NET_INCOME', 'CASH'] as const;
export type AiForecastMetric = (typeof AI_FORECAST_METRICS)[number];

/** Model backends. HEURISTIC is deterministic and always available (tests, no API key). */
export const AI_PROVIDERS = ['HEURISTIC', 'ANTHROPIC'] as const;
export type AiProvider = (typeof AI_PROVIDERS)[number];
