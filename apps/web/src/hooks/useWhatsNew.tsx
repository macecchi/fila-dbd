import { useEffect } from 'react';
import { toast } from 'sonner';
import { changelog, type ChangelogEntry } from '../data/changelog';
import { getLocale, t, type Locale } from '../i18n';

const STORAGE_KEY = 'dbd-whats-new-dismissed';
const TOAST_ID = 'whats-new';

function getDismissed(): Set<string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? new Set(JSON.parse(raw)) : new Set();
  } catch {
    return new Set();
  }
}

function dismissAll(ids: string[]) {
  const dismissed = getDismissed();
  for (const id of ids) dismissed.add(id);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...dismissed]));
  } catch { /* ignore */ }
}

/**
 * "28 de setembro" / "September 28", with the year only when it isn't this one.
 * The date is a calendar day, so it's read as local midnight: `new Date('2026-09-28')`
 * is UTC midnight, which Brazil (UTC-3) would render as the 27th.
 */
export function formatReleaseDate(date: string, locale: Locale, now = new Date()): string {
  const [y, m, d] = date.split('-').map(Number);
  const day = new Date(y, m - 1, d);
  return day.toLocaleDateString(locale, {
    day: 'numeric',
    month: 'long',
    ...(y !== now.getFullYear() ? { year: 'numeric' } : {}),
  });
}

/** Unseen entries, newest first. */
export function unseenEntries(entries: ChangelogEntry[], dismissed: Set<string>): ChangelogEntry[] {
  return entries.filter(e => !dismissed.has(e.id)).sort((a, b) => b.date.localeCompare(a.date));
}

function DigestBody({ entries }: { entries: ChangelogEntry[] }) {
  const locale = getLocale();
  return (
    <div className="whats-new-list">
      {entries.map(e => (
        <section key={e.id} className="whats-new-item">
          <time className="whats-new-date" dateTime={e.date}>{formatReleaseDate(e.date, locale)}</time>
          <ul className="whats-new-lines">
            {e.items.map(key => <li key={key}>{t(key)}</li>)}
          </ul>
        </section>
      ))}
    </div>
  );
}

export function useWhatsNew(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;

    const unseen = unseenEntries(changelog, getDismissed());
    if (unseen.length === 0) return;

    // Small delay so it doesn't compete with initial connection toasts.

    const timer = setTimeout(() => {
      const ids = unseen.map(e => e.id);
      toast(t('whatsNew.title'), {
        id: TOAST_ID,
        description: <DigestBody entries={unseen} />,
        duration: Infinity,
        position: 'top-right',
        classNames: { toast: 'whats-new-toast' },
        onDismiss: () => dismissAll(ids),
        onAutoClose: () => dismissAll(ids),
      });
    }, 2000);

    return () => clearTimeout(timer);
  }, [enabled]);
}
