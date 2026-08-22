import { useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';

/**
 * Text that animates when it changes (transitions.dev "text states swap"): the
 * old string exits up with a blur, the new one enters from below. While
 * `shimmer` is on, a gradient band sweeps across the glyphs
 * (transitions.dev "shimmer text") to signal work in progress — used for
 * requests whose character is still being identified.
 *
 * The swap is driven imperatively (class toggles + a forced reflow) because the
 * enter phase needs the new text painted in its "below" position *before* the
 * transition to rest starts — React's async commit can't guarantee that order.
 */
const FALLBACK_SWAP_DUR = 150;

/** The CSS owns the timing: read `--text-swap-dur` off the element rather than
 *  duplicating the number here, so the two can't drift. */
function swapDuration(el: HTMLElement): number {
  const raw = getComputedStyle(el).getPropertyValue('--text-swap-dur').trim();
  const value = parseFloat(raw);
  if (!Number.isFinite(value)) return FALLBACK_SWAP_DUR;
  return raw.endsWith('ms') ? value : value * 1000;
}

const prefersReducedMotion = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

interface Props {
  text: string;
  shimmer?: boolean;
  className?: string;
}

export function SwapText({ text, shimmer = false, className = '' }: Props) {
  const ref = useRef<HTMLSpanElement>(null);
  const [shown, setShown] = useState({ text, shimmer });
  const shownRef = useRef(shown);
  shownRef.current = shown;

  useEffect(() => {
    const current = shownRef.current;
    if (text === current.text) {
      // Shimmer flipped without the text changing (e.g. the LLM confirmed the
      // local guess) — no swap to animate, just drop the shimmer.
      if (shimmer !== current.shimmer) setShown({ text, shimmer });
      return;
    }
    const el = ref.current;
    if (!el || prefersReducedMotion()) {
      setShown({ text, shimmer });
      return;
    }
    el.classList.add('is-exit');
    const id = setTimeout(() => {
      // Synchronous commit: the DOM must carry the new text before we force the
      // reflow that separates the "jump below" from the animation back to rest.
      flushSync(() => setShown({ text, shimmer }));
      el.classList.remove('is-exit');
      el.classList.add('is-enter-start');
      void el.offsetHeight;
      el.classList.remove('is-enter-start');
    }, swapDuration(el));
    return () => {
      clearTimeout(id);
      el.classList.remove('is-exit', 'is-enter-start');
    };
  }, [text, shimmer]);

  return (
    <span
      ref={ref}
      className={`t-text-swap${shown.shimmer ? ' t-shimmer' : ''}${className ? ` ${className}` : ''}`}
      // The shimmer's ::before layer re-renders the same glyphs to clip the
      // gradient onto them, so it needs a copy of the visible string.
      data-text={shown.shimmer ? shown.text : undefined}
    >
      {shown.text}
    </span>
  );
}
