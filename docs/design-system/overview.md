# Design system — Executive Finance

The web application uses one visual system for every module. It lives in three
places, and nothing else defines visual values:

| Layer                | Where                                                                                                               | What                                                                                                           |
| -------------------- | ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Tokens               | `packages/ui/src/styles.css`                                                                                        | Colour (light + dark), financial semantics, radius, shadows, motion, typography utilities                      |
| Token access from JS | `packages/ui/src/theme/*`                                                                                           | `colors`, `semantic`, `typography`, `spacing`, `radius`, `shadows`, `motion` (all reference the CSS variables) |
| Components           | `packages/ui/src/components/*` (generic) and `apps/web/components/{financial,status,charts,app-shell,...}` (domain) | shadcn/ui-style primitives plus finance-specific building blocks                                               |

Principle: **quiet motion, strong hierarchy, high information density.** The
interface should get out of the accountant's way.

## Identity

- Dark mode is the primary experience (`#0B0F14` background, `#11161D` surface,
  `#171D26` elevated). Light mode is a sibling with warm neutral whites
  (`#F7F8FA` / `#FFFFFF`), not an inversion.
- Blue is the brand / interactive colour (`--primary`). Green is _not_ the brand:
  it means financial health (paid, posted, reconciled).
- Hierarchy comes from background contrast and borders; shadows are reserved for
  floating surfaces.
- Radii are moderate (6px controls, 10px cards, 12px dialogs). No bubble UI.
- Numbers are always tabular. Currency, codes and document numbers are
  monospace or tabular so columns align.

## Rules for every module

1. Use tokens, never raw colours (`text-positive`, not `text-emerald-600`).
2. Use motion tokens (`duration-fast`, `animate-enter fade-in`), never ad-hoc
   durations. Motion must communicate state.
3. Status is colour **+** icon/dot **+** text (`<StatusBadge>` / domain status
   components in `apps/web/components/status`).
4. Money renders through `CurrencyDisplay` / `Amount`; never `toFixed` in JSX.
5. Dangerous actions confirm through `ConfirmDialog` (destructive style) and
   state the consequence. Accounting operations use `OperationDialog`.
6. Loading = skeleton that matches the layout; empty = `EmptyState` with an
   action; error = `ErrorState` with a retry and a reference — never a stack trace.
7. Keyboard users are first-class: every control has a visible focus ring;
   tables and menus support arrow keys; the palette is `Ctrl+K`.
8. Respect `prefers-reduced-motion` automatically by using the shared
   utilities — do not write your own `@keyframes`.

See the other documents in this folder for detail:
[colors](./colors.md) · [typography](./typography.md) · [spacing](./spacing.md) ·
[components](./components.md) · [motion](./motion.md) ·
[accessibility](./accessibility.md) · [accounting UX](./accounting-ux.md) ·
[responsive](./responsive.md) · [keyboard shortcuts](./keyboard-shortcuts.md)
