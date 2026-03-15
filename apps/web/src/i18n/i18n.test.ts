import { describe, it, expect } from 'vitest';
import ptBR from './locales/pt-BR';
import en from './locales/en';

describe('i18n locale files', () => {
  const ptKeys = Object.keys(ptBR).sort();
  const enKeys = Object.keys(en).sort();

  it('en.ts has all keys from pt-BR.ts', () => {
    const missing = ptKeys.filter((k) => !(k in en));
    expect(missing, `Missing keys in en.ts: ${missing.join(', ')}`).toEqual([]);
  });

  it('en.ts has no extra keys not in pt-BR.ts', () => {
    const extra = enKeys.filter((k) => !(k in ptBR));
    expect(extra, `Extra keys in en.ts: ${extra.join(', ')}`).toEqual([]);
  });

  it('both locale files have identical key sets', () => {
    expect(enKeys).toEqual(ptKeys);
  });

  it('no empty translation values', () => {
    const emptyPt = ptKeys.filter((k) => (ptBR as Record<string, string>)[k] === '');
    const emptyEn = enKeys.filter((k) => (en as Record<string, string>)[k] === '');
    expect(emptyPt, `Empty values in pt-BR.ts: ${emptyPt.join(', ')}`).toEqual([]);
    expect(emptyEn, `Empty values in en.ts: ${emptyEn.join(', ')}`).toEqual([]);
  });
});
