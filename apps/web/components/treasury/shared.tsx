'use client';
import * as React from 'react';
import type { UseQueryResult } from '@tanstack/react-query';
import { DashboardSkeleton } from '@accounting/ui';
import { ApiError } from '@/lib/api/client';
import { ErrorState } from '@/components/ui-ext/page';

/**
 * Loading / error wrapper for the treasury read screens: a skeleton while the
 * first response is pending, a retryable error state when the API refuses,
 * otherwise the children rendered with the data.
 */
export function QueryState<T>({
  query,
  children,
}: {
  query: UseQueryResult<T>;
  children: (data: T) => React.ReactNode;
}) {
  if (query.data) return <>{children(query.data)}</>;
  if (query.error)
    return (
      <ErrorState
        title="Unable to load treasury data"
        description={query.error instanceof Error ? query.error.message : undefined}
        reference={query.error instanceof ApiError ? query.error.code : undefined}
        correlationId={query.error instanceof ApiError ? query.error.body.correlationId : undefined}
        onRetry={() => void query.refetch()}
        retrying={query.isFetching}
      />
    );
  return <DashboardSkeleton />;
}
