# Accessibility

Target: WCAG 2.2 AA. These are the mechanisms the design system provides;
modules must not disable them.

## Colour and contrast

- Text tokens meet 4.5:1 on their surfaces in both themes (`--foreground`,
  `--muted-foreground`); `--subtle-foreground` is for placeholders and
  decorative captions only.
- Semantic tones are paired with `-foreground` colours for solid fills and
  10% soft fills with the tone as text, which keeps ≥ 4.5:1.
- **No colour-only meaning**: `StatusBadge` = icon/dot + text, `DeltaIndicator`
  = arrow + sign + sr-only direction, negative money = sign or parentheses,
  chart series have legends and `<title>`s, donut segments list values.

## Keyboard

- Global `:focus-visible` outline (2px `--ring`, 2px offset) is set once in
  `styles.css`; components add `focus-visible:ring-2` where the outline would
  be clipped. Never `outline: none` without a replacement.
- Skip link ("Skip to content") is the first focusable element.
- Sidebar: Tab through links; ↑/↓ move between links; collapsed sections open
  menus (Radix roving focus).
- Data tables: clickable rows are focusable (`tabIndex=0`), ↑/↓ move rows,
  Enter opens; sortable headers are buttons with `aria-sort`.
- Command palette: `Ctrl+K`, type, ↑/↓, Enter, Esc. Dialogs trap focus and
  close with Esc (Radix). Confirm buttons receive focus on open.
- Shortcut chords never fire inside inputs; `?` opens the shortcut list.

## Screen readers

- Status badges expose their text; dots have `role="img"` + label when they
  stand alone; decorative icons are `aria-hidden`.
- `AnimatedNumber` exposes the final value in `aria-label` and hides the
  tween; `AnimatedProgress` is a `progressbar` with value and label.
- `OperationProgress` announces completion/failure through a polite live
  region; `StepTimeline` marks the current step with `aria-current="step"` and
  spells out states in sr-only text.
- Tables: `TableHead` uses real `<th>`; numeric cells stay in `<td>`.
- Forms: `FormMessage` is `role="alert"`, controls get `aria-invalid` and
  `aria-describedby`; required labels show `*` (visual) — add "required" text
  in the description when needed.
- Toaster regions come from sonner (`aria-live`).

## Motion

`prefers-reduced-motion` removes non-essential animation and durations
(see [motion](./motion.md)); state changes remain visible.

## Theming

`color-scheme` is set with the theme so native controls (date pickers,
scrollbars) match. The theme is applied before hydration to avoid a flash.

## Checklist for new screens

1. Every action reachable by keyboard; focus visible.
2. Status never colour-only.
3. Loading, empty and error states present.
4. Numbers formatted through the financial components.
5. Labels on icon-only buttons (`aria-label`).
6. Test with `reducedMotion: 'reduce'` (Playwright) and both themes.
