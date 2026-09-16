# Colours

All colours are CSS custom properties defined in `packages/ui/src/styles.css`
and exposed to Tailwind through `@theme inline` (so `bg-card`, `text-positive`,
`border-info/30` … are utilities). Business modules never hard-code hex values.

## Surfaces and text

| Token                              | Dark      | Light     | Use                                      |
| ---------------------------------- | --------- | --------- | ---------------------------------------- |
| `--background`                     | `#0B0F14` | `#F7F8FA` | page ground                              |
| `--surface` / `--card`             | `#11161D` | `#FFFFFF` | cards, top bar, inputs                   |
| `--surface-elevated` / `--popover` | `#171D26` | `#FFFFFF` | dropdowns, dialogs, tooltips, active tab |
| `--border`                         | `#252D38` | `#E5E7EB` | dividers and card borders                |
| `--border-strong`                  | `#303A47` | `#D1D5DB` | hover borders                            |
| `--foreground`                     | `#F4F7FA` | `#111827` | primary text                             |
| `--muted-foreground`               | `#9AA5B1` | `#64748B` | secondary text                           |
| `--subtle-foreground`              | `#66717E` | `#94A3B8` | placeholders, tertiary text              |
| `--primary`                        | `#3D7FF2` | `#1F5FD6` | brand, primary buttons, selection, links |
| `--ring`                           | `#5B93FF` | `#2F6FE4` | focus ring                               |

Hierarchy in dark mode is background → surface → elevated surface → popover;
never pure black, never pure white text everywhere (three text levels).

## Financial semantics

| Token                  | Meaning                      | Examples                                                         |
| ---------------------- | ---------------------------- | ---------------------------------------------------------------- |
| `--positive` (emerald) | healthy / done               | profit, paid, posted, reconciled, approved, completed            |
| `--warning` (amber)    | needs attention              | pending, requires review, approaching limit, variance, expiring  |
| `--critical` (red)     | failure / risk               | failed, overdue, unbalanced, rejected, negative condition        |
| `--info` (blue)        | information / neutral action | selected, navigation, informational notices, delegated authority |
| `--neutral`            | inactive / archived          | draft (with clock icon = `pending`), reversed, disabled          |

Each has a `-foreground` pair for solid fills. Soft fills use opacity
(`bg-positive/10`, `border-positive/25`). `--destructive` is an alias of
critical kept for shadcn compatibility; `text-success` maps to positive.

**Colour never carries meaning alone.** Use `StatusBadge` (icon/dot + text),
`DeltaIndicator` (arrow + sign) and sign characters on numbers.

## Charts

`--chart-1..5` (blue, emerald, amber, violet, slate) are the categorical
series. Aging buckets use the semantic scale instead (current = positive,
1–30 = info, 31–90 = warning, 90+ = critical).

## Sidebar

`--sidebar*` tokens keep the sidebar on the page ground in dark mode and on
white in light mode so both themes read as one product.

## Adding a colour

Add the token to both `:root` and `.dark`, map it in `@theme inline`, document
it here. Never add a one-off colour to a component.
