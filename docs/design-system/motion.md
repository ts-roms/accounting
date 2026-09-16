# Motion

**Quiet motion that communicates state.** Every animation must answer "what
does this help the user understand?" — a state change, progress, hierarchy,
feedback, navigation, confirmation, error, or a changed value. Nothing else
moves.

## Implementation

No runtime animation library is used. Overlay enter/exit, timelines and
checkmarks are CSS keyframes driven by tokens; counters, progress bars and
chart draw-ins are `transform`/`opacity`/`stroke` transitions or a small
`requestAnimationFrame` tween (`useAnimatedValue`). This keeps the bundle
unchanged, keeps everything GPU-friendly, and lets `prefers-reduced-motion`
collapse every duration in one place.

## Tokens (`styles.css`, `theme/motion.ts`)

| Token             | ms  | Used for                                          |
| ----------------- | --- | ------------------------------------------------- |
| `--motion-fast`   | 100 | hover, press, tooltips, menu items, tab indicator |
| `--motion-normal` | 150 | dropdowns, dialogs, page enter, switch            |
| `--motion-medium` | 200 | sidebar width, timeline reveal, success check     |
| `--motion-slow`   | 400 | progress width, reconciliation counters           |
| `--motion-data`   | 700 | dashboard counters, chart draw-in                 |

Easing: `--easing-out` (default enter), `--easing-in-out` (exit, colour),
`--easing-spring-subtle` (reserved; barely overshoots). Reveal stagger:
`STAGGER_MS = 60`.

Tailwind utilities: `duration-fast|normal|medium|slow|data`, `ease-out`,
`ease-in-out`, `ease-spring-subtle`.

## Utilities

Compose an enter animation from the keyframe utility plus effect modifiers:

```tsx
<div className="animate-enter fade-in slide-in-up-1" />          // page content
<Content className="data-[state=open]:animate-enter data-[state=open]:fade-in data-[state=open]:scale-in-98 data-[state=closed]:animate-exit data-[state=closed]:fade-out" />
```

Modifiers: `fade-in|out`, `scale-in-98|95|80`, `scale-out-98`,
`slide-in-up-1|2`, `slide-in-down-1`, `slide-in-left-1`, `slide-in-right-1`,
`slide-in-from-left|right`, `slide-out-to-left|right`. Shared overlay class
sets live in `packages/ui/src/lib/overlay.ts` (`overlayMotion`,
`tooltipMotion`).

React helpers (`@accounting/ui`): `FadeIn`, `SlideUp`, `ScaleIn`,
`PageTransition`, `AnimatedNumber` / `AnimatedCounter`, `AnimatedProgress`,
`AnimatedCheck`, `AnimatedStatus`, `useAnimatedValue`, `useReducedMotion`.

## Recipes

| Element                     | Motion                                                                                          |
| --------------------------- | ----------------------------------------------------------------------------------------------- |
| Page change                 | opacity 0→1, translateY 4px→0, 150ms (`PageTransition`)                                         |
| Sidebar collapse            | width 240↔56px, 200ms ease-out; labels fade                                                     |
| Dialog                      | overlay fade; content fade + scale 0.98→1, 150ms; exit 100ms                                    |
| Dropdown / popover / select | fade + scale 0.98 + 4px toward trigger, 100ms                                                   |
| Tooltip                     | fade + 2–4px, 100ms                                                                             |
| Button                      | colour 100ms, press scale 0.99, spinner + label swap while loading                              |
| Tabs                        | immediate; indicator colour 100ms                                                               |
| Toast                       | sonner defaults, 4s, top-right                                                                  |
| Dashboard metric            | count-up over 700ms on first paint; re-tweens only when the value changes                       |
| Charts                      | line draws left→right, bars grow, donut sweeps — once per data change                           |
| Journal post / approve      | checklist runs together, results revealed with 60ms stagger, "POSTED" fades in                  |
| Approval timeline           | completed steps revealed with stagger; current step has a soft ring (2.4s pulse, low amplitude) |
| Success                     | check scales 0.8→1 + fade, 200ms; stroke draws 400ms                                            |
| Reconciliation              | counters tween 400ms; progress width 400ms                                                      |
| Integration sync            | processed counts tween; spinner while running                                                   |
| Table fetch                 | 2px progress line + slight opacity; rows never move                                             |

## Rules

- Only `transform`, `opacity`, `stroke-dashoffset`, colours and width of a
  known-small element (progress/sidebar) are animated.
- Never animate table rows individually, never loop, never flash.
- Pulses are reserved for "in progress" (`StatusDot pulse`, current timeline
  step) and are slow and low-contrast.
- Data refresh updates values in place (`AnimatedNumber` with
  `animateOnMount={false}`); never flash a region.

## Reduced motion

`@media (prefers-reduced-motion: reduce)` sets every `--motion-*` to `0ms`,
forces animation/transition durations to ~0 and keeps only spinners (slowed).
`useReducedMotion()` lets JS tweens jump straight to the final value. State
remains visible: checkmarks, badges and progress bars render their end state.
