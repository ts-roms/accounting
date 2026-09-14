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
import { TableSkeleton } from './page';

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
          'rounded-md border bg-card transition-opacity',
          isFetching && !isLoading && 'opacity-70',
        )}
      >
        {isLoading ? (
          <TableSkeleton columns={columns.length} />
        ) : (
          <Table>
            <TableHeader>
              {table.getHeaderGroups().map((hg) => (
                <TableRow key={hg.id} className="hover:bg-transparent">
                  {hg.headers.map((header) => {
                    const canSort = Boolean(sorting) && header.column.getCanSort();
                    const sorted = header.column.getIsSorted();
                    return (
                      <TableHead
                        key={header.id}
                        style={{ width: header.getSize() !== 150 ? header.getSize() : undefined }}
                      >
                        {header.isPlaceholder ? null : canSort ? (
                          <button
                            type="button"
                            className="inline-flex items-center gap-1 hover:text-foreground"
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
            <TableBody>
              {table.getRowModel().rows.length === 0 ? (
                <TableRow className="hover:bg-transparent">
                  <TableCell colSpan={columns.length} className="p-0">
                    {emptyState ?? (
                      <div className="py-10 text-center text-sm text-muted-foreground">
                        No records found.
                      </div>
                    )}
                  </TableCell>
                </TableRow>
              ) : (
                table.getRowModel().rows.map((row) => (
                  <TableRow
                    key={row.id}
                    onClick={onRowClick ? () => onRowClick(row.original) : undefined}
                    className={cn(onRowClick && 'cursor-pointer')}
                  >
                    {row.getVisibleCells().map((cell) => (
                      <TableCell key={cell.id}>
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </TableCell>
                    ))}
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
