// Story-format video export ("Video for your Stories") — a condensed, ~28s
// canvas-drawn recap of the wrapped, recorded with MediaRecorder so it can be
// downloaded or shared straight into Instagram Stories. Lazy chunk: only
// reached via /:channel/wrapped/export, never imported by WrappedPage.
import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useTranslation, tLocale, type Locale } from '../../i18n';
import { navigate } from '../../utils/helpers';
import { getCharacterPortrait, getCharacterPortraitLarge } from '../../data/characters';
import { CURRENT_WRAPPED_EDITION, type WrappedPayload } from '@filadbd/shared';
import { fetchPublicWrapped, WrappedError } from '../../services/wrapped';
import '../../styles/wrapped.css';
import '../../styles/wrapped-export.css';

const base = import.meta.env.BASE_URL;

const CANVAS_W = 1080;
const CANVAS_H = 1920;

type PageState =
  | { phase: 'loading' }
  | { phase: 'not-generated' }
  | { phase: 'error' }
  | { phase: 'ready'; payload: WrappedPayload };

type RecordState = 'idle' | 'recording' | 'done' | 'unsupported';

interface Assets {
  killerPortrait?: HTMLImageElement;
  survivorPortrait?: HTMLImageElement;
  avatar?: HTMLImageElement;
  // Pre-tinted to bone-white (the source emblem is near-black — invisible on
  // the dark fog). Canvas can't use CSS filters, so the tint is baked in.
  emblem?: HTMLCanvasElement;
}

interface Segment {
  key: string;
  duration: number;
}

// Segments mirror the full wrapped page's best moments — stats WITH their AI
// captions, plus the first dynamic highlight, the username hall of fame and
// the edition award — condensed to a story-friendly ~28s.
function buildSegments(payload: WrappedPayload): Segment[] {
  const { stats, narrative } = payload;
  const segs: Segment[] = [
    { key: 'intro', duration: 2300 },
    { key: 'totals', duration: 2800 },
  ];
  if (stats.topKillers[0]) segs.push({ key: 'topKiller', duration: 2800 });
  if (stats.topSurvivors[0]) segs.push({ key: 'topSurvivor', duration: 2800 });
  segs.push({ key: 'ratio', duration: 2400 });
  if (stats.topRequesters[0]) segs.push({ key: 'requester', duration: 2400 });
  if (narrative.highlights?.[0]) segs.push({ key: 'highlight', duration: 2600 });
  if (narrative.funniestNames?.[0]) segs.push({ key: 'hallOfFame', duration: 2600 });
  segs.push({ key: 'persona', duration: 2400 });
  if (narrative.superlative?.title) segs.push({ key: 'superlative', duration: 2600 });
  segs.push({ key: 'finale', duration: 2100 });
  return segs;
}

// Palette matches wrapped.css's --w-* tokens (kept in sync with the poster design).
const PALETTE = {
  void: '#07060a',
  bone: '#ece5d8',
  ember: '#ff6a3c',
  blood: '#7d1f2b',
  entity: '#8b5cf6',
  gold: '#c4a063',
};

// --- Per-frame draw caches -------------------------------------------------
// drawScene runs at up to 60fps for ~28s. Text metrics (measureText) and
// gradients are pure functions of (font, text/coords) which never change
// within a segment, but the original code recomputed them every single
// frame — the dominant per-frame cost on mobile, where canvas text shaping
// is much slower than on desktop. These module-level caches memoize that
// work; they're cleared on every mount of the draw loop (see the effect
// below) so they never grow unbounded across page visits.
let textWidthCache = new Map<string, number>();
let wrapLinesCache = new Map<string, string[]>();
let linearGradientCache = new Map<string, CanvasGradient>();
let fogGradientCache = new Map<number, { bottom: CanvasGradient; top: CanvasGradient }>();
let vignetteCanvas: HTMLCanvasElement | null = null;

function resetDrawCaches() {
  textWidthCache = new Map();
  wrapLinesCache = new Map();
  linearGradientCache = new Map();
  fogGradientCache = new Map();
  vignetteCanvas = null;
}

function measureCached(ctx: CanvasRenderingContext2D, text: string): number {
  const key = `${ctx.font}|${text}`;
  let w = textWidthCache.get(key);
  if (w === undefined) {
    w = ctx.measureText(text).width;
    textWidthCache.set(key, w);
  }
  return w;
}

const EASE_OUT_EXPO = (p: number) => (p >= 1 ? 1 : 1 - Math.pow(2, -10 * p));

function easeOutBack(p: number) {
  const c1 = 1.4;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(p - 1, 3) + c1 * Math.pow(p - 1, 2);
}

