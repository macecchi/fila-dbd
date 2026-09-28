import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { toast, type ExternalToast } from 'sonner';
import { createToastDigest, isOnTab, onTabChange, READ_DELAY_MS, type DigestRender } from './toastDigest';

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { dismiss: vi.fn() }),
}));

const toastMock = vi.mocked(toast);
const dismissMock = vi.mocked(toast.dismiss);

let onTab = false;
let release: (() => void) | undefined;
const render: DigestRender<string> = (items, r) => {
  release = r;
  return { title: `${items.length}: ${items.join(',')}` };
};
const makeDigest = () => createToastDigest('digest', render, () => onTab);

const lastCall = () => toastMock.mock.calls.at(-1) as [string, ExternalToast];

function setPage(visibility: 'visible' | 'hidden', focused: boolean) {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: visibility });
  vi.spyOn(document, 'hasFocus').mockReturnValue(focused);
}

beforeEach(() => {
  vi.useFakeTimers();
  toastMock.mockClear();
  dismissMock.mockClear();
  onTab = false;
  release = undefined;
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('createToastDigest', () => {
  it('folds arrivals into one toast that never times out while the streamer is away', () => {
    const digest = makeDigest();
    digest.add('a');
    digest.add('b');
    digest.add('c');

    expect(toastMock).toHaveBeenCalledTimes(3);
    const ids = toastMock.mock.calls.map(([, opts]) => opts?.id);
    expect(new Set(ids).size).toBe(1);
    expect(lastCall()[0]).toBe('3: a,b,c');
    expect(lastCall()[1].duration).toBe(Infinity);
    expect(digest.count).toBe(3);

    vi.advanceTimersByTime(60 * 60 * 1000);
    expect(dismissMock).not.toHaveBeenCalled();
    expect(digest.count).toBe(3);
  });

  it('dismisses the read delay after the streamer is back, then starts over at 1', () => {
    const digest = makeDigest();
    digest.add('a');
    digest.add('b');
    const id = lastCall()[1].id;

    digest.setOnTab(true);
    vi.advanceTimersByTime(READ_DELAY_MS - 1);
    expect(dismissMock).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(dismissMock).toHaveBeenCalledWith(id);
    expect(digest.count).toBe(0);

    digest.add('c');
    expect(lastCall()[0]).toBe('1: c');
    expect(lastCall()[1].id).not.toBe(id);
  });

  it('restarts the delay when something arrives while the streamer is on the tab', () => {
    onTab = true;
    const digest = makeDigest();
    digest.add('a');
    vi.advanceTimersByTime(READ_DELAY_MS - 1000);
    digest.add('b');

    vi.advanceTimersByTime(READ_DELAY_MS - 1);
    expect(dismissMock).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(dismissMock).toHaveBeenCalledTimes(1);
  });

  it('pauses the delay while the streamer is away and restarts it in full on return', () => {
    onTab = true;
    const digest = makeDigest();
    digest.add('a');
    vi.advanceTimersByTime(3000);

    digest.setOnTab(false);
    vi.advanceTimersByTime(60 * 60 * 1000);
    expect(dismissMock).not.toHaveBeenCalled();

    digest.setOnTab(true);
    vi.advanceTimersByTime(READ_DELAY_MS - 1);
    expect(dismissMock).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(dismissMock).toHaveBeenCalledTimes(1);
  });

  it('does not extend a running delay on a repeated focus signal', () => {
    onTab = true;
    const digest = makeDigest();
    digest.add('a');
    vi.advanceTimersByTime(5000);
    digest.setOnTab(true);
    vi.advanceTimersByTime(READ_DELAY_MS - 5000);
    expect(dismissMock).toHaveBeenCalledTimes(1);
  });

  it('arriving on the tab with nothing to show starts no timer', () => {
    const digest = makeDigest();
    digest.setOnTab(true);
    vi.advanceTimersByTime(READ_DELAY_MS);
    expect(dismissMock).not.toHaveBeenCalled();
  });

  it('ends the batch when the toast is closed (sonner onDismiss)', () => {
    const digest = makeDigest();
    digest.add('a');
    digest.add('b');
    const { id, onDismiss } = lastCall()[1];

    onDismiss?.({ id } as never);
    expect(digest.count).toBe(0);

    digest.add('c');
    expect(lastCall()[0]).toBe('1: c');
    expect(lastCall()[1].id).not.toBe(id);
  });

  it('ignores a late onDismiss from the previous batch', () => {
    onTab = true;
    const digest = makeDigest();
    digest.add('a');
    const { onDismiss: previous } = lastCall()[1];
    vi.advanceTimersByTime(READ_DELAY_MS);
    expect(dismissMock).toHaveBeenCalledTimes(1);

    digest.add('b');
    previous?.({} as never);
    expect(digest.count).toBe(1);
  });

  it('ends the batch through the release handed to the renderer (action buttons)', () => {
    onTab = true;
    const digest = makeDigest();
    digest.add('a');
    release?.();
    expect(digest.count).toBe(0);

    // The released batch's timer is gone too.
    vi.advanceTimersByTime(READ_DELAY_MS);
    expect(dismissMock).not.toHaveBeenCalled();
  });

  it('dismiss() takes the toast down right away', () => {
    const digest = makeDigest();
    digest.add('a');
    const id = lastCall()[1].id;
    digest.dismiss();
    expect(dismissMock).toHaveBeenCalledWith(id);
    expect(digest.count).toBe(0);

    digest.dismiss();
    expect(dismissMock).toHaveBeenCalledTimes(1);
  });
});

describe('isOnTab', () => {
  it('needs the page both visible and focused', () => {
    setPage('visible', true);
    expect(isOnTab()).toBe(true);
    setPage('visible', false); // e.g. on a second monitor, with the game focused
    expect(isOnTab()).toBe(false);
    setPage('hidden', true);
    expect(isOnTab()).toBe(false);
  });
});

describe('onTabChange', () => {
  it('reports arrivals and departures from focus, blur and visibility changes', () => {
    const listener = vi.fn();
    const stop = onTabChange(listener);

    setPage('visible', true);
    window.dispatchEvent(new Event('focus'));
    expect(listener).toHaveBeenLastCalledWith(true);

    window.dispatchEvent(new Event('blur'));
    expect(listener).toHaveBeenLastCalledWith(false);

    setPage('hidden', false);
    document.dispatchEvent(new Event('visibilitychange'));
    expect(listener).toHaveBeenLastCalledWith(false);

    setPage('visible', true);
    document.dispatchEvent(new Event('visibilitychange'));
    expect(listener).toHaveBeenLastCalledWith(true);

    stop();
    listener.mockClear();
    window.dispatchEvent(new Event('focus'));
    expect(listener).not.toHaveBeenCalled();
  });

  it('treats blur as leaving even if hasFocus() still reads true', () => {
    const listener = vi.fn();
    const stop = onTabChange(listener);
    setPage('visible', true);
    window.dispatchEvent(new Event('blur'));
    expect(listener).toHaveBeenLastCalledWith(false);
    stop();
  });
});
