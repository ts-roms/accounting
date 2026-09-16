# Responsive behaviour

Desktop is the primary experience; the layout degrades deliberately.

| Breakpoint        | Shell                                                                                 | Content                                                                            |
| ----------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| ≥ 1024px (`lg`)   | Sidebar visible (240px, collapsible to 56px), full top bar with breadcrumb and search | Dense tables, 4-column KPI grids, 2–3 column dashboards                            |
| 768–1023px (`md`) | Sidebar hidden behind the menu button (sheet); breadcrumb and search visible          | 2-column grids; tables scroll horizontally inside their container                  |
| < 768px           | Menu button + icon search; company switcher shows the code only                       | Single column; KPI cards stack; dialogs go full-width; command palette top-aligned |

Rules:

- Tables never squeeze: the `Table` wrapper is `overflow-auto` with a sticky
  header; columns keep their alignment. Use column visibility for narrow
  screens rather than wrapping cells.
- Mobile priorities: approvals, notifications, dashboard summaries, search,
  quick actions (command palette). Heavy editing screens are desktop-first.
- Touch targets: buttons are ≥ 32px tall; icon buttons 32–36px.
- Use `sm:` / `lg:` / `xl:` prefixes with the shared grid patterns
  (`grid gap-3 sm:grid-cols-2 xl:grid-cols-4`) instead of custom breakpoints.
- Sheets (`SheetContent side="left"`) host the mobile navigation; dialogs
  keep `max-w-*` and get `sm:rounded-xl` only above mobile.