function loadImage(src: string, crossOrigin?: 'anonymous'): Promise<HTMLImageElement | undefined> {
  return new Promise((resolve) => {
    const img = new Image();
    if (crossOrigin) img.crossOrigin = crossOrigin;
    img.onload = () => resolve(img);
    img.onerror = () => resolve(undefined);
    img.src = src;
  });
}

// Recolor an image to a flat tint, preserving its alpha (used for the
// near-black DBD emblem, which would otherwise vanish on the dark canvas).
function tintImage(img: HTMLImageElement, color: string): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = img.naturalWidth || img.width;
  c.height = img.naturalHeight || img.height;
  const ctx = c.getContext('2d');
  if (ctx) {
    ctx.drawImage(img, 0, 0);
    ctx.globalCompositeOperation = 'source-in';
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, c.width, c.height);
  }
  return c;
}

// The canvas draws portraits much larger than the 200x200 queue set, so it
// prefers the 512x512 lg/ portrait and falls back to the small one if the
// large file is missing for a given character.
async function loadPortrait(large: string | undefined, small: string | undefined): Promise<HTMLImageElement | undefined> {
  if (large) {
    const img = await loadImage(large);
    if (img) return img;
  }
  return small ? loadImage(small) : undefined;
}

// Estimates the frame rate the device actually achieved while drawing the
// (already-running) preview, from a rolling window of recent rAF timestamps.
// Used to pick a recording fps the encoder can keep up with, instead of
// assuming every device is desktop-class. Falls back to "assume it's fine"
// (60) when there isn't enough data yet (e.g. user taps export instantly).
function measureFps(frameTimes: number[]): number {
  if (frameTimes.length < 10) return 60;
  const first = frameTimes[0];
  const last = frameTimes[frameTimes.length - 1];
  const elapsed = last - first;
  if (elapsed <= 0) return 60;
  return ((frameTimes.length - 1) * 1000) / elapsed;
}

function pickMimeType(): string | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined;
  const candidates = ['video/mp4', 'video/webm;codecs=vp9', 'video/webm'];
  for (const c of candidates) {
    try {
      if (MediaRecorder.isTypeSupported(c)) return c;
    } catch { /* ignore */ }
  }
  return undefined;
}

// Segment-local progress (0..1), clamped, with an optional entry delay so
// content doesn't pop in the instant a segment starts.
function localProgress(elapsedInSegment: number, delay = 0, dur = 700): number {
  return Math.min(1, Math.max(0, (elapsedInSegment - delay) / dur));
}

function countUp(target: number, elapsedInSegment: number, delay = 150, dur = 950): number {
  return Math.round(target * EASE_OUT_EXPO(localProgress(elapsedInSegment, delay, dur)));
}

function fadeAlpha(elapsedInSegment: number, segDuration: number, fadeMs = 260): number {
  const fadeIn = Math.min(1, elapsedInSegment / fadeMs);
  const fadeOut = Math.min(1, (segDuration - elapsedInSegment) / fadeMs);
  return Math.max(0, Math.min(fadeIn, fadeOut));
}

// The vignette never depends on time — bake it into an offscreen canvas once
// instead of re-creating + filling a full-canvas gradient every frame.
function getVignetteCanvas(): HTMLCanvasElement {
  if (vignetteCanvas) return vignetteCanvas;
  const c = document.createElement('canvas');
  c.width = CANVAS_W;
  c.height = CANVAS_H;
  const vctx = c.getContext('2d');
  if (vctx) {
    const vignette = vctx.createLinearGradient(0, 0, 0, CANVAS_H);
    vignette.addColorStop(0, 'rgba(6, 5, 8, 0.65)');
    vignette.addColorStop(0.5, 'rgba(6, 5, 8, 0.35)');
    vignette.addColorStop(1, 'rgba(10, 8, 12, 0.75)');
    vctx.fillStyle = vignette;
    vctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
  }
  vignetteCanvas = c;
  return c;
}

// The drifting radial gradients only move a few px per frame — quantizing
// the drift and caching the gradient objects avoids allocating two fresh
// CanvasGradients every frame while staying visually identical.
function getFogGradients(ctx: CanvasRenderingContext2D, driftX: number) {
  const q = Math.round(driftX / 4) * 4;
  const cached = fogGradientCache.get(q);
  if (cached) return cached;
  const bottom = ctx.createRadialGradient(
    CANVAS_W * 0.5 + q, CANVAS_H * 1.05, 0,
    CANVAS_W * 0.5 + q, CANVAS_H * 1.05, CANVAS_H * 0.85
  );
  bottom.addColorStop(0, 'rgba(125, 31, 43, 0.55)');
  bottom.addColorStop(1, 'rgba(125, 31, 43, 0)');

  const top = ctx.createRadialGradient(
    CANVAS_W * 0.5 - q, -CANVAS_H * 0.1, 0,
    CANVAS_W * 0.5 - q, -CANVAS_H * 0.1, CANVAS_H * 0.6
  );
  top.addColorStop(0, 'rgba(139, 92, 246, 0.32)');
  top.addColorStop(1, 'rgba(139, 92, 246, 0)');

  const result = { bottom, top };
  fogGradientCache.set(q, result);
  return result;
}

