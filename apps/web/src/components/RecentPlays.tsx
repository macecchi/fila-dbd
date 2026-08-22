import { useMemo, useState } from 'react';
import type { Request } from '../types';
import { useChannel } from '../store';
import { useTranslation, getLocale } from '../i18n';
import { getKillerPortrait } from '../data/characters';
import { CharacterAvatar } from './CharacterAvatar';
import { formatRelativeTime } from '../utils/helpers';

// Done requests leave the queue entirely (only the review dialog lists them), so the
// header strip is the one place that still shows what was just played — confirmation
// for the streamer that the ✓ landed, and "what are they playing" for a viewer.
//
// They come off the requests store like everything else: the PartyKit room keeps the
// newest `RECENT_DONE_KEPT` done requests instead of pruning them the moment they
// reach D1, so the strip is the same in every window and survives a reload. It is not
// backed by D1 — see the internal recovery endpoint for why that would resurrect
// deleted requests — so after a DO storage loss the strip starts empty.
//
// Fewer are shown than the room keeps, deliberately: undoing the open entry pulls the
// next one in from the spares rather than leaving the strip a slot short.
const SHOWN = 3;

/** Newest first. Rows synced from D1 before `done_at` existed fall back to arrival time. */
function doneTime(r: Request): number {
  return (r.doneAt ?? r.timestamp).getTime();
}

function portraitFor(r: Request) {
  return r.type === 'killer' && r.character ? getKillerPortrait(r.character) ?? undefined : undefined;
}

export function RecentPlays() {
  const { useRequests, canEditQueue } = useChannel();
  const { t } = useTranslation();
  const requests = useRequests((s) => s.requests);
  const toggleDone = useRequests((s) => s.toggleDone);
  const [hoveredId, setHoveredId] = useState<number | null>(null);

  // Only identified characters: an "unidentified" or non-request card carries
  // nothing worth showing here.
  const recent = useMemo(() => (
    requests
      .filter(r => r.done && r.character && (r.type === 'killer' || r.type === 'survivor'))
      .sort((a, b) => doneTime(b) - doneTime(a))
      .slice(0, SHOWN)
  ), [requests]);

  // Exactly one entry is expanded: the newest, unless the cursor is on another one.
  // A hovered id that has left the list (undone, or pushed past the trail by newer
  // plays) falls back to the newest, so the strip is never left with nothing open.
  const activeId = recent.some(r => r.id === hoveredId) ? hoveredId : recent[0]?.id;

  if (recent.length === 0) return null;

  return (
    <div className="recent-plays">
      <span className="recent-plays-label">{t('header.recentPlays')}</span>
      {/* Reset on leaving the row rather than the entry, so sweeping the cursor
          across the strip never flickers back to the newest mid-move. */}
      <div className="recent-plays-row" onMouseLeave={() => setHoveredId(null)}>
        {recent.map((r) => {
          const active = r.id === activeId;
          const at = r.doneAt ?? r.timestamp;
          return (
            <div
              key={r.id}
              className={`recent-play${active ? ' active' : ''}`}
              onMouseEnter={() => setHoveredId(r.id)}
              // Touch has no hover — a tap expands the entry instead.
              onClick={() => setHoveredId(r.id)}
              title={active ? undefined : `${r.character} — ${r.donor}`}
            >
              <CharacterAvatar portrait={portraitFor(r)} type={r.type} size="sm" />
              <div className="recent-play-reveal" aria-hidden={!active}>
                <div className="recent-play-reveal-inner">
                  <div className="recent-play-info">
                    <span className="recent-play-name">{r.character}</span>
                    <span className="recent-play-donor">{r.donor}</span>
                    <span className="recent-play-time" title={at.toLocaleString(getLocale())}>
                      {formatRelativeTime(at)}
                    </span>
                  </div>
                  {canEditQueue && (
                    <button
                      className="recent-play-undo"
                      onClick={(e) => { e.stopPropagation(); toggleDone(r.id); }}
                      title={t('card.markUndone')}
                      tabIndex={active ? 0 : -1}
                    >
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                        <path d="M3 3v5h5" />
                      </svg>
                    </button>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
