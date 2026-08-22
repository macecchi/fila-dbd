import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import { Toaster } from 'sonner';
import { UpdateCountdown, showNewVersionToast, AUTO_UPDATE_DELAY_MS } from './UpdateToast';

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
  it('fires onComplete after the full delay', () => {
    const onComplete = vi.fn();
    render(<UpdateCountdown onComplete={onComplete} />);

    advance(AUTO_UPDATE_DELAY_MS - 1000);
    expect(onComplete).not.toHaveBeenCalled();

    advance(1000);
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('fires onComplete only once', () => {
    const onComplete = vi.fn();
    render(<UpdateCountdown onComplete={onComplete} />);

    advance(AUTO_UPDATE_DELAY_MS * 3);
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('shows a full indicator that depletes as time passes', () => {
    render(<UpdateCountdown onComplete={vi.fn()} />);
    const fill = screen.getByTestId('update-countdown-fill');
    expect(fill.style.transform).toBe('scaleX(1)');

    advance(AUTO_UPDATE_DELAY_MS / 2);
    expect(fill.style.transform).toBe('scaleX(0.5)');

    advance(AUTO_UPDATE_DELAY_MS / 4);
    expect(fill.style.transform).toBe('scaleX(0.25)');
  });

  it('keeps counting down while the tab is hidden', () => {
    const onComplete = vi.fn();
    render(<UpdateCountdown onComplete={onComplete} />);

    setVisibility('hidden');
    advance(AUTO_UPDATE_DELAY_MS);
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('completes on a late throttled tick instead of counting ticks', () => {
    const onComplete = vi.fn();
    render(<UpdateCountdown onComplete={onComplete} />);

    // Background tabs can throttle timers; a single late tick past the
    // deadline must still complete because the deadline is absolute.
    act(() => {
      vi.setSystemTime(Date.now() + AUTO_UPDATE_DELAY_MS + 5_000);
      vi.advanceTimersByTime(1000);
    });
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('cancels the countdown on unmount (toast dismissed)', () => {
    const onComplete = vi.fn();
    const { unmount } = render(<UpdateCountdown onComplete={onComplete} />);

    advance(AUTO_UPDATE_DELAY_MS / 2);
    unmount();
    advance(AUTO_UPDATE_DELAY_MS * 2);
    expect(onComplete).not.toHaveBeenCalled();
  });

  it('renders the countdown fill inside the Update button label', () => {
    render(<UpdateCountdown onComplete={vi.fn()} />);
    // Decorative — the button keeps "Update now" as its accessible name.
    expect(screen.getByTestId('update-countdown').getAttribute('aria-hidden')).toBe('true');
    expect(screen.getByText('Update now')).toBeTruthy();
  });
});

describe('showNewVersionToast', () => {
  it('renders the toast with title, update action and countdown', () => {
    render(<Toaster />);
    showToast();

    expect(screen.getByText('Update available')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Update now' })).toBeTruthy();
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

    advance(AUTO_UPDATE_DELAY_MS - 1000);
    expect(trigger).not.toHaveBeenCalled();
    advance(1000);
    expect(trigger).toHaveBeenCalledTimes(1);
  });

  it('triggers the SW update immediately when the action is clicked', () => {
    const trigger = vi.fn();
    window.__triggerSWUpdate = trigger;
    render(<Toaster />);
    showToast();

    fireEvent.click(screen.getByRole('button', { name: 'Update now' }));
    expect(trigger).toHaveBeenCalledTimes(1);
  });
});

describe('dismissing the new-version toast', () => {
  it('cancels the pending auto-update', () => {
    const trigger = vi.fn();
    window.__triggerSWUpdate = trigger;
    render(<Toaster closeButton />);
    showToast();

    fireEvent.click(screen.getByRole('button', { name: /close/i }));
    advance(AUTO_UPDATE_DELAY_MS * 2);
    expect(trigger).not.toHaveBeenCalled();
  });
});