function drawFog(ctx: CanvasRenderingContext2D, elapsedGlobal: number) {
  ctx.save();
  ctx.fillStyle = PALETTE.void;
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
  const driftX = Math.sin(elapsedGlobal / 4200) * 90;
  const { bottom, top } = getFogGradients(ctx, driftX);
  ctx.fillStyle = bottom;
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
  ctx.fillStyle = top;
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
  ctx.drawImage(getVignetteCanvas(), 0, 0);
  ctx.restore();
}

function drawEyebrow(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, align: CanvasTextAlign = 'left') {
  ctx.save();
  ctx.font = '300 38px "DM Sans", sans-serif';
  ctx.fillStyle = PALETTE.gold;
  ctx.textAlign = align;
  ctx.textBaseline = 'alphabetic';
  // Letter-spacing isn't native to canvas — emulate by drawing char by char.
  const spacing = 8;
  let cx = x;
  const chars = text.toUpperCase().split('');
  if (align === 'center') {
    const total = chars.reduce((w, c) => w + measureCached(ctx, c) + spacing, -spacing);
    cx = x - total / 2;
    ctx.textAlign = 'left';
  } else if (align === 'right') {
    const total = chars.reduce((w, c) => w + measureCached(ctx, c) + spacing, -spacing);
    cx = x - total;
    ctx.textAlign = 'left';
  }
  for (const c of chars) {
    ctx.fillText(c, cx, y);
    cx += measureCached(ctx, c) + spacing;
  }
  ctx.restore();
}

function drawGradientText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  font: string,
  colors: string[],
  align: CanvasTextAlign = 'left',
  maxWidth?: number
) {
  ctx.save();
  ctx.font = font;
  ctx.textAlign = align;
  ctx.textBaseline = 'alphabetic';
  const width = measureCached(ctx, text);
  // x/y/colors are fixed per call site within a segment (only elapsed-time
  // params change frame to frame), so the gradient is cacheable as-is.
  const gradKey = `${x}|${y}|${colors.join(',')}`;
  let grad = linearGradientCache.get(gradKey);
  if (!grad) {
    grad = ctx.createLinearGradient(x, y - 80, x, y + 20);
    const step = 1 / Math.max(1, colors.length - 1);
    colors.forEach((c, i) => grad!.addColorStop(Math.min(1, i * step), c));
    linearGradientCache.set(gradKey, grad);
  }
  ctx.fillStyle = grad;
  if (maxWidth && width > maxWidth) {
    const scale = maxWidth / width;
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(scale, 1);
    ctx.fillText(text, 0, 0);
    ctx.restore();
  } else {
    ctx.fillText(text, x, y);
  }
  ctx.restore();
}

// Line-breaking only depends on (font, text, maxWidth), all fixed for the
// lifetime of a segment — cache it instead of re-running the measureText
// loop on every one of the ~150+ frames a segment is on screen.
function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const key = `${ctx.font}|${maxWidth}|${text}`;
  const cached = wrapLinesCache.get(key);
  if (cached) return cached;
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = '';
  for (const w of words) {
    const test = line ? `${line} ${w}` : w;
    if (measureCached(ctx, test) > maxWidth && line) {
      lines.push(line);
      line = w;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  wrapLinesCache.set(key, lines);
  return lines;
}

// Wrapped, centered caption block (the AI-written narrative lines). Returns
// the y just past the last line so callers can stack content below it.
function drawCaption(ctx: CanvasRenderingContext2D, text: string, cx: number, y: number, maxWidth = 920, maxLines = 4): number {
  ctx.save();
  ctx.font = '500 46px "DM Sans", sans-serif';
  ctx.fillStyle = 'rgba(236, 229, 216, 0.88)';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  const all = wrapText(ctx, text, maxWidth);
  const lines = all.slice(0, maxLines);
  if (all.length > maxLines) {
    let last = lines[lines.length - 1];
    while (last.length > 1 && measureCached(ctx, `${last}…`) > maxWidth) last = last.slice(0, -1).trimEnd();
    lines[lines.length - 1] = `${last}…`;
  }
  let ly = y;
  for (const line of lines) {
    ctx.fillText(line, cx, ly);
    ly += 64;
  }
  ctx.restore();
  return ly;
}

function drawPortraitCircle(ctx: CanvasRenderingContext2D, img: HTMLImageElement | undefined, cx: number, cy: number, r: number, ringColor: string) {
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r + 10, 0, Math.PI * 2);
  ctx.strokeStyle = ringColor;
  ctx.lineWidth = 4;
  ctx.globalAlpha = 0.8;
  ctx.stroke();
  ctx.globalAlpha = 1;
  if (img) {
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.closePath();
    ctx.clip();
    const scale = Math.max((r * 2) / img.width, (r * 2) / img.height);
    const w = img.width * scale;
    const h = img.height * scale;
    ctx.drawImage(img, cx - w / 2, cy - h / 2, w, h);
  }
  ctx.restore();
}

