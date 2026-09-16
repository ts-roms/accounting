'use client';
import * as React from 'react';
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
  type VisibilityState,
} from '@tanstack/react-table';
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronLeft, ChevronRight, Columns3 } from 'lucide-react';
import {
  Button,
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  cn,
} from '@accounting/ui';
import type { PaginatedResult } from '@accounting/types';
import { EmptyState, ErrorState, TableSkeleton } from './page';
import { ApiError } from '@/lib/api/client';

/** Per-column presentation hints (`meta` on a ColumnDef). */
export interface ColumnMeta {
  align?: 'left' | 'center' | 'right';
  /** Right-aligned tabular figures. */
  numeric?: boolean;
  /** Monospace (codes, document numbers). */
  mono?: boolean;
  className?: string;
}

const metaOf = (col: { columnDef: { meta?: unknown } }) => (col.columnDef.meta ?? {}) as ColumnMeta;

export interface ServerPagination {
  page: number;
  pageSize: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (size: number) => void;
}

export interface ServerSorting {
  sortBy?: string;
  sortDir: 'asc' | 'desc';
  onSortChange: (sortBy: string | undefined, sortDir: 'asc' | 'desc') => void;
}

interface DataTableProps<TData, TValue> {
  columns: ColumnDef<TData, TValue>[];
  data: PaginatedResult<TData> | undefined;
  isLoading?: boolean;
  isFetching?: boolean;
  pagination: ServerPagination;
  sorting?: ServerSorting;
  emptyState?: React.ReactNode;
  /** Query error: renders the standard error state with a retry action. */
  error?: unknown;
  onRetry?: () => void;
  onRowClick?: (row: TData) => void;
  getRowId?: (row: TData) => string;
  toolbar?: React.ReactNode;
}

/**
 * Server-driven TanStack table: sorting/pagination are delegated to the API so
 * it scales to ledger-sized datasets. Column visibility is local UI state.
 */
