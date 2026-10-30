interface SyncSweepProps {
  /** Whether a background sync/revalidation is in flight. */
  active: boolean;
  /** Extra positioning class for the host context (e.g. the queue panel header). */
  className?: string;
}

/**
 * Thin indeterminate sweep bar that surfaces background syncing — the landing
 * channels list revalidating and the channel queue waiting on its first sync. Purely
 * decorative (aria-hidden); the host should reserve or absolutely position its
 * slot so toggling it never shifts layout.
 */
export function SyncSweep({ active, className }: SyncSweepProps) {
  return (
    <span
      className={`sync-sweep${active ? ' is-active' : ''}${className ? ` ${className}` : ''}`}
      aria-hidden="true"
    />
  );
}
