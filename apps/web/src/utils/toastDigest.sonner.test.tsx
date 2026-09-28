import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, fireEvent, within } from '@testing-library/react';
import { Toaster, toast } from 'sonner';
import { createToastDigest, READ_DELAY_MS, type DigestRender } from './toastDigest';

// Against the real sonner: pins the behaviour the digest relies on — a toast
// updated in place by id, the close button reporting onDismiss, and a fresh
// toast (not a merge into the dying one) for the batch after a dismissal.

function advance(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

let onTab = false;
const renderBatch: DigestRender<string> = (items, release) => ({
  title: `${items.length} arrived`,
  options: {
    description: items.join(', '),
    action: { label: 'Act', onClick: release },
  },
});

beforeEach(() => {
  // sonner's toast.dismiss() goes through requestAnimationFrame.
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'requestAnimationFrame', 'cancelAnimationFrame'],
  });
  onTab = false;
});

afterEach(() => {
  // sonner's store outlives the Toaster: don't hand this test's toasts to the next one.
  toast.dismiss();
  vi.useRealTimers();
});

describe('createToastDigest with sonner', () => {
  it('shows one toast per batch and replaces it after a dismissal', () => {
    render(<Toaster closeButton />);
    const digest = createToastDigest('sonner-digest', renderBatch, () => onTab);

    act(() => {
      digest.add('a');
      digest.add('b');
      digest.add('c');
    });
    advance(500);
    expect(screen.getAllByText(/arrived$/)).toHaveLength(1);
    expect(screen.getByText('3 arrived')).toBeTruthy();
    expect(screen.getByText('a, b, c')).toBeTruthy();

    // Away for an hour: still there.
    advance(60 * 60 * 1000);
    expect(screen.getByText('3 arrived')).toBeTruthy();

    act(() => digest.setOnTab(true));
    advance(READ_DELAY_MS + 100);
    advance(1000); // exit animation
    expect(screen.queryByText('3 arrived')).toBeNull();

    act(() => digest.add('d'));
    advance(500);
    expect(screen.getByText('1 arrived')).toBeTruthy();
    expect(screen.getByText('d')).toBeTruthy();
  });

  it('ends the batch when the toast is closed or its action is used', () => {
    render(<Toaster closeButton />);
    const digest = createToastDigest('sonner-digest-close', renderBatch, () => onTab);

    act(() => {
      digest.add('a');
      digest.add('b');
    });
    advance(500);
    const shown = screen.getByText('2 arrived').closest('[data-sonner-toast]') as HTMLElement;
    fireEvent.click(within(shown).getByRole('button', { name: /close/i }));
    advance(1000);
    expect(digest.count).toBe(0);
    expect(screen.queryByText('2 arrived')).toBeNull();

    act(() => digest.add('c'));
    advance(500);
    expect(screen.getByText('1 arrived')).toBeTruthy();

    fireEvent.click(screen.getByText('Act'));
    advance(1000);
    expect(digest.count).toBe(0);
    expect(screen.queryByText('1 arrived')).toBeNull();

    act(() => digest.add('d'));
    advance(500);
    expect(screen.getByText('1 arrived')).toBeTruthy();
    expect(screen.getByText('d')).toBeTruthy();
  });

  it('shows an arrival that lands while the previous toast is still animating out', () => {
    render(<Toaster closeButton />);
    onTab = true;
    const digest = createToastDigest('sonner-digest-race', renderBatch, () => onTab);

    act(() => {
      digest.add('a');
      digest.add('b');
    });
    advance(500);
    advance(READ_DELAY_MS); // dismissed: the exit animation is under way
    act(() => digest.add('c'));
    advance(1000);

    expect(screen.queryByText('2 arrived')).toBeNull();
    expect(screen.getByText('1 arrived')).toBeTruthy();
    expect(screen.getByText('c')).toBeTruthy();
  });
});
