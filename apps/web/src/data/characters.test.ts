import { describe, it, expect } from 'vitest';
import { tryLocalMatch, isWholeMessageMatch, getCharacterPortrait, CHARACTERS } from './characters';

describe('tryLocalMatch', () => {
  it('matches a single alias', () => {
    expect(tryLocalMatch('quero huntress')).toMatchObject({ character: 'Huntress', type: 'killer' });
  });

  it('prefers longer multi-word alias over substring at same position', () => {
    // "Vecna" matches both Lich and The First, but "Vecna Novo" should win for The First.
    const result = tryLocalMatch('vecna novo');
    expect(result).toMatchObject({ character: 'The First', type: 'killer' });
    expect(result?.ambiguous).toBeFalsy();
  });

  it('still picks Lich for plain "vecna"', () => {
    // Both Lich and The First list "Vecna" as alias; this stays ambiguous and
    // last-encountered wins (Lich is iterated first, so kept after dedup).
    const result = tryLocalMatch('quero vecna');
    expect(result?.character).toBe('Lich');
    expect(result?.ambiguous).toBe(true);
  });
});

describe('isWholeMessageMatch', () => {
  const check = (message: string) => isWholeMessageMatch(tryLocalMatch(message), message);

  it('is true when the message is exactly a character name', () => {
    expect(check('Trapper')).toBe(true);
  });

  it('is true ignoring surrounding whitespace and case', () => {
    expect(check('  trapper  ')).toBe(true);
  });

  it('is true for an alias that spans the whole message', () => {
    expect(check('Caçador')).toBe(true);
  });

  it('is false when there is text beyond the character name', () => {
    expect(check('Trapper com mori')).toBe(false);
    expect(check('quero Trapper')).toBe(false);
  });

  it('is false when the whole message is an ambiguous match', () => {
    // "vecna" is both Lich and The First — whole-message but ambiguous, so the LLM
    // must still disambiguate.
    expect(tryLocalMatch('vecna')?.ambiguous).toBe(true);
    expect(check('vecna')).toBe(false);
  });

  it('is false when there is no local match at all', () => {
    expect(check('xyzzy not a character')).toBe(false);
  });

  it('is false for a null match regardless of message', () => {
    expect(isWholeMessageMatch(null, 'Trapper')).toBe(false);
  });
});

describe('portraits', () => {
  // Listed, never imported: the keys are the files under public/ at test time.
  const onDisk = new Set(Object.keys(import.meta.glob('../../public/images/portraits/*.webp')).map(p => p.replace('../../public', '')));

  it('every killer and survivor has a portrait that exists on disk', () => {
    expect(onDisk.size).toBeGreaterThan(0);
    for (const c of [...CHARACTERS.killers, ...CHARACTERS.survivors]) {
      expect(c.portrait, c.name).toMatch(/^\/images\/portraits\/[^/]+\.webp$/);
      expect(onDisk.has(c.portrait!), c.portrait).toBe(true);
    }
  });

  it('looks survivors up by name and alias, and keeps roles apart', () => {
    expect(getCharacterPortrait('Dwight Fairfield', 'survivor')).toBe('/images/portraits/S01_DwightFairfield.webp');
    expect(getCharacterPortrait('Jane Hopper', 'survivor')).toBe('/images/portraits/S51_Eleven.webp');
    expect(getCharacterPortrait('Trapper', 'killer')).toBe('/images/portraits/K01_TheTrapper.webp');
    expect(getCharacterPortrait('Dwight Fairfield', 'killer')).toBeUndefined();
  });
});
