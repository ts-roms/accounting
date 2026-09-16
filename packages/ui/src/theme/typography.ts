/**
 * Typography scale. Each entry maps to a `type-*` utility generated in
 * styles.css so markup stays declarative (`className="type-h2"`).
 */
export const typography = {
  display: 'type-display',
  h1: 'type-h1',
  h2: 'type-h2',
  h3: 'type-h3',
  h4: 'type-h4',
  body: 'type-body',
  bodySm: 'type-body-sm',
  caption: 'type-caption',
  label: 'type-label',
  mono: 'type-mono',
  financialNumber: 'type-financial',
} as const;

export const fontFamilies = {
  sans: 'var(--font-sans)',
  mono: 'var(--font-mono)',
} as const;
