import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { t } from '../i18n';

export const AUTO_UPDATE_IDLE_MS = 60_000;
const TICK_MS = 1_000;

// Any of these means the user is actively using the page.
const ACTIVITY_EVENTS = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart', 'scroll'] as const;

export function triggerUpdate() {
  if (window.__triggerSWUpdate) window.__triggerSWUpdate();
  else window.location.reload();
}

interface UpdateCountdownProps {
  onComplete: () => void;
  idleMs?: number;
}

// Thin bar that depletes over `idleMs` of continuous user inactivity, then fires
// `onComplete` (auto-update). Any interaction — or coming back to the tab — refills
// it, so an active user is never interrupted: the reload only happens while they're
// away (e.g. mid-match), and the app is already up to date when they return.
export function UpdateCountdown({ onComplete, idleMs = AUTO_UPDATE_IDLE_MS }: UpdateCountdownProps) {
  const [fraction, setFraction] = useState(1);
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;

  useEffect(() => {
    let done = false;
    let deadline = Date.now() + idleMs;

    const reset = () => {
      if (done) return;
      deadline = Date.now() + idleMs;
      setFraction(1);
    };
    const onVisibility = () => {
      // Coming back to the tab counts as activity — never reload in the user's face.
      if (document.visibilityState === 'visible') reset();
    };

    // Deadline-based (not tick-counting) so throttled background-tab timers still
    // complete on their next fire, however late it lands.
    const interval = setInterval(() => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        done = true;
        clearInterval(interval);
        setFraction(0);
        onCompleteRef.current();
        return;
      }
      setFraction(remaining / idleMs);
    }, TICK_MS);

    for (const e of ACTIVITY_EVENTS) window.addEventListener(e, reset, { capture: true, passive: true });
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      clearInterval(interval);
      for (const e of ACTIVITY_EVENTS) window.removeEventListener(e, reset, { capture: true });
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [idleMs]);

  return (
    <div
      role="progressbar"
      aria-label={t('toast.autoUpdateCountdown')}
      data-testid="update-countdown"
      style={{
        marginTop: 8,
        height: 3,
        borderRadius: 2,
        background: 'rgba(255, 255, 255, 0.15)',
        overflow: 'hidden',
      }}
    >
      <div
        data-testid="update-countdown-fill"
        style={{
          height: '100%',
          width: `${fraction * 100}%`,
          background: 'var(--accent)',
          transition: 'width 1s linear',
        }}
      />
    </div>
  );
}

interface NewVersionToastOptions {
  description?: string;
  warning?: boolean;
}

// Single entry point for the "new version available" toast (SW update and server
// version_mismatch share the 'new-version' id). Besides the manual Update action,
// it auto-updates after AUTO_UPDATE_IDLE_MS of user inactivity; dismissing the
// toast cancels the auto-update.
export function showNewVersionToast({ description, warning = false }: NewVersionToastOptions = {}) {
  (warning ? toast.warning : toast)(t('toast.newVersionAvailable'), {
    id: 'new-version',
    duration: Infinity,
    description: (
      <>
        {description}
        <UpdateCountdown onComplete={triggerUpdate} />
      </>
    ),
    action: { label: t('toast.updateAction'), onClick: triggerUpdate },
  });
}
