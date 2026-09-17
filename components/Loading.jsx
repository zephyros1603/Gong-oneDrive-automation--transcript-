import { Skeleton } from '@/components/ui/skeleton';

/**
 * components/Loading.jsx — the shapes each page loads into.
 *
 * Next renders `loading.jsx` while a route segment resolves. The point is that
 * the skeleton matches the layout that replaces it, so the page settles rather
 * than jumping — a generic spinner would be less work and worse.
 */

export function CardsSkeleton({ stats = 8, panels = 2 }) {
  return (
    <div className="mx-auto max-w-[1200px] space-y-4 p-4 sm:p-6">
      <div className="flex items-center justify-between">
        <Skeleton className="h-7 w-[160px] rounded-lg" />
        <Skeleton className="h-8 w-[110px] rounded-xl" />
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {Array.from({ length: stats }).map((_, i) => (
          <Skeleton key={i} className="h-[92px] rounded-2xl"
                    style={{ animationDelay: `${i * 60}ms` }} />
        ))}
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        {Array.from({ length: panels }).map((_, i) => (
          <Skeleton key={i} className={`h-[260px] rounded-2xl ${i === 0 ? 'lg:col-span-2' : ''}`} />
        ))}
      </div>
    </div>
  );
}

export function GridSkeleton({ n = 8 }) {
  return (
    <div className="mx-auto max-w-[1400px] p-4 sm:p-6">
      <Skeleton className="mb-5 h-8 w-[220px] rounded-lg" />
      <Skeleton className="mb-4 h-9 w-full max-w-[420px] rounded-xl" />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {Array.from({ length: n }).map((_, i) => (
          <Skeleton key={i} className="h-[168px] rounded-2xl"
                    style={{ animationDelay: `${i * 50}ms` }} />
        ))}
      </div>
    </div>
  );
}

export function SplitSkeleton() {
  return (
    <div className="flex h-full">
      <div className="hidden w-[280px] flex-none border-r border-border p-3 lg:block">
        {Array.from({ length: 8 }).map((_, i) => (
          <Skeleton key={i} className="mb-2 h-[46px] rounded-xl"
                    style={{ animationDelay: `${i * 50}ms` }} />
        ))}
      </div>
      <div className="min-w-0 flex-1 p-5">
        <Skeleton className="mb-4 h-8 w-[240px] rounded-lg" />
        <Skeleton className="mb-3 h-[90px] rounded-2xl" />
        <Skeleton className="h-[140px] w-[70%] rounded-2xl" />
      </div>
    </div>
  );
}

export function FormSkeleton() {
  return (
    <div className="mx-auto max-w-[1200px] space-y-4 p-4 sm:p-6">
      <Skeleton className="h-11 w-[260px] rounded-xl" />
      <Skeleton className="h-9 w-full max-w-[420px] rounded-xl" />
      <Skeleton className="h-[340px] rounded-2xl" />
    </div>
  );
}
