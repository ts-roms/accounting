# Keyboard shortcuts

Defined in `apps/web/lib/navigation.ts` (`SHORTCUTS`, `GO_TO`) and handled by
`useGlobalShortcuts` in `components/app-shell/shortcuts.tsx`. The in-app list
opens with `?` or from the user menu.

| Shortcut              | Action                                                                                        |
| --------------------- | --------------------------------------------------------------------------------------------- |
| `Ctrl` `K` (`⌘K`)     | Command palette (create, open, navigate, integration actions, switch company, theme, sidebar) |
| `Ctrl` `/`            | Record search (invoice #, journal #, customer, vendor, account) — same palette in search mode |
| `Ctrl` `B`            | Toggle sidebar collapse                                                                       |
| `?`                   | Keyboard shortcuts dialog                                                                     |
| `Esc`                 | Close dialog / palette / menu                                                                 |
| `G` then `D`          | Go to dashboard                                                                               |
| `G` then `J`          | Go to journal entries                                                                         |
| `G` then `L`          | Go to general ledger                                                                          |
| `G` then `I`          | Go to invoices                                                                                |
| `G` then `B`          | Go to bills                                                                                   |
| `G` then `A`          | Go to approvals                                                                               |
| `↑` `↓`               | Move between table rows, menu items, sidebar links, palette results                           |
| `Enter`               | Open the focused row / select the highlighted item / confirm the focused button               |
| `Tab` / `Shift` `Tab` | Move focus; the first stop is "Skip to content"                                               |

Rules:

- Only `Ctrl+K`, `Ctrl+/` and `Ctrl+B` are claimed from the browser. `Ctrl+S`
  is intentionally not intercepted globally; forms submit with `Enter` and
  their primary button.
- Single-key chords never fire while typing in an input, textarea, select or
  contenteditable.
- Chord timeout is 800ms.
- Add new global shortcuts to `SHORTCUTS` so the dialog stays the single
  source of documentation.
