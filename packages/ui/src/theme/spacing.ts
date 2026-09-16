/**
 * Spacing scale (px). Matches Tailwind's 4px grid; prefer these steps and
 * avoid ad-hoc values so vertical rhythm stays predictable.
 */
export const spacing = {
  1: 4,
  2: 8,
  3: 12,
  4: 16,
  5: 20,
  6: 24,
  8: 32,
  10: 40,
  12: 48,
  16: 64,
} as const;

/** Layout constants shared by the shell and pages. */
export const layout = {
  topBarHeight: 56,
  sidebarWidth: 240,
  sidebarCollapsedWidth: 56,
  contentMaxWidth: 1440,
  pagePadding: { sm: 16, md: 24 },
} as const;
