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

  it('shimmers while identifying and mirrors the text into data-text', () => {
    render(<SwapText text="Identifying..." shimmer className="char-name" />);
    const el = screen.getByText('Identifying...');
    expect(el.className).toContain('t-shimmer');
    expect(el.className).toContain('char-name');
    expect(el.getAttribute('data-text')).toBe('Identifying...');
  });

  it('swaps the text after the exit phase and drops the shimmer', () => {
    const { rerender } = render(<SwapText text="Identifying..." shimmer />);
    const el = screen.getByText('Identifying...');

    rerender(<SwapText text="Huntress" />);
    expect(el.className).toContain('is-exit');
    expect(el.textContent).toBe('Identifying...');

    act(() => { vi.advanceTimersByTime(150); });
    expect(el.textContent).toBe('Huntress');
    expect(el.className).not.toContain('is-exit');
    expect(el.className).not.toContain('is-enter-start');
    expect(el.className).not.toContain('t-shimmer');
    expect(el.getAttribute('data-text')).toBeNull();
  });

  it('drops the shimmer without animating when only the shimmer flips', () => {
    const { rerender } = render(<SwapText text="Trapper" shimmer />);
    const el = screen.getByText('Trapper');
    rerender(<SwapText text="Trapper" />);
    expect(el.className).not.toContain('t-shimmer');
    expect(el.className).not.toContain('is-exit');
  });

  it('skips the animation when reduced motion is requested', () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })));
    const { rerender } = render(<SwapText text="Identifying..." shimmer />);
    rerender(<SwapText text="Nurse" />);
    expect(screen.getByText('Nurse').className).not.toContain('is-exit');
  });
});
