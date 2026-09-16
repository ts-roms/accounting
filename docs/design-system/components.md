# Components

Generic components live in `@accounting/ui` (`packages/ui/src/components`);
domain components live in `apps/web/components/<area>`. Import from
`@accounting/ui` or the domain folder — never copy a component into a module.

## Layout & navigation (`apps/web/components/app-shell`)

| Component                                        | Notes                                                                                                                                       |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `AppShell`                                       | top bar + collapsible sidebar + scrolling main; wraps content in `PageTransition`; skip-link to `#main-content`                             |
| `Sidebar` / `SidebarProvider` / `useSidebar`     | 240px expanded, 56px collapsed (icon per section opens a menu). Persists in `localStorage`, `Ctrl+B` toggles, arrow keys move between links |
| `Header`                                         | breadcrumb (section / group / page), global search, company switcher, notifications, `ThemeToggle`, user menu                               |
| `CommandMenu`                                    | `Ctrl+K` commands, `Ctrl+/` record search (journals, invoices, bills, customers, vendors, accounts, grouped by category)                    |
| `KeyboardShortcutsDialog` / `useGlobalShortcuts` | shortcut registry (`lib/navigation.ts: SHORTCUTS`, `GO_TO`)                                                                                 |
| `PageHeader` (`components/ui-ext/page`)          | eyebrow, title, description, actions                                                                                                        |

Navigation structure is `lib/navigation.ts` (`NAVIGATION`, `groupItems`).

## Primitives (`@accounting/ui`)

`Button` (variants `default` primary / `outline` / `secondary` / `destructive` /
`ghost` / `link`; sizes `xs`–`lg`, icon sizes; `loading` + `loadingText`
disables and shows progress) · `Input` / `Textarea` · `Select` · `Checkbox` ·
`Switch` · `Label` (`required`) · `Form*` (react-hook-form) · `Card*` ·
`Badge` (tones) · `Kbd` · `Separator` · `Skeleton` · `Tabs` (`segmented` |
`underline`) · `Tooltip` · `Popover` · `DropdownMenu` · `Dialog` /
`SheetContent` (`side`) · `Command*` · `Alert` (tones + optional default icon) ·
`Table*` (`TableHeader sticky`, `TableHead align`, `TableCell numeric`).

## Status (`@accounting/ui` + `apps/web/components/status`)

- `StatusBadge tone=… icon? active?` — tone colour + icon (or dot) + text.
- `StatusDot`, `HealthIndicator`.
- Domain: `FinancialStatus` (UNPOSTED/POSTED/REVERSED), `JournalStatus`,
  `ApprovalStatus`, `PaymentStatus`, `ReconciliationStatus`,
  `IntegrationStatus`, `PeriodStatus`. `toneOf(variant)` converts the legacy
  badge variant names used by module maps.

## Financial (`apps/web/components/financial`)

`CurrencyDisplay` (`table` | `metric`, `signed`, `animate`) ·
`PercentageDisplay` · `DeltaIndicator` (`direction`) · `AccountCode` ·
`DocumentNumber` · `FinancialMetricCard` (skeleton when `value` undefined,
`message` for unavailable figures, delta, hint, link) · `FinancialHealth`
(integrity, reconciliation, close, exceptions — live data only).
`Amount` in `components/accounting/primitives` remains the table cell.

## Charts (`apps/web/components/charts`)

`LineChart` (draws left→right), `BarChart` (bars grow), `DonutChart`
(segments sweep), `Legend`, `chartColor(i)`. Pure SVG, token colours, one
draw-in over `--motion-data`, static afterwards; `loading` renders
`ChartSkeleton`.

## Data table (`components/ui-ext/data-table`)

Server-driven TanStack table: sticky header, column `meta`
(`{ numeric, align, mono, className }`), sortable headers with `aria-sort`,
keyboard rows (↑/↓, Enter), quiet fetch indicator, `EmptyState`, `error` +
`onRetry` → `ErrorState`, column visibility, pagination.

## Feedback (`@accounting/ui`)

`EmptyState` (icon, title, description, action; `compact`) · `ErrorState`
(reference, correlationId, timestamp, retry) · `SuccessState` (`AnimatedCheck`)
· skeletons: `TableSkeleton`, `CardSkeleton`, `MetricSkeleton`,
`FormSkeleton`, `ChartSkeleton`, `DashboardSkeleton`. Toasts: `sonner`
through `Providers` (short confirmations only).

## Workflow (`@accounting/ui` + `components/accounting`)

- `StepTimeline` — vertical/horizontal; states `complete | current | upcoming |
failed | skipped`; builders in `components/accounting/timelines.tsx`
  (`journalTimeline`, `documentTimeline`, `paymentTimeline`).
- `OperationProgress` — checklist for one atomic server operation.
- `OperationDialog` (`components/accounting/operation-dialog`) — confirm +
  checklist + result; `POSTING_STEPS`, `APPROVAL_STEPS`, error-code → step.

## Delegation / integrations / reconciliation

- `DelegatedAuthorityNotice` (alias `DelegationBanner`) — informational blue
  banner: delegated from, scope, limit, valid until; critical when over limit.
- `SyncProgress` (`components/integrations`) — per-entity latest job with
  live counters; `IntegrationStatusBadge` marks syncing with a pulse.
- `ReconciliationCounters` (`components/banking`) — matched / needs review /
  unmatched with tweened counts and progress.

## Theme (`@accounting/ui`)

`ThemeProvider`, `useTheme`, `ThemeToggle`, `themeInitScript` (inline in
`app/layout.tsx` so the stored theme paints before hydration).
