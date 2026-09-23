import { Skeleton } from '@/components/ui/skeleton';

export default function Loading() {
  return (
    <div className="mx-auto max-w-[900px] space-y-3.5 p-5 sm:p-7">
      <Skeleton className="h-8 w-[220px] rounded-lg" />
      {Array.from({ length: 3 }).map((_, i) => (
        <Skeleton key={i} className="h-[64px] rounded-2xl" />
      ))}
    </div>
  );
}
