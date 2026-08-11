import { useState, useRef, useEffect, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import type { RequestExtra } from '../types';
import { BuildBadge } from './BuildBadge';

interface Props {
  portrait?: string;
  type: string;
  size?: 'sm' | 'md';
  extras?: RequestExtra[];
}

const base = import.meta.env.BASE_URL;
const portraitBg = `url('${base}images/CharPortrait_bg.webp')`;
const roleBg = `url('${base}images/CharPortrait_roleBG.webp')`;

function getBuild(extras?: RequestExtra[]): { text: string } | null {
  if (!extras) return null;
  const b = extras.find(e => e.type === 'build');
  return b ? { text: b.text } : null;
}

export function CharacterAvatar({ portrait, type, size = 'md', extras }: Props) {
  const sizeClass = size === 'sm' ? 'char-portrait-sm' : '';
  const build = getBuild(extras);
  const [showTooltip, setShowTooltip] = useState(false);
  const [coords, setCoords] = useState<{ left: number; top: number } | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!showTooltip) return;
    const onPointerDown = (e: PointerEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setShowTooltip(false);
      }
    };
    // The tooltip is fixed-positioned, so scrolling/resizing would leave it
    // stranded; dismiss instead of tracking the moving anchor.
    const onReflow = () => setShowTooltip(false);
    document.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('scroll', onReflow, true);
    window.addEventListener('resize', onReflow);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('scroll', onReflow, true);
      window.removeEventListener('resize', onReflow);
    };
  }, [showTooltip]);

  // Position the portaled tooltip against the avatar: anchored to its left edge
  // (grows rightward so it never clips off the left on mobile), clamped to the
  // viewport, and flipped above when there isn't room below.
  useLayoutEffect(() => {
    if (!showTooltip || !wrapperRef.current || !tooltipRef.current) {
      setCoords(null);
      return;
    }
    const margin = 8;
    const gap = 6;
    const anchor = wrapperRef.current.getBoundingClientRect();
    const tip = tooltipRef.current.getBoundingClientRect();
    const left = Math.max(margin, Math.min(anchor.left, window.innerWidth - margin - tip.width));
    const below = anchor.bottom + gap;
    const top = below + tip.height > window.innerHeight - margin
      ? anchor.top - gap - tip.height
      : below;
    setCoords({ left, top });
  }, [showTooltip, build?.text]);

  // Touch devices: a tap on the avatar opens the tooltip instead of marking
  // the card done. Desktop (hover-capable) keeps the existing mark-done click
  // and surfaces the tooltip on hover. Detecting via `(hover: hover)` rather
  // than ad-hoc UA checks avoids false positives on stylus/hybrid devices.
  const handleClick = (e: React.MouseEvent) => {
    if (!build) return;
    const hoverCapable = typeof window !== 'undefined' && window.matchMedia?.('(hover: hover)').matches;
    if (hoverCapable) return; // let the click bubble to the card → mark done
    e.stopPropagation();
    setShowTooltip(prev => !prev);
  };
  const handleMouseEnter = () => { if (build) setShowTooltip(true); };
  const handleMouseLeave = () => { setShowTooltip(false); };

  const interactionProps = {
    ref: wrapperRef,
    onClick: handleClick,
    onMouseEnter: handleMouseEnter,
    onMouseLeave: handleMouseLeave,
  };

  // Rendered into a body portal so the panel's `overflow: clip` / backdrop-filter
  // can't clip it or trap its stacking. Mounted (hidden) before coords resolve so
  // useLayoutEffect can measure it.
  const tooltipNode = build && showTooltip
    ? createPortal(
        <div
          ref={tooltipRef}
          className="build-tooltip"
          role="tooltip"
          style={{
            left: coords?.left ?? 0,
            top: coords?.top ?? 0,
            visibility: coords ? 'visible' : 'hidden',
          }}
        >
          {build.text}
        </div>,
        document.body,
      )
    : null;

  // The wrapper is the positioning context for the badge and must NOT clip it
  // (badge sits at bottom: -6px). The inner clip div preserves the existing
  // image-masking behavior for the portrait/role background without affecting
  // overlay children.
  if ((type === 'killer' || type === 'survivor') && portrait) {
    return (
      <div className={`char-portrait-wrapper ${sizeClass}`} {...interactionProps}>
        <div className="char-portrait-clip" style={{ backgroundImage: portraitBg }}>
          <div className={`char-portrait-bg ${type}`} style={{ WebkitMaskImage: roleBg, maskImage: roleBg }}></div>
          <img src={portrait} alt="" className="char-portrait" />
        </div>
        {build && <BuildBadge size={size} />}
        {tooltipNode}
      </div>
    );
  }

  const placeholderIcon = type === 'killer' ? 'IconKiller.webp' :
                          type === 'survivor' ? 'IconSurv.webp' :
                          'IconShuffle.webp';
  const placeholder = `${base}images/${placeholderIcon}`;
  return (
    <div className={`char-portrait-wrapper char-portrait-placeholder ${sizeClass}`} {...interactionProps}>
      <div className="char-portrait-clip" style={{ backgroundImage: portraitBg }}>
        <img src={placeholder} alt="" className="char-portrait" />
      </div>
      {build && <BuildBadge size={size} />}
      {tooltipNode}
    </div>
  );
}
