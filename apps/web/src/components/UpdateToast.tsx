import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { t } from '../i18n';

export const AUTO_UPDATE_DELAY_MS = 60_000;
const TICK_MS = 1_000;

// Live countdowns register a canceller here so dismissing the toast stops the
// pending auto-update: sonner keeps the dismissed toast's subtree mounted, so
// unmount cleanup alone never runs and the timer would fire after dismissal.
const cancellers = new Set<() => void>();

export function cancelAutoUpdate() {
  for (const cancel of cancellers) cancel();
  cancellers.clear();
}

export function triggerUpdate() {
  if (window.__triggerSWUpdate) window.__triggerSWUpdate();
  else window.location.reload();
}

interface UpdateCountdownProps {
  onComplete: () => void;
  delayMs?: number;
}

// Label for the toast's Update button: the button itself doubles as the countdown,
// its fill depleting over `delayMs` before `onComplete` (auto-update) fires. It
// always runs to the end — only dismissing the toast cancels it.
export function UpdateCountdown({ onComplete, delayMs = AUTO_UPDATE_DELAY_MS }: UpdateCountdownProps) {
  const [fraction, setFraction] = useState(1);
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;

  useEffect(() => {
    const deadline = Date.now() + delayMs;

    // Deadline-based (not tick-counting) so throttled background-tab timers still
    // complete on their next fire, however late it lands.
    let interval: ReturnType<typeof setInterval>;
    const cancel = () => clearInterval(interval);

    interval = setInterval(() => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        cancel();
        setFraction(0);
        onCompleteRef.current();
        return;
      }
      setFraction(remaining / delayMs);
    }, TICK_MS);

    cancellers.add(cancel);
    return () => {
      cancellers.delete(cancel);
      clearInterval(interval);
    };
  }, [delayMs]);

  return (
    <>
      <span aria-hidden="true" data-testid="update-countdown" className="update-countdown">
        <span
          data-testid="update-countdown-fill"
          className="update-countdown-fill"
          style={{ transform: `scaleX(${fraction})` }}
        />
      </span>
      <span className="update-countdown-label">{t('toast.updateAction')}</span>
    </>
  );
}

interface NewVersionToastOptions {
  description?: string;
  warning?: boolean;
}

// Single entry point for the "new version available" toast (SW update and server
// version_mismatch share the 'new-version' id). Besides the manual Update action,
// it auto-updates after AUTO_UPDATE_DELAY_MS; dismissing the toast cancels it.
export function showNewVersionToast({ description, warning = false }: NewVersionToastOptions = {}) {
  (warning ? toast.warning : toast)(t('toast.newVersionAvailable'), {
    id: 'new-version',
    className: 'new-version-toast',
    duration: Infinity,
    description: (
      <div style={{ fontSize: 'var(--text-sm)' }}>
        {description}
        <div style={{ marginTop: description ? 4 : 0, opacity: 0.8 }}>{t('toast.autoUpdateHint')}</div>
      </div>
    ),
    action: { label: <UpdateCountdown onComplete={triggerUpdate} />, onClick: triggerUpdate },
    // Dismissing is an explicit "not now" — cancel the pending auto-update.
    onDismiss: cancelAutoUpdate,
    onAutoClose: cancelAutoUpdate,
  });
}
