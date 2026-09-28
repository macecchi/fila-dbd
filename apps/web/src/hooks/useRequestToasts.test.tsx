import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { toast, type ExternalToast } from 'sonner';
import { useRequestToasts, joinNames } from './useRequestToasts';
import { t } from '../i18n';
import type { Request } from '../types';

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { dismiss: vi.fn() }),
}));

const toastMock = vi.mocked(toast);
const dismissMock = vi.mocked(toast.dismiss);

let nextId = 1;
function req(overrides: Partial<Request> = {}): Request {
  const id = nextId++;
  return {
    id,
    timestamp: new Date(),
    donor: `Donor${id}`,
    amount: '',
    amountVal: 0,
    message: 'quero a nurse',
    character: 'Nurse',
    type: 'killer',
    source: 'chat',
    ...overrides,
  };
}
const skipped = (overrides: Partial<Request> = {}) => req({ type: 'none', character: '', ...overrides });

type Call = [string, ExternalToast];
type Action = { label: string; onClick: (e: unknown) => void };
const calls = () => toastMock.mock.calls as Call[];
const last = () => calls().at(-1)!;

/** The summary's description, split back into its sentences. */
function sentences(description: ExternalToast['description']) {
  return String(description).split(' · ');
}

function setOnTab(on: boolean) {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  vi.spyOn(document, 'hasFocus').mockReturnValue(on);
  act(() => {
    window.dispatchEvent(new Event(on ? 'focus' : 'blur'));
  });
}

