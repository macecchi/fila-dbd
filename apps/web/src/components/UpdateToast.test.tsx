import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import { Toaster } from 'sonner';
import { UpdateCountdown, showNewVersionToast, AUTO_UPDATE_IDLE_MS } from './UpdateToast';

function advance(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

// Sonner mounts toasts asynchronously — flush that before querying the DOM.
function showToast(...args: Parameters<typeof showNewVersionToast>) {
  act(() => showNewVersionToast(...args));
  advance(500);
}

function userActivity(type = 'pointermove') {
  act(() => {
    window.dispatchEvent(new Event(type, { bubbles: true }));
  });
}

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: state });
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  delete window.__triggerSWUpdate;
});

describe('UpdateCountdown', () => {
  it('fires onComplete after the full inactivity window with no interaction', () => {
    const onComplete = vi.fn();
    render(<UpdateCountdown onComplete={onComplete} />);

    advance(AUTO_UPDATE_IDLE_MS - 1000);
    expect(onComplete).not.toHaveBeenCalled();

    advance(1000);
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('fires onComplete only once', () => {
    const onComplete = vi.fn();
    render(<UpdateCountdown onComplete={onComplete} />);

    advance(AUTO_UPDATE_IDLE_MS * 3);
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('shows a full indicator that depletes as the user stays inactive', () => {
    render(<UpdateCountdown onComplete={vi.fn()} />);
    const fill = screen.getByTestId('update-countdown-fill');
    expect(fill.style.width).toBe('100%');

    advance(AUTO_UPDATE_IDLE_MS / 2);
    expect(fill.style.width).toBe('50%');

    advance(AUTO_UPDATE_IDLE_MS / 4);
    expect(fill.style.width).toBe('25%');
  });

  it('resets the countdown and refills the indicator on user interaction', () => {
    const onComplete = vi.fn();
    render(<UpdateCountdown onComplete={onComplete} />);
    const fill = screen.getByTestId('update-countdown-fill');

    advance(AUTO_UPDATE_IDLE_MS - 1000);
    userActivity('pointermove');
    expect(fill.style.width).toBe('100%');

    // A fresh full window is now required before auto-updating.
    advance(AUTO_UPDATE_IDLE_MS - 1000);
    expect(onComplete).not.toHaveBeenCalled();
    advance(1000);
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it.each(['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart', 'scroll'])(
    'treats %s as user activity',
    (type) => {
      const onComplete = vi.fn();
      render(<UpdateCountdown onComplete={onComplete} />);

      advance(AUTO_UPDATE_IDLE_MS - 1000);
      userActivity(type);
      advance(AUTO_UPDATE_IDLE_MS - 1000);
      expect(onComplete).not.toHaveBeenCalled();
    }
  );

  it('never fires while the user keeps interacting', () => {
    const onComplete = vi.fn();
    render(<UpdateCountdown onComplete={onComplete} />);

    // 10 minutes of activity at 30s intervals — well past the idle window.
    for (let i = 0; i < 20; i++) {
      advance(30_000);
      userActivity('keydown');
    }
    expect(onComplete).not.toHaveBeenCalled();
  });

  it('resets when the user returns to the tab', () => {
    const onComplete = vi.fn();
    render(<UpdateCountdown onComplete={onComplete} />);
    const fill = screen.getByTestId('update-countdown-fill');

    setVisibility('hidden');
    advance(AUTO_UPDATE_IDLE_MS - 1000);
    setVisibility('visible');
    expect(fill.style.width).toBe('100%');

    advance(AUTO_UPDATE_IDLE_MS - 1000);
    expect(onComplete).not.toHaveBeenCalled();
    advance(1000);
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('keeps counting down while the tab is hidden', () => {
    const onComplete = vi.fn();
    render(<UpdateCountdown onComplete={onComplete} />);

    setVisibility('hidden');
    advance(AUTO_UPDATE_IDLE_MS);
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('completes on a late throttled tick instead of counting ticks', () => {
    const onComplete = vi.fn();
    render(<UpdateCountdown onComplete={onComplete} />);

    // Background tabs can throttle timers; a single late tick past the
    // deadline must still complete because the deadline is absolute.
    act(() => {
      vi.setSystemTime(Date.now() + AUTO_UPDATE_IDLE_MS + 5_000);
      vi.advanceTimersByTime(1000);
    });
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('cancels the countdown on unmount (toast dismissed)', () => {
    const onComplete = vi.fn();
    const { unmount } = render(<UpdateCountdown onComplete={onComplete} />);

    advance(AUTO_UPDATE_IDLE_MS / 2);
    unmount();
    advance(AUTO_UPDATE_IDLE_MS * 2);
    expect(onComplete).not.toHaveBeenCalled();
  });

  it('exposes an accessible progressbar', () => {
    render(<UpdateCountdown onComplete={vi.fn()} />);
    expect(screen.getByRole('progressbar')).toBe(screen.getByTestId('update-countdown'));
  });
});

describe('showNewVersionToast', () => {
  it('renders the toast with title, update action and countdown', () => {
    render(<Toaster />);
    showToast();

    expect(screen.getByText('New version available')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Update' })).toBeTruthy();
    expect(screen.getByTestId('update-countdown')).toBeTruthy();
  });

  it('renders the extra description for version_mismatch', () => {
    render(<Toaster />);
    showToast({ description: "New requests won't be received.", warning: true });

    expect(screen.getByText("New requests won't be received.")).toBeTruthy();
    expect(screen.getByTestId('update-countdown')).toBeTruthy();
  });

  it('triggers the SW update when the countdown completes', () => {
    const trigger = vi.fn();
    window.__triggerSWUpdate = trigger;
    render(<Toaster />);
    showToast();

    advance(AUTO_UPDATE_IDLE_MS - 1000);
    expect(trigger).not.toHaveBeenCalled();
    advance(1000);
    expect(trigger).toHaveBeenCalledTimes(1);
  });

  it('does not auto-update while the user keeps interacting', () => {
    const trigger = vi.fn();
    window.__triggerSWUpdate = trigger;
    render(<Toaster />);
    showToast();

    for (let i = 0; i < 10; i++) {
      advance(AUTO_UPDATE_IDLE_MS - 1000);
      userActivity('pointermove');
    }
    expect(trigger).not.toHaveBeenCalled();
  });

  it('triggers the SW update immediately when the action is clicked', () => {
    const trigger = vi.fn();
    window.__triggerSWUpdate = trigger;
    render(<Toaster />);
    showToast();

    fireEvent.click(screen.getByRole('button', { name: 'Update' }));
    expect(trigger).toHaveBeenCalledTimes(1);
  });
});