function drawScene(
  ctx: CanvasRenderingContext2D,
  payload: WrappedPayload,
  lang: Locale,
  wt: (key: any, params?: Record<string, string | number>) => string,
  elapsed: number,
  assets: Assets,
  segments: Segment[]
) {
  const fmt = (n: number) => n.toLocaleString(lang);
  drawFog(ctx, elapsed);

  let acc = 0;
  let seg: Segment = segments[0];
  let segElapsed = 0;
  for (const s of segments) {
    if (elapsed < acc + s.duration || s === segments[segments.length - 1]) {
      seg = s;
      segElapsed = elapsed - acc;
      break;
    }
    acc += s.duration;
  }
  segElapsed = Math.min(segElapsed, seg.duration);
  const alpha = fadeAlpha(segElapsed, seg.duration);
  ctx.save();
  ctx.globalAlpha = alpha;

  const cx = CANVAS_W / 2;
  const stats = payload.stats;
  const narrative = payload.narrative;

  if (seg.key === 'intro') {
    if (assets.avatar) {
      ctx.save();
      ctx.globalAlpha *= 0.9;
      ctx.beginPath();
      ctx.arc(cx, 640, 96, 0, Math.PI * 2);
      ctx.clip();
      const scale = Math.max(192 / assets.avatar.width, 192 / assets.avatar.height);
      const w = assets.avatar.width * scale, h = assets.avatar.height * scale;
      ctx.drawImage(assets.avatar, cx - w / 2, 640 - h / 2, w, h);
      ctx.restore();
    }
    drawEyebrow(ctx, payload.channel.displayName, cx, 800, 'center');
    const rise = 30 * (1 - easeOutBack(localProgress(segElapsed, 0, 650)));
    ctx.save();
    ctx.translate(0, rise);
    drawGradientText(ctx, 'FILA DBD', cx, 920, '800 92px "DM Sans", sans-serif', [PALETTE.bone, PALETTE.gold, PALETTE.entity], 'center', 940);
    ctx.restore();
    ctx.font = '300 46px "DM Sans", sans-serif';
    ctx.fillStyle = PALETTE.bone;
    ctx.textAlign = 'center';
    ctx.fillText(payload.editionLabel, cx, 1005);
  } else if (seg.key === 'totals') {
    drawEyebrow(ctx, wt('wrapped.totalsTitle'), cx, 640, 'center');
    const n = countUp(stats.totalRequests, segElapsed);
    drawGradientText(ctx, fmt(n), cx, 900, '800 220px "DM Sans", sans-serif', [PALETTE.bone, PALETTE.gold, PALETTE.blood], 'center', 980);
    ctx.font = '300 42px "DM Sans", sans-serif';
    ctx.fillStyle = PALETTE.bone;
    ctx.textAlign = 'center';
    ctx.fillText(wt('wrapped.requestsLabel').toUpperCase(), cx, 975);
    if (narrative.captions?.totals) drawCaption(ctx, narrative.captions.totals, cx, 1100);
  } else if (seg.key === 'topKiller' || seg.key === 'topSurvivor') {
    const isKiller = seg.key === 'topKiller';
    const list = isKiller ? stats.topKillers : stats.topSurvivors;
    const top = list[0];
    if (top) {
      const img = isKiller ? assets.killerPortrait : assets.survivorPortrait;
      drawEyebrow(ctx, wt(isKiller ? 'wrapped.topKillerTitle' : 'wrapped.topSurvivorTitle'), cx, 560, 'center');
      const pop = easeOutBack(localProgress(segElapsed, 100, 550));
      ctx.save();
      ctx.translate(0, 0);
      drawPortraitCircle(ctx, img, cx, 840, 210 * Math.min(1, Math.max(0.6, pop)), isKiller ? PALETTE.blood : PALETTE.entity);
      ctx.restore();
      drawGradientText(ctx, top.character, cx, 1150, '800 78px "DM Sans", sans-serif', [PALETTE.bone, PALETTE.gold], 'center', 980);
      const n = countUp(top.count, segElapsed, 250);
      ctx.font = '500 48px "DM Sans", sans-serif';
      ctx.fillStyle = PALETTE.bone;
      ctx.textAlign = 'center';
      ctx.fillText(wt('wrapped.requestersCount', { count: n }), cx, 1220);
      const caption = isKiller ? narrative.captions?.topKiller : narrative.captions?.topSurvivor;
      if (caption) drawCaption(ctx, caption, cx, 1340);
    }
  } else if (seg.key === 'ratio') {
    const typed = stats.killerCount + stats.survivorCount;
    const killerPct = typed > 0 ? Math.round((stats.killerCount / typed) * 100) : 50;
    drawEyebrow(ctx, wt('wrapped.ratioTitle'), cx, 700, 'center');
    const p = localProgress(segElapsed, 150, 900);
    const drawnPct = Math.round(killerPct * EASE_OUT_EXPO(p));
    ctx.font = '800 150px "DM Sans", sans-serif';
    ctx.textAlign = 'center';
    drawGradientText(ctx, `${drawnPct}%`, cx - 200, 900, '800 130px "DM Sans", sans-serif', [PALETTE.bone, PALETTE.blood], 'center', 420);
    ctx.font = '300 40px "DM Sans", sans-serif';
    ctx.fillStyle = PALETTE.bone;
    ctx.fillText(wt('wrapped.ratioKillers').toUpperCase(), cx - 200, 965);
    drawGradientText(ctx, `${100 - drawnPct}%`, cx + 200, 900, '800 130px "DM Sans", sans-serif', [PALETTE.bone, PALETTE.entity], 'center', 420);
    ctx.fillText(wt('wrapped.ratioSurvivors').toUpperCase(), cx + 200, 965);
    if (narrative.captions?.ratio) drawCaption(ctx, narrative.captions.ratio, cx, 1090);
  } else if (seg.key === 'requester') {
    const top = stats.topRequesters[0];
    if (top) {
      drawEyebrow(ctx, wt('wrapped.requestersTitle'), cx, 800, 'center');
      const n = countUp(top.count, segElapsed, 200);
      drawGradientText(ctx, top.donor, cx, 940, '800 84px "DM Sans", sans-serif', [PALETTE.bone, PALETTE.gold], 'center', 980);
      ctx.font = '500 48px "DM Sans", sans-serif';
      ctx.fillStyle = PALETTE.bone;
      ctx.textAlign = 'center';
      ctx.fillText(wt('wrapped.requestersCount', { count: n }), cx, 1015);
      if (narrative.captions?.requesters) drawCaption(ctx, narrative.captions.requesters, cx, 1130);
    }
  } else if (seg.key === 'highlight') {
    const h = narrative.highlights[0];
    if (h) {
      const lines = (() => { ctx.font = '800 72px "DM Sans", sans-serif'; return wrapText(ctx, h.title, 900); })();
      let ly = 780;
      for (const line of lines) {
        drawGradientText(ctx, line, cx, ly, '800 72px "DM Sans", sans-serif', [PALETTE.bone, PALETTE.gold, PALETTE.entity], 'center', 940);
        ly += 88;
      }
      drawCaption(ctx, h.text, cx, ly + 20);
    }
  } else if (seg.key === 'hallOfFame') {
    drawEyebrow(ctx, wt('wrapped.funniestNamesTitle'), cx, 720, 'center');
    const entries = narrative.funniestNames.slice(0, 2);
    let ly = 860;
    for (const [i, f] of entries.entries()) {
      const pop = localProgress(segElapsed, 150 + i * 250, 500);
      ctx.save();
      ctx.globalAlpha *= Math.min(1, pop * 1.2);
      drawGradientText(ctx, f.name, cx, ly, '800 68px "DM Sans", sans-serif', [PALETTE.bone, PALETTE.gold], 'center', 940);
      ly = drawCaption(ctx, f.comment, cx, ly + 68, 900, 3) + 50;
      ctx.restore();
    }
  } else if (seg.key === 'persona') {
    drawEyebrow(ctx, wt('wrapped.personaTitle'), cx, 780, 'center');
    ctx.font = '800 66px "DM Sans", sans-serif';
    const lines = wrapText(ctx, narrative.personaTitle, 880);
    let ly = 900;
    for (const line of lines) {
      drawGradientText(ctx, line, cx, ly, '800 66px "DM Sans", sans-serif', [PALETTE.gold, PALETTE.bone, PALETTE.entity], 'center', 940);
      ly += 80;
    }
    if (narrative.personaText) drawCaption(ctx, narrative.personaText, cx, ly + 30);
  } else if (seg.key === 'superlative') {
    drawEyebrow(ctx, wt('wrapped.superlativeTitle'), cx, 740, 'center');
    ctx.font = '800 84px "DM Sans", sans-serif';
    const lines = wrapText(ctx, narrative.superlative.title, 900);
    let ly = 880;
    for (const line of lines) {
      drawGradientText(ctx, line, cx, ly, '800 84px "DM Sans", sans-serif', [PALETTE.gold, PALETTE.bone, PALETTE.entity], 'center', 940);
      ly += 100;
    }
    drawCaption(ctx, narrative.superlative.text, cx, ly + 20);
  } else if (seg.key === 'finale') {
    if (assets.emblem) {
      const box = 230;
      const scale = Math.min(box / assets.emblem.width, box / assets.emblem.height);
      const w = assets.emblem.width * scale, h = assets.emblem.height * scale;
      ctx.drawImage(assets.emblem, cx - w / 2, 760 + (box - h) / 2, w, h);
    }
    drawGradientText(ctx, 'FILA DBD', cx, 1100, '800 78px "DM Sans", sans-serif', [PALETTE.bone, PALETTE.gold, PALETTE.entity], 'center', 900);
    ctx.font = '300 42px "DM Sans", sans-serif';
    ctx.fillStyle = PALETTE.bone;
    ctx.textAlign = 'center';
    ctx.fillText(payload.channel.displayName, cx, 1170);
  }

  ctx.restore();
}

