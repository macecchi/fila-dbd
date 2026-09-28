import { toast, type ExternalToast } from 'sonner';

/**
 * How long a digest toast stays up once the streamer is on the tab. Counted here
 * rather than by sonner: sonner only pauses its timer while `document.hidden`, so a
 * tab left visible on a second monitor, behind the focused game, timed toasts out
 * before anyone saw them.
 */
export const READ_DELAY_MS = 7000;

/** The streamer is looking at the page: visible *and* focused (not just visible). */
export function isOnTab(): boolean {
  return document.visibilityState === 'visible' && document.hasFocus();
}

/** Calls `listener` whenever the streamer may have arrived on or left the tab. */
export function onTabChange(listener: (onTab: boolean) => void): () => void {
  const recheck = () => listener(isOnTab());
  // `blur` always means "left": the verdict must never be a stale hasFocus().
  const left = () => listener(false);
  window.addEventListener('focus', recheck);
  window.addEventListener('blur', left);
  document.addEventListener('visibilitychange', recheck);
  return () => {
    window.removeEventListener('focus', recheck);
    window.removeEventListener('blur', left);
    document.removeEventListener('visibilitychange', recheck);
  };
}

export interface DigestView {
  title: string;
  options?: Omit<ExternalToast, 'id' | 'duration' | 'onDismiss' | 'onAutoClose'>;
}

/**
 * Renders the current batch (oldest first). `release` ends the batch; call it from an
 * action button, which sonner closes without reporting a dismissal.
 */
export type DigestRender<T> = (items: readonly T[], release: () => void) => DigestView;

export interface ToastDigest<T> {
  /** Adds an arrival to the batch and shows it, updating the batch's toast in place. */
  add(item: T): void;
  /** The streamer arrived on (starts the read delay) or left (pauses it) the tab. */
  setOnTab(onTab: boolean): void;
  /** Takes the toast down now and ends the batch. */
  dismiss(): void;
  readonly count: number;
}

/**
 * One toast per batch of arrivals instead of one per arrival. The toast never times
 * out on its own (`duration: Infinity`): it is taken down `READ_DELAY_MS` after the
 * streamer is on the tab (an arrival while they're on it restarts the delay; leaving
 * pauses it), or when they close it. Either way the batch ends, and the next arrival
 * starts a new toast at 1.
 *
 * Each batch gets its own toast id (`<baseId>-<n>`), so a late `onDismiss` from the
 * previous toast can't end the new batch, and an arrival during the old toast's exit
 * animation doesn't merge into a toast that is about to unmount (sonner keeps the
 * dying toast under its id for that animation, and the update would be lost with it).
 */
/** Batch numbers are unique across digests, so a remounted one can't reuse a dying toast's id. */
let nextBatch = 0;

export function createToastDigest<T>(
  baseId: string,
  render: DigestRender<T>,
  onTab: () => boolean = isOnTab,
): ToastDigest<T> {
  let items: T[] = [];
  let batch = nextBatch++;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const idOf = (n: number) => `${baseId}-${n}`;
  const stopTimer = () => {
    clearTimeout(timer);
    timer = undefined;
  };
  const startTimer = () => {
    stopTimer();
    timer = setTimeout(dismiss, READ_DELAY_MS);
  };
  const endBatch = () => {
    stopTimer();
    items = [];
    batch = nextBatch++;
  };

  function dismiss() {
    if (items.length === 0) return;
    const id = idOf(batch);
    endBatch();
    toast.dismiss(id);
  }

  return {
    get count() {
      return items.length;
    },
    add(item) {
      items = [...items, item];
      const current = batch;
      const release = () => {
        if (batch === current) endBatch();
      };
      const { title, options } = render(items, release);
      toast(title, { ...options, id: idOf(current), duration: Infinity, onDismiss: release });
      if (onTab()) startTimer();
      else stopTimer();
    },
    setOnTab(on) {
      if (items.length === 0) return;
      if (!on) stopTimer();
      else if (timer === undefined) startTimer();
    },
    dismiss,
  };
}