export function DataTable<TData, TValue>({
  columns,
  data,
  isLoading,
  isFetching,
  pagination,
  sorting,
  emptyState,
  error,
  onRetry,
  onRowClick,
  getRowId,
  toolbar,
}: DataTableProps<TData, TValue>) {
  const [columnVisibility, setColumnVisibility] = React.useState<VisibilityState>({});
  const sortingState: SortingState = sorting?.sortBy
    ? [{ id: sorting.sortBy, desc: sorting.sortDir === 'desc' }]
    : [];

  const table = useReactTable({
    data: data?.items ?? [],
    columns,
    state: { columnVisibility, sorting: sortingState },
    manualPagination: true,
    manualSorting: true,
    pageCount: data?.totalPages ?? -1,
    getRowId,
    onColumnVisibilityChange: setColumnVisibility,
    onSortingChange: (updater) => {
      if (!sorting) return;
      const next = typeof updater === 'function' ? updater(sortingState) : updater;
      const first = next[0];
      sorting.onSortChange(first?.id, first?.desc ? 'desc' : 'asc');
    },
    getCoreRowModel: getCoreRowModel(),
  });

  const bodyRef = React.useRef<HTMLTableSectionElement>(null);
  // Arrow keys move between clickable rows; Enter opens the focused one.
  const onRowKeyDown = (e: React.KeyboardEvent<HTMLTableRowElement>, row: TData) => {
    if (e.key === 'Enter' && onRowClick) {
      e.preventDefault();
      onRowClick(row);
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const rows = Array.from(bodyRef.current?.querySelectorAll<HTMLElement>('tr[tabindex]') ?? []);
    const idx = rows.indexOf(e.currentTarget);
    const next = rows[idx + (e.key === 'ArrowDown' ? 1 : -1)];
    if (next) {
      e.preventDefault();
      next.focus();
    }
  };

  const total = data?.total ?? 0;
  const from = total === 0 ? 0 : (pagination.page - 1) * pagination.pageSize + 1;
  const to = Math.min(total, pagination.page * pagination.pageSize);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {toolbar}
        <div className="ml-auto">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm">
                <Columns3 /> Columns
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {table
                .getAllColumns()
                .filter((c) => c.getCanHide())
                .map((column) => (
                  <DropdownMenuCheckboxItem
                    key={column.id}
                    checked={column.getIsVisible()}
                    onCheckedChange={(v) => column.toggleVisibility(Boolean(v))}
                  >
                    {typeof column.columnDef.header === 'string'
                      ? column.columnDef.header
                      : column.id}
                  </DropdownMenuCheckboxItem>
                ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <div
        className={cn(
          'relative rounded-lg border bg-card transition-opacity duration-normal',
          isFetching && !isLoading && 'opacity-80',
        )}
        aria-busy={isFetching || isLoading || undefined}
      >
        {isFetching && !isLoading ? (
          <div
            className="absolute inset-x-0 top-0 z-20 h-0.5 overflow-hidden rounded-t-lg"
            aria-hidden
          >
            <div className="h-full w-1/3 animate-pulse bg-primary/60" />
          </div>
        ) : null}
        {error ? (
          <ErrorState
            compact
            className="border-0"
            title="Unable to load records"
            description={error instanceof Error ? error.message : undefined}
            correlationId={error instanceof ApiError ? error.body.correlationId : undefined}
            reference={error instanceof ApiError ? error.code : undefined}
            onRetry={onRetry}
            retrying={isFetching}
          />
        ) : isLoading ? (
          <TableSkeleton columns={columns.length} />
        ) : (
          <Table containerClassName="max-h-[calc(100vh-16rem)]">
            <TableHeader sticky>
              {table.getHeaderGroups().map((hg) => (
                <TableRow key={hg.id} className="hover:bg-transparent">
                  {hg.headers.map((header) => {
                    const canSort = Boolean(sorting) && header.column.getCanSort();
                    const sorted = header.column.getIsSorted();
                    return (
                      <TableHead
                        key={header.id}
                        align={
                          metaOf(header.column).align ??
                          (metaOf(header.column).numeric ? 'right' : 'left')
                        }
                        className={metaOf(header.column).className}
                        aria-sort={
                          sorted === 'asc'
                            ? 'ascending'
                            : sorted === 'desc'
                              ? 'descending'
                              : undefined
                        }
                        style={{ width: header.getSize() !== 150 ? header.getSize() : undefined }}
                      >
                        {header.isPlaceholder ? null : canSort ? (
                          <button
                            type="button"
                            className={cn(
                              'inline-flex items-center gap-1 rounded-xs transition-colors duration-fast hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                              sorted && 'text-foreground',
                            )}
                            onClick={header.column.getToggleSortingHandler()}
                          >
                            {flexRender(header.column.columnDef.header, header.getContext())}
                            {sorted === 'asc' ? (
                              <ArrowUp className="h-3 w-3" />
                            ) : sorted === 'desc' ? (
                              <ArrowDown className="h-3 w-3" />
                            ) : (
                              <ArrowUpDown className="h-3 w-3 opacity-50" />
                            )}
                          </button>
                        ) : (
                          flexRender(header.column.columnDef.header, header.getContext())
                        )}
                      </TableHead>
                    );
                  })}
                </TableRow>
              ))}
            </TableHeader>
            <TableBody ref={bodyRef}>
              {table.getRowModel().rows.length === 0 ? (
                <TableRow className="hover:bg-transparent">
                  <TableCell colSpan={columns.length} className="p-3">
                    {emptyState ?? (
                      <EmptyState
                        compact
                        title="No records found"
                        description="Nothing matches the current filters."
                        className="border-0"
                      />
                    )}
                  </TableCell>
                </TableRow>
              ) : (
                table.getRowModel().rows.map((row) => (
                  <TableRow
                    key={row.id}
                    onClick={onRowClick ? () => onRowClick(row.original) : undefined}
                    onKeyDown={onRowClick ? (e) => onRowKeyDown(e, row.original) : undefined}
                    tabIndex={onRowClick ? 0 : undefined}
                    className={cn(onRowClick && 'cursor-pointer')}
                  >
                    {row.getVisibleCells().map((cell) => {
                      const meta = metaOf(cell.column);
                      return (
                        <TableCell
                          key={cell.id}
                          align={meta.align}
                          numeric={meta.numeric}
                          className={cn(meta.mono && 'font-mono text-xs', meta.className)}
                        >
                          {flexRender(cell.column.columnDef.cell, cell.getContext())}
                        </TableCell>
                      );
                    })}
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted-foreground">
        <div>
          {total > 0 ? (
            <>
              Showing{' '}
              <span className="tabular font-medium text-foreground">
                {from}-{to}
              </span>{' '}
              of <span className="tabular font-medium text-foreground">{total}</span>
            </>
          ) : (
            'No records'
          )}
        </div>
        <div className="flex items-center gap-2">
          <Select
            value={String(pagination.pageSize)}
            onValueChange={(v) => pagination.onPageSizeChange(Number(v))}
          >
            <SelectTrigger className="h-8 w-[110px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {[10, 25, 50, 100].map((n) => (
                <SelectItem key={n} value={String(n)}>
                  {n} / page
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span className="tabular">
            Page {pagination.page} of {Math.max(1, data?.totalPages ?? 1)}
          </span>
          <Button
            variant="outline"
            size="icon-sm"
            disabled={pagination.page <= 1}
            onClick={() => pagination.onPageChange(pagination.page - 1)}
            aria-label="Previous page"
          >
            <ChevronLeft />
          </Button>
          <Button
            variant="outline"
            size="icon-sm"
            disabled={pagination.page >= (data?.totalPages ?? 1)}
            onClick={() => pagination.onPageChange(pagination.page + 1)}
            aria-label="Next page"
          >
            <ChevronRight />
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Small hook that keeps page/pageSize/sort/search state together. */
export function useTableState(initial?: {
  pageSize?: number;
  sortBy?: string;
  sortDir?: 'asc' | 'desc';
}) {
  const [page, setPage] = React.useState(1);
  const [pageSize, setPageSize] = React.useState(initial?.pageSize ?? 25);
  const [sortBy, setSortBy] = React.useState<string | undefined>(initial?.sortBy);
  const [sortDir, setSortDir] = React.useState<'asc' | 'desc'>(initial?.sortDir ?? 'asc');
  const [search, setSearchState] = React.useState('');

  const setSearch = (value: string) => {
    setSearchState(value);
    setPage(1);
  };

  return {
    query: { page, pageSize, sortBy, sortDir, search: search || undefined },
    pagination: {
      page,
      pageSize,
      onPageChange: setPage,
      onPageSizeChange: (size: number) => {
        setPageSize(size);
        setPage(1);
      },
    } satisfies ServerPagination,
    sorting: {
      sortBy,
      sortDir,
      onSortChange: (by: string | undefined, dir: 'asc' | 'desc') => {
        setSortBy(by);
        setSortDir(dir);
        setPage(1);
      },
    } satisfies ServerSorting,
    search,
    setSearch,
    resetPage: () => setPage(1),
  };
}