export function WrappedExportPage({ channel }: { channel: string }) {
  const { t, locale } = useTranslation();
  const edition = CURRENT_WRAPPED_EDITION.id;
  const [state, setState] = useState<PageState>({ phase: 'loading' });
  const [assets, setAssets] = useState<Assets | null>(null);
  const [recordState, setRecordState] = useState<RecordState>('idle');
  const [progress, setProgress] = useState(0);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [videoBlob, setVideoBlob] = useState<Blob | null>(null);
  const [mimeType, setMimeType] = useState<string | undefined>(undefined);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const recordingRef = useRef(false);
  const startRef = useRef(0);
  const elapsedRef = useRef(0);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  // Rolling window of recent rAF frame timestamps, used to measure the
  // device's actually-achieved frame rate during the (already-running)
  // preview loop, so we can pick a recording fps/bitrate the device can
  // sustain instead of assuming desktop-class performance everywhere.
  const frameTimesRef = useRef<number[]>([]);

  const pageLang: Locale = state.phase === 'ready' ? (state.payload.language ?? 'pt-BR') : locale;
  const segments = useMemo(
    () => (state.phase === 'ready' ? buildSegments(state.payload) : []),
    [state]
  );
  const animationMs = useMemo(() => segments.reduce((total, s) => total + s.duration, 0), [segments]);
  const animationMsRef = useRef(animationMs);
  animationMsRef.current = animationMs;
  const wt = useCallback(
    (key: any, params?: Record<string, string | number>) => tLocale(pageLang, key, params),
    [pageLang]
  );

  useEffect(() => {
    let cancelled = false;
    setState({ phase: 'loading' });
    fetchPublicWrapped(channel, edition)
      .then((payload) => { if (!cancelled) setState({ phase: 'ready', payload }); })
      .catch((e) => {
        if (cancelled) return;
        if (e instanceof WrappedError && e.code === 'not_generated') setState({ phase: 'not-generated' });
        else setState({ phase: 'error' });
      });
    return () => { cancelled = true; };
  }, [channel, edition]);

  // Preload portraits/avatar/emblem and the DM Sans weights the canvas draws
  // with, so the first painted frame never shows tofu/fallback glyphs.
  useEffect(() => {
    if (state.phase !== 'ready') return;
    let cancelled = false;
    const { payload } = state;
    (async () => {
      const topKiller = payload.stats.topKillers[0];
      const topSurvivor = payload.stats.topSurvivors[0];
      const killerSrc = topKiller ? getCharacterPortrait(topKiller.character, 'killer') : undefined;
      const survivorSrc = topSurvivor ? getCharacterPortrait(topSurvivor.character, 'survivor') : undefined;
      const killerSrcLarge = topKiller ? getCharacterPortraitLarge(topKiller.character, 'killer') : undefined;
      const survivorSrcLarge = topSurvivor ? getCharacterPortraitLarge(topSurvivor.character, 'survivor') : undefined;
      const [killerPortrait, survivorPortrait, avatar, emblemImg] = await Promise.all([
        loadPortrait(killerSrcLarge, killerSrc),
        loadPortrait(survivorSrcLarge, survivorSrc),
        payload.channel.avatarUrl ? loadImage(payload.channel.avatarUrl, 'anonymous') : Promise.resolve(undefined),
        loadImage(`${base}images/Dead-by-Daylight-Emblem.webp`),
      ]);
      const emblem = emblemImg ? tintImage(emblemImg, PALETTE.bone) : undefined;
      try {
        await Promise.all([
          document.fonts.load('800 100px "DM Sans"'),
          document.fonts.load('500 40px "DM Sans"'),
          document.fonts.load('300 30px "DM Sans"'),
        ]);
        await document.fonts.ready;
      } catch { /* best effort — canvas falls back to the system font */ }
      if (cancelled) return;
      setAssets({ killerPortrait, survivorPortrait, avatar, emblem });
    })();
    return () => { cancelled = true; };
  }, [state]);

  // Draw loop: loops the preview indefinitely; while recording, runs exactly
  // one pass and stops the recorder at the end.
  useEffect(() => {
    if (!assets || state.phase !== 'ready') return;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    resetDrawCaches();
    let raf: number;
    startRef.current = 0;
    const loop = (now: number) => {
      if (!startRef.current) startRef.current = now;
      const frameTimes = frameTimesRef.current;
      frameTimes.push(now);
      if (frameTimes.length > 90) frameTimes.shift();
      const rawElapsed = now - startRef.current;
      if (recordingRef.current) {
        if (rawElapsed >= animationMs) {
          drawScene(ctx, state.payload, pageLang, wt, animationMs, assets, segments);
          elapsedRef.current = animationMs;
          recordingRef.current = false;
          recorderRef.current?.stop();
          return;
        }
        elapsedRef.current = rawElapsed;
        drawScene(ctx, state.payload, pageLang, wt, rawElapsed, assets, segments);
      } else {
        const looped = rawElapsed % animationMs;
        drawScene(ctx, state.payload, pageLang, wt, looped, assets, segments);
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assets, state.phase]);

  useEffect(() => {
    if (recordState !== 'recording') return;
    const id = setInterval(() => {
      setProgress(Math.min(100, Math.round((elapsedRef.current / animationMsRef.current) * 100)));
    }, 120);
    return () => clearInterval(id);
  }, [recordState]);

  const handleGenerate = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || state.phase !== 'ready') return;
    const mime = pickMimeType();
    if (typeof MediaRecorder === 'undefined' || !canvas.captureStream) {
      setRecordState('unsupported');
      return;
    }
    if (videoUrl) URL.revokeObjectURL(videoUrl);
    setVideoUrl(null);
    setVideoBlob(null);
    setMimeType(mime);
    setProgress(0);
    chunksRef.current = [];

    // Explicit high bitrate: MediaRecorder's default bitrate is far too low
    // for 1080x1920 and produces visibly mushy video. Capture fps is capped
    // to what the device actually sustained while drawing the preview —
    // requesting 60fps capture from an encoder that can only keep up with
    // ~30fps produces dropped/duplicated-frame choppiness on phones, even
    // though desktop has no trouble with 60fps@12Mbps.
    const measuredFps = measureFps(frameTimesRef.current);
    const targetFps = measuredFps >= 50 ? 60 : 30;
    const bitrate = targetFps === 60 ? 12_000_000 : 7_000_000;
    const stream = canvas.captureStream(targetFps);
    const recorder = new MediaRecorder(stream, {
      videoBitsPerSecond: bitrate,
      ...(mime ? { mimeType: mime } : {}),
    });
    recorder.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
    recorder.onstop = () => {
      const blob = new Blob(chunksRef.current, { type: mime || 'video/webm' });
      setVideoBlob(blob);
      setVideoUrl(URL.createObjectURL(blob));
      setRecordState('done');
    };
    recorderRef.current = recorder;

    // Restart the draw loop from frame 0 for a clean recording.
    startRef.current = 0;
    elapsedRef.current = 0;
    recordingRef.current = true;
    setRecordState('recording');
    recorder.start();
  }, [state, videoUrl]);

  const fileExt = mimeType?.startsWith('video/mp4') ? 'mp4' : 'webm';
  const fileName = `retrospectiva-${channel.toLowerCase()}.${fileExt}`;
  const canShareFile = typeof navigator !== 'undefined' && !!navigator.canShare && !!videoBlob &&
    (() => {
      try {
        const file = new File([videoBlob], fileName, { type: videoBlob.type });
        return navigator.canShare({ files: [file] });
      } catch { return false; }
    })();

  const handleShareVideo = useCallback(async () => {
    if (!videoBlob) return;
    const file = new File([videoBlob], fileName, { type: videoBlob.type });
    try {
      await navigator.share({ files: [file], title: 'Fila DBD' });
    } catch { /* user cancelled */ }
  }, [videoBlob, fileName]);

  const goBack = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    navigate(`${base.replace(/\/$/, '')}/${channel.toLowerCase()}/wrapped`);
  }, [channel]);

  return (
    <div className="wrapped-root wx-root">
      <div className="wrapped-fog" aria-hidden="true" />
      <button className="wrapped-close" onClick={goBack} aria-label={t('wrapped.export.backToWrapped')}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
      </button>
      <div className="wrapped-stage wx-stage">
        {state.phase === 'loading' && (
          <div className="wrapped-slide-content wrapped-status">
            <div className="wrapped-spinner" />
            <p className="wrapped-shimmer">{t('wrapped.loading')}</p>
          </div>
        )}

        {state.phase === 'not-generated' && (
          <div className="wrapped-slide-content wrapped-status">
            <img className="wr-emblem" src={`${base}images/Dead-by-Daylight-Emblem.webp`} alt="" />
            <h2>{t('wrapped.notGenerated')}</h2>
            <p className="wrapped-caption">{t('wrapped.notGeneratedHint', { channel })}</p>
            <a className="wrapped-back-link" href={`${base.replace(/\/$/, '')}/${channel.toLowerCase()}/wrapped`} onClick={goBack}>
              {t('wrapped.export.backToWrapped')}
            </a>
          </div>
        )}

        {state.phase === 'error' && (
          <div className="wrapped-slide-content wrapped-status">
            <img className="wr-emblem" src={`${base}images/Dead-by-Daylight-Emblem.webp`} alt="" />
            <p className="wrapped-caption">{t('wrapped.export.loadError')}</p>
            <a className="wrapped-back-link" href={`${base.replace(/\/$/, '')}/${channel.toLowerCase()}/wrapped`} onClick={goBack}>
              {t('wrapped.export.backToWrapped')}
            </a>
          </div>
        )}

        {state.phase === 'ready' && (
          <div className="wx-panel">
            <span className="wr-eyebrow wx-eyebrow">{wt('wrapped.share.video')}</span>
            <div className="wx-canvas-wrap">
              <canvas ref={canvasRef} width={CANVAS_W} height={CANVAS_H} className="wx-canvas" />
              {!assets && <div className="wx-canvas-loading"><div className="wrapped-spinner" /></div>}
            </div>

            {recordState === 'unsupported' && <p className="wrapped-caption wx-hint">{wt('wrapped.export.unsupported')}</p>}

            {recordState !== 'done' && (
              <button
                className="wrapped-share-btn wx-generate-btn"
                disabled={!assets || recordState === 'recording'}
                onClick={(e) => { e.stopPropagation(); handleGenerate(); }}
              >
                {recordState === 'recording' ? wt('wrapped.export.recording') : wt('wrapped.export.generateButton')}
              </button>
            )}

            {recordState === 'recording' && (
              <div className="wx-progress" role="progressbar" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100}>
                <div className="wx-progress-fill" style={{ width: `${progress}%` }} />
              </div>
            )}

            {recordState === 'done' && videoUrl && (
              <div className="wx-result">
                <p className="wx-result-title">{wt('wrapped.export.ready')}</p>
                <div className="wx-result-actions">
                  {canShareFile ? (
                    <>
                      <button className="wrapped-share-btn" onClick={(e) => { e.stopPropagation(); handleShareVideo(); }}>
                        {wt('wrapped.export.shareVideo')}
                      </button>
                      <a className="wrapped-share-btn wx-secondary-btn" href={videoUrl} download={fileName}>{wt('wrapped.export.download')}</a>
                    </>
                  ) : (
                    <a className="wrapped-share-btn" href={videoUrl} download={fileName}>{wt('wrapped.export.download')}</a>
                  )}
                  <button className="wrapped-back-link" onClick={(e) => { e.stopPropagation(); handleGenerate(); }}>
                    {wt('wrapped.export.generateAgain')}
                  </button>
                </div>
                {canShareFile ? (
                  <p className="wrapped-caption wx-hint">{wt('wrapped.export.shareHint')}</p>
                ) : (
                  <>
                    <p className="wrapped-caption wx-hint">{wt('wrapped.export.iosHint')}</p>
                    <p className="wrapped-caption wx-hint">{wt('wrapped.export.generalHint')}</p>
                  </>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
