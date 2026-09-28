import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { SwapText } from './SwapText';

describe('SwapText', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false })));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  // The swapping element: its first child is the visible text node, any shimmer
  // overlay is a separate aria-hidden child.
  const swapEl = (container: HTMLElement) => container.querySelector('.t-text-swap') as HTMLElement;
  const visibleText = (el: HTMLElement) => el.firstChild?.textContent;
  const overlay = (el: HTMLElement) => el.querySelector('.t-shimmer-window');

  it('shimmers while identifying with a hidden copy of the text for the band', () => {
    const { container } = render(<SwapText text="Identifying..." shimmer className="char-name" />);
    const el = swapEl(container);
    expect(el.className).toContain('t-shimmer');
    expect(el.className).toContain('char-name');
    expect(visibleText(el)).toBe('Identifying...');
    expect(overlay(el)?.getAttribute('aria-hidden')).toBe('true');
    expect(overlay(el)?.textContent).toBe('Identifying...');
    // Assistive tech sees the name once.
    expect(screen.getAllByText('Identifying...')).toHaveLength(2);
    expect(screen.getByText('Identifying...', { ignore: '[aria-hidden] *' })).toBe(el);
  });

  it('swaps the text after the exit phase and drops the shimmer', () => {
    const { container, rerender } = render(<SwapText text="Identifying..." shimmer />);
    const el = swapEl(container);

    rerender(<SwapText text="Huntress" />);
    expect(el.className).toContain('is-exit');
    expect(visibleText(el)).toBe('Identifying...');

    act(() => { vi.advanceTimersByTime(150); });
    expect(el.textContent).toBe('Huntress');
    expect(el.className).not.toContain('is-exit');
    expect(el.className).not.toContain('is-enter-start');
    expect(el.className).not.toContain('t-shimmer');
    expect(overlay(el)).toBeNull();
  });

  it('drops the shimmer without animating when only the shimmer flips', () => {
    const { container, rerender } = render(<SwapText text="Trapper" shimmer />);
    const el = swapEl(container);
    rerender(<SwapText text="Trapper" />);
    expect(el.className).not.toContain('t-shimmer');
    expect(overlay(el)).toBeNull();
    expect(el.className).not.toContain('is-exit');
  });

  it('skips the animation when reduced motion is requested', () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })));
    const { rerender } = render(<SwapText text="Identifying..." shimmer />);
    rerender(<SwapText text="Nurse" />);
    expect(screen.getByText('Nurse').className).not.toContain('is-exit');
  });
});
