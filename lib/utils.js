import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Merge class names, with later Tailwind utilities winning over earlier ones.
 *
 * `clsx` handles the conditionals; `twMerge` resolves the conflicts — without
 * it, `cn('p-2', 'p-4')` would emit both and the winner would depend on the
 * order Tailwind happened to generate them in, not on the order written here.
 */
export function cn(...inputs) {
  return twMerge(clsx(inputs));
}
