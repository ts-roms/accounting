# Spacing, radius and elevation

## Spacing

Tailwind's 4px grid, restricted to the steps below (`packages/ui/src/theme/spacing.ts`):

`4 · 8 · 12 · 16 · 20 · 24 · 32 · 40 · 48 · 64`

- Page padding: 16px (mobile) / 24px (desktop). Content max-width 1440px.
- Card padding: 16px. Vertical rhythm between page sections: 20px (`space-y-5`).
- Table cells: 12px horizontal, 8px vertical; header height 36px.
- Form fields: 6px label→control, 16px between fields.

Avoid odd values (`p-[13px]`); if a component needs something new, add a step
here first.

## Radius (`--radius-*`)

| Token         | px  | Use                                         |
| ------------- | --- | ------------------------------------------- |
| `rounded-xs`  | 4   | kbd, tiny chips                             |
| `rounded-sm`  | 6   | buttons, inputs, badges, menu items         |
| `rounded-md`  | 8   | dropdown/popover panels, alerts, tab groups |
| `rounded-lg`  | 10  | cards, tables                               |
| `rounded-xl`  | 12  | dialogs, large containers                   |
| `rounded-2xl` | 16  | reserved for hero containers                |

## Elevation (`--elevation-*` → `shadow-*`)

Hierarchy comes from surface colour and borders. Shadows are used only for:

- `shadow-sm` — buttons and inputs (barely visible in dark mode)
- `shadow-md` — tooltips
- `shadow-lg` — dropdowns, popovers, selects, toasts
- `shadow-overlay` — dialogs, sheets, command palette

Do not put shadows on cards or table rows.
