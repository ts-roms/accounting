import { Skeleton } from '@accounting/ui';

/**
 * Route-segment fallback: the shell stays put and the content area shows a
 * page skeleton the instant a navigation starts, until the next page's code
 * and data are ready. Individual pages then swap in their own query states.
 */
export default function AppRouteLoading() {
  return (
    <div className="space-y-5" aria-busy aria-label="Loading page" data-testid="route-skeleton">
      <div className="space-y-2">
        <Skeleton className="h-7 w-56" />
        <Skeleton className="h-4 w-96 max-w-full" />
      </div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Skeleton className="h-24" />
        <Skeleton className="h-24" />
        <Skeleton className="h-24" />
        <Skeleton className="h-24" />
      </div>
      <Skeleton className="h-72 w-full" />
    </div>
  );
}
