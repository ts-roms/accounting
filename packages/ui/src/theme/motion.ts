/**
 * Motion tokens. Durations are CSS custom properties so `prefers-reduced-motion`
 * collapses them to 0ms in one place; `readMotionMs` resolves the live value
 * for JavaScript-driven animation (counters, progress).
 */
export const motion = {
  fast: 'var(--motion-fast)', // 100ms - hover, press, tooltip
  normal: 'var(--motion-normal)', // 150ms - dropdowns, dialogs, page enter
  medium: 'var(--motion-medium)', // 200ms - sidebar width, timeline steps
  slow: 'var(--motion-slow)', // 400ms - success checkmark, progress
  data: 'var(--motion-data)', // 700ms - counters, chart draw
} as const;

export const easing = {
  out: 'var(--easing-out)',
  inOut: 'var(--easing-in-out)',
  springSubtle: 'var(--easing-spring-subtle)',
} as const;

/** Default millisecond values (mirrors styles.css) for SSR and tests. */
export const MOTION_MS = { fast: 100, normal: 150, medium: 200, slow: 400, data: 700 } as const;

export type MotionToken = keyof typeof MOTION_MS;

/** Resolve a motion token to milliseconds, honouring the reduced-motion override. */
export function readMotionMs(token: MotionToken): number {
  if (typeof window === 'undefined') return MOTION_MS[token];
  const raw = getComputedStyle(document.documentElement).getPropertyValue(`--motion-${token}`);
  const parsed = parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : MOTION_MS[token];
}

/** Stagger between sibling reveals (checklist steps, list items). */
export const STAGGER_MS = 60;