// Mounts the hook on an already-synced queue (what's there at the first sync is not
// news), then lets tests append arrivals the way the requests store does.
function setup(opts: { hideNonRequests?: boolean; readOnly?: boolean; initial?: Request[]; synced?: boolean } = {}) {
  const update = vi.fn();
  const openReview = vi.fn();
  let requests = opts.initial ?? [req()];
  const hideNonRequests = opts.hideNonRequests ?? true;
  const readOnly = opts.readOnly ?? false;
  let synced = opts.synced ?? true;
  const hook = renderHook(
    ({ requests, synced }: { requests: Request[]; synced: boolean }) => useRequestToasts(requests, update, hideNonRequests, readOnly, openReview, synced),
    { initialProps: { requests, synced } },
  );
  const render = () => hook.rerender({ requests, synced });
  const setRequests = (next: Request[]) => {
    requests = next;
    render();
  };
  // A sync-full: the requests store is replaced first, then the room is flagged synced.
  const sync = (next: Request[]) => {
    requests = next;
    synced = true;
    render();
  };
  return {
    update,
    openReview,
    setRequests,
    sync,
    arrive: (...reqs: Request[]) => setRequests([...requests, ...reqs]),
    get requests() { return requests; },
    unmount: hook.unmount,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  toastMock.mockClear();
  dismissMock.mockClear();
  setOnTab(false);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('useRequestToasts', () => {
  it('keeps the single-request look for one request', () => {
    const q = setup();
    q.arrive(req({ source: 'donation', donor: 'Ana', character: 'Trapper', amount: 'R$ 10' }));

    const [title, opts] = last();
    expect(title).toBe(`${t('toast.newRequestDonation')} (#02)`);
    expect(opts.description).toBe(t('toast.requestedCharAmount', { donor: 'Ana', character: 'Trapper', amount: 'R$ 10' }));
    expect(opts.action).toBeUndefined();
  });

  it('updates one toast in place to a count of 3', () => {
    const q = setup();
    q.arrive(req({ donor: 'Ana', character: 'Trapper' }));
    q.arrive(req({ donor: 'Bia', character: '' }));
    q.arrive(req({ donor: 'Caio', character: 'Nurse' }));

    expect(calls()).toHaveLength(3);
    expect(new Set(calls().map(([, o]) => o.id)).size).toBe(1);

    // Bia's request has no character yet: it counts, but there's nothing to name.
    const [title, opts] = last();
    expect(title).toBe(t('toast.newRequests', { count: 3 }));
    expect(sentences(opts.description)).toEqual([
      t('toast.namesTwo', { a: 'Trapper', b: 'Nurse' }),
    ]);
    expect(opts.action).toBeUndefined();
  });

  it('shows a burst (one store change) as one toast update', () => {
    const q = setup();
    q.arrive(req({ character: 'Trapper' }), req({ character: 'Nurse' }), skipped({ donor: 'Ana' }));

    expect(calls()).toHaveLength(1);
    expect(last()[0]).toBe(t('toast.newRequests', { count: 2 }));
  });

  it('just counts requests when none has a character to name', () => {
    const q = setup();
    q.arrive(req({ character: '', type: 'unknown' }));
    q.arrive(req({ character: '', type: 'unknown' }));

    const [title, opts] = last();
    expect(title).toBe(t('toast.newRequests', { count: 2 }));
    expect(opts.description).toBeUndefined();
  });

  describe('skipped messages', () => {
    it('keeps the Undo toast for a single skipped message', () => {
      const q = setup();
      const one = skipped({ donor: 'Ana', message: 'x'.repeat(60) });
      q.arrive(one);

      const [title, opts] = last();
      expect(title).toBe(t('toast.ignored', { donor: 'Ana', message: 'x'.repeat(50) + '…' }));
      const action = opts.action as Action;
      expect(action.label).toBe(t('toast.undo'));
      act(() => action.onClick({}));
      expect(q.update).toHaveBeenCalledWith(one.id, { type: 'unknown', character: '' });

      // Undo closed that toast: the next arrival starts a new one.
      q.arrive(req());
      expect(last()[1].id).not.toBe(opts.id);
    });

    it('share the one toast with requests: the count as the title, both sentences as the description', () => {
      const q = setup();
      q.arrive(skipped({ donor: 'Ana', message: 'oi' }));
      q.arrive(req({ donor: 'Bia', character: 'Trapper' }));
      q.arrive(req({ donor: 'Caio', character: 'Nurse' }));
      q.arrive(skipped({ donor: 'Duda', message: 'gg' }));

      expect(new Set(calls().map(([, o]) => o.id)).size).toBe(1);
      const [title, opts] = last();
      expect(title).toBe(t('toast.newRequests', { count: 2 }));
      expect(typeof opts.description).toBe('string'); // one line
      expect(String(opts.description)).not.toContain(title); // the count lives in the title only
      expect(sentences(opts.description)).toEqual([
        t('toast.namesTwo', { a: 'Trapper', b: 'Nurse' }),
        t('toast.ignoredFrom', { count: 2, names: t('toast.namesTwo', { a: 'Ana', b: 'Duda' }) }),
      ]);
      expect((opts.action as Action).label).toBe(t('toast.review'));
    });

    it('title the summary when nothing else arrived', () => {
      const q = setup();
      q.arrive(skipped({ donor: 'Ana', message: 'oi' }));
      q.arrive(skipped({ donor: 'Bia', message: 'gg' }));

      const [title, opts] = last();
      expect(title).toBe(t('toast.ignoredCount', { count: 2 }));
      expect(opts.description).toBe(t('toast.ignoredFromNames', { names: t('toast.namesTwo', { a: 'Ana', b: 'Bia' }) }));
      expect((opts.action as Action).label).toBe(t('toast.review'));
    });

    it('turn Undo into Review once the toast summarizes more than one arrival', () => {
      const q = setup();
      const skippedDonor = 'Ana';
      q.arrive(skipped({ donor: skippedDonor }));
      q.arrive(req({ donor: 'Bia', character: 'Trapper' }));

      const [title, opts] = last();
      expect(title).toBe(t('toast.newRequests', { count: 1 }));
      expect(sentences(opts.description)).toEqual([
        'Trapper',
        t('toast.ignoredFrom', { count: 1, names: skippedDonor }),
      ]);
      const action = opts.action as Action;
      expect(action.label).toBe(t('toast.review'));
      act(() => action.onClick({}));
      expect(q.openReview).toHaveBeenCalledTimes(1);

      // Review closed that toast: the next arrival starts a new one.
      q.arrive(req());
      expect(last()[1].id).not.toBe(opts.id);
    });

    it('count as requests when hiding is off', () => {
      const q = setup({ hideNonRequests: false });
      q.arrive(skipped({ donor: 'Ana' }));
      expect(last()[1].description).toBe(t('toast.newRequestFrom', { donor: 'Ana' }));
      expect(last()[1].action).toBeUndefined();
    });
  });

  it('dismisses an outstanding toast on unmount', () => {
    const q = setup();
    q.arrive(req());
    q.unmount();
    expect(dismissMock).toHaveBeenCalledWith(last()[1].id);
  });

  describe('guards', () => {
    it('stays quiet for the queue that is already there on first load', () => {
      setup({ initial: [req(), req(), skipped()] });
      expect(toastMock).not.toHaveBeenCalled();
    });

    it('stays quiet until the first sync, and takes the synced queue as the baseline', () => {
      const cached = [req(), req()];
      const q = setup({ initial: cached, synced: false });
      q.setRequests([...cached, req()]); // the cache, still settling before the sync
      q.sync([...cached, req(), req({ done: true, doneAt: new Date() })]);
      expect(toastMock).not.toHaveBeenCalled();

      q.arrive(req());
      expect(toastMock).toHaveBeenCalledTimes(1);
    });

    it('counts the first request into an empty queue', () => {
      const q = setup({ initial: [] });
      q.arrive(req());
      q.arrive(req());
      expect(toastMock).toHaveBeenCalledTimes(2);
      expect(last()[0]).toBe(t('toast.newRequests', { count: 2 }));
    });

    it('stays quiet for viewers (read-only)', () => {
      const q = setup({ readOnly: true });
      q.arrive(req(), skipped());
      expect(toastMock).not.toHaveBeenCalled();
    });

    it('never toasts a done request', () => {
      const q = setup();
      q.arrive(req({ done: true, doneAt: new Date() }));
      expect(toastMock).not.toHaveBeenCalled();
    });

    it('waits for identification before toasting', () => {
      const q = setup();
      const pending = req({ needsIdentification: true, character: '', type: 'unknown' });
      q.arrive(pending);
      expect(toastMock).not.toHaveBeenCalled();

      q.setRequests(q.requests.map((r) => (r.id === pending.id ? { ...r, needsIdentification: false, character: 'Nurse', type: 'killer' } : r)));
      expect(toastMock).toHaveBeenCalledTimes(1);
    });

    it('toasts each request once', () => {
      const q = setup();
      const one = req();
      q.arrive(one);
      q.setRequests(q.requests.map((r) => (r.id === one.id ? { ...r, character: 'Trapper' } : r)));
      expect(toastMock).toHaveBeenCalledTimes(1);
    });
  });
});

describe('joinNames', () => {
  it('lists one, two and three names with a proper join', () => {
    expect(joinNames(['Ana'])).toBe('Ana');
    expect(joinNames(['Ana', 'Beto'])).toBe(t('toast.namesTwo', { a: 'Ana', b: 'Beto' }));
    expect(joinNames(['Ana', 'Beto', 'Caio'])).toBe(t('toast.namesThree', { a: 'Ana', b: 'Beto', c: 'Caio' }));
  });

  it('caps the list past three names with a count of the rest', () => {
    expect(joinNames(['Ana', 'Beto', 'Caio', 'Duda'])).toBe(t('toast.namesMore', { a: 'Ana', b: 'Beto', count: 2 }));
    expect(joinNames(['Ana', 'Beto', 'Caio', 'Duda', 'Edu', 'Fê'])).toBe(t('toast.namesMore', { a: 'Ana', b: 'Beto', count: 4 }));
  });

  it('names each sender once, in arrival order', () => {
    expect(joinNames(['Beto', 'Ana', 'Beto', 'ana', 'Ana'])).toBe(t('toast.namesTwo', { a: 'Beto', b: 'Ana' }));
    expect(joinNames(['Ana', 'Ana', 'Ana', 'Ana'])).toBe('Ana');
    // Duplicates don't count toward the cap or the "+N".
    expect(joinNames(['Ana', 'Beto', 'Ana', 'Caio', 'Beto'])).toBe(t('toast.namesThree', { a: 'Ana', b: 'Beto', c: 'Caio' }));
  });

});
