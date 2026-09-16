/**
 * Semantic colour tokens. Values are CSS custom properties so JavaScript
 * consumers (charts, canvas, inline SVG) follow the active theme without
 * duplicating hex values. The hex palette itself lives in styles.css.
 */
export const colors = {
  background: 'var(--background)',
  foreground: 'var(--foreground)',
  card: 'var(--card)',
  popover: 'var(--popover)',
  surface: 'var(--surface)',
  surfaceElevated: 'var(--surface-elevated)',
  primary: 'var(--primary)',
  primaryForeground: 'var(--primary-foreground)',
  muted: 'var(--muted)',
  mutedForeground: 'var(--muted-foreground)',
  subtleForeground: 'var(--subtle-foreground)',
  border: 'var(--border)',
  borderStrong: 'var(--border-strong)',
  ring: 'var(--ring)',
} as const;

/** Financial semantics. Never communicate status with colour alone. */
export const semantic = {
  positive: 'var(--positive)',
  warning: 'var(--warning)',
  critical: 'var(--critical)',
  info: 'var(--info)',
  neutral: 'var(--neutral)',
} as const;

/** Categorical chart series (5 max; use tones for more). */
export const chartSeries = [
  'var(--chart-1)',
  'var(--chart-2)',
  'var(--chart-3)',
  'var(--chart-4)',
  'var(--chart-5)',
] as const;

export type SemanticTone = keyof typeof semantic;
