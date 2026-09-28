import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, fireEvent, renderHook } from '@testing-library/react';
import { Toaster, toast } from 'sonner';
import { useWhatsNew, formatReleaseDate } from './useWhatsNew';
import { changelog } from '../data/changelog';

describe('formatReleaseDate', () => {
  beforeEach(() => { vi.useFakeTimers({ now: new Date(2026, 8, 30) }); });
  afterEach(() => { vi.useRealTimers(); });

  it('reads the day as a calendar day, not UTC midnight', () => {
    expect(formatReleaseDate('2026-09-28', 'pt-BR')).toBe('28 de setembro');
    expect(formatReleaseDate('2026-09-28', 'en')).toBe('September 28');
  });

  it('adds the year only when it is not the current one', () => {
    expect(formatReleaseDate('2025-12-01', 'pt-BR')).toBe('1 de dezembro de 2025');
    expect(formatReleaseDate('2025-12-01', 'en')).toBe('December 1, 2025');
  });
});

describe('changelog', () => {
  it('has unique ids and YYYY-MM-DD dates', () => {
    expect(new Set(changelog.map(e => e.id)).size).toBe(changelog.length);
    for (const e of changelog) {
      expect(e.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(e.items.length).toBeGreaterThan(0);
    }
  });
});

describe('useWhatsNew', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
  });

  afterEach(() => {
    // Sonner's toast store is module state: a toast left open would reappear in the
    // next test's Toaster.
    act(() => { toast.dismiss(); vi.advanceTimersByTime(1000); });
    vi.useRealTimers();
  });

  function mount(enabled: boolean) {
    render(<Toaster closeButton />);
    renderHook(() => useWhatsNew(enabled));
    act(() => { vi.advanceTimersByTime(2500); });
  }

  it('shows each unseen release with its date and lines, and remembers the close', () => {
    mount(true);
    const [latest] = changelog;
    const time = document.querySelector(`time[datetime="${latest.date}"]`);
    expect(time?.textContent).toBe(formatReleaseDate(latest.date, 'en'));
    expect(screen.getByText('Performance improvements')).toBeTruthy();

    fireEvent.click(screen.getByLabelText('Close toast'));
    expect(JSON.parse(localStorage.getItem('dbd-whats-new-dismissed')!)).toEqual(changelog.map(e => e.id));
  });

  it('stays quiet once everything was dismissed', () => {
    localStorage.setItem('dbd-whats-new-dismissed', JSON.stringify(changelog.map(e => e.id)));
    mount(true);
    expect(document.querySelector('.whats-new-list')).toBeNull();
  });

  it('never shows for non-owners', () => {
    mount(false);
    expect(document.querySelector('.whats-new-list')).toBeNull();
  });
});
