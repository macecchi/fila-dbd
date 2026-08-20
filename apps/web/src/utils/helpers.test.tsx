import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseDonationMessage, parseAmount, isDonateBot, highlightTerms, navigate, scrollToTop, isLikelyTruncatedDonation, LIVEPIX_TRUNCATION_LENGTH } from './helpers';

describe('parseDonationMessage', () => {
  describe('LivePix format', () => {
    it('parses "doou R$ X:" format', () => {
      const result = parseDonationMessage('João doou R$ 10,00: Nurse');
      expect(result).toEqual({ donor: 'João', amount: 'R$ 10,00', message: 'Nurse' });
    });

    it('parses "doou R$ X e disse:" format', () => {
      const result = parseDonationMessage('João doou R$ 50,00 e disse: quero Huntress');
      expect(result).toEqual({ donor: 'João', amount: 'R$ 50,00', message: 'quero Huntress' });
    });

    it('parses "mandou R$ X:" format', () => {
      const result = parseDonationMessage('Maria mandou R$ 25,50: Trapper');
      expect(result).toEqual({ donor: 'Maria', amount: 'R$ 25,50', message: 'Trapper' });
    });

    it('parses R$ without space', () => {
      const result = parseDonationMessage('User doou R$10,00: Nurse');
      expect(result).toEqual({ donor: 'User', amount: 'R$10,00', message: 'Nurse' });
    });
  });

  describe('StreamElements format', () => {
    it('parses "mandou X e disse:" without currency', () => {
      const result = parseDonationMessage('User123 mandou 5.00 e disse: Vai de Trapper pra gente ver também');
      expect(result).toEqual({
        donor: 'User123',
        amount: '5.00',
        message: 'Vai de Trapper pra gente ver também'
      });
    });

    it('parses "just tipped $X -" format', () => {
      const result = parseDonationMessage('TestUser just tipped $10.00 - Nurse please');
      expect(result).toEqual({ donor: 'TestUser', amount: '$10.00', message: 'Nurse please' });
    });

    it('parses "just tipped $X:" format', () => {
      const result = parseDonationMessage('TestUser just tipped $5.00: Huntress');
      expect(result).toEqual({ donor: 'TestUser', amount: '$5.00', message: 'Huntress' });
    });
  });

  describe('currency variations', () => {
    it('handles no currency prefix', () => {
      const result = parseDonationMessage('User mandou 5.00 e disse: Nurse');
      expect(result).toEqual({ donor: 'User', amount: '5.00', message: 'Nurse' });
    });

    it('handles $ prefix', () => {
      const result = parseDonationMessage('User just tipped $5.00: Nurse');
      expect(result).toEqual({ donor: 'User', amount: '$5.00', message: 'Nurse' });
    });

    it('handles R$ with space', () => {
      const result = parseDonationMessage('User doou R$ 10,00: Nurse');
      expect(result).toEqual({ donor: 'User', amount: 'R$ 10,00', message: 'Nurse' });
    });

    it('handles R$ without space', () => {
      const result = parseDonationMessage('User doou R$10,00: Nurse');
      expect(result).toEqual({ donor: 'User', amount: 'R$10,00', message: 'Nurse' });
    });
  });

  describe('separator variations', () => {
    it('handles colon separator', () => {
      const result = parseDonationMessage('User doou R$ 10,00: Nurse');
      expect(result).not.toBeNull();
      expect(result!.message).toBe('Nurse');
    });

    it('handles "e disse:" separator', () => {
      const result = parseDonationMessage('User mandou 5.00 e disse: Nurse');
      expect(result).not.toBeNull();
      expect(result!.message).toBe('Nurse');
    });

    it('handles dash separator', () => {
      const result = parseDonationMessage('User mandou 5.00 - Nurse');
      expect(result).not.toBeNull();
      expect(result!.message).toBe('Nurse');
    });
  });

  describe('non-matches', () => {
    it('rejects regular chat', () => {
      expect(parseDonationMessage('oi galera')).toBeNull();
    });

    it('rejects chat commands', () => {
      expect(parseDonationMessage('!fila Huntress')).toBeNull();
    });

    it('rejects empty message after amount', () => {
      expect(parseDonationMessage('User doou R$ 10,00:')).toBeNull();
    });

    it('rejects message without verb', () => {
      expect(parseDonationMessage('User R$ 10,00: Nurse')).toBeNull();
    });

    it('rejects message without amount', () => {
      expect(parseDonationMessage('User doou: Nurse')).toBeNull();
    });

    it('rejects message without separator', () => {
      expect(parseDonationMessage('User doou R$ 10,00 Nurse')).toBeNull();
    });
  });

  describe('case insensitivity', () => {
    it('matches "DOOU" uppercase', () => {
      const result = parseDonationMessage('User DOOU R$ 10,00: Nurse');
      expect(result).not.toBeNull();
    });

    it('matches "Just Tipped" mixed case', () => {
      const result = parseDonationMessage('User Just Tipped $5.00: Nurse');
      expect(result).not.toBeNull();
    });
  });
});

describe('isDonateBot', () => {
  it('recognizes livepix', () => {
    expect(isDonateBot('livepix')).toBe(true);
  });

  it('recognizes LivePix (case insensitive)', () => {
    expect(isDonateBot('LivePix')).toBe(true);
  });

  it('recognizes streamelements', () => {
    expect(isDonateBot('streamelements')).toBe(true);
  });

  it('recognizes StreamElements (case insensitive)', () => {
    expect(isDonateBot('StreamElements')).toBe(true);
  });

  it('rejects random usernames', () => {
    expect(isDonateBot('randomuser')).toBe(false);
  });

  it('rejects empty string', () => {
    expect(isDonateBot('')).toBe(false);
  });
});

describe('parseAmount', () => {
  it('parses Brazilian format (comma decimal)', () => {
    expect(parseAmount('10,00')).toBe(10);
  });

  it('parses dot decimal format', () => {
    expect(parseAmount('5.00')).toBe(5);
  });

  it('treats comma as decimal (Brazilian format)', () => {
    expect(parseAmount('1,50')).toBe(1.5);
  });

  it('parses integer amount', () => {
    expect(parseAmount('50')).toBe(50);
  });

  it('returns 0 for non-numeric', () => {
    expect(parseAmount('abc')).toBe(0);
  });
});

describe('highlightTerms', () => {
  it('wraps a single term in a mark element', () => {
    const result = highlightTerms('hello world', ['world']);
    expect(result).toHaveLength(2);
    const html = renderToStaticMarkup(<>{result}</>);
    expect(html).toBe('hello <mark class="matched-term">world</mark>');
  });

  it('wraps multiple non-overlapping terms', () => {
    const result = highlightTerms('joga de kraseu com lethal e bbq', ['kraseu', 'lethal', 'bbq']);
    const html = renderToStaticMarkup(<>{result}</>);
    expect(html).toContain('<mark class="matched-term">kraseu</mark>');
    expect(html).toContain('<mark class="matched-term">lethal</mark>');
    expect(html).toContain('<mark class="matched-term">bbq</mark>');
  });

  it('drops a term that overlaps a previously-matched span', () => {
    const result = highlightTerms('use lethal pursuer', ['lethal pursuer', 'lethal']);
    const html = renderToStaticMarkup(<>{result}</>);
    expect(html).toBe('use <mark class="matched-term">lethal pursuer</mark>');
  });

  it('returns the message unchanged when no terms match', () => {
    const result = highlightTerms('plain message', ['nope']);
    const html = renderToStaticMarkup(<>{result}</>);
    expect(html).toBe('plain message');
  });

  it('returns the message as-is for empty terms array', () => {
    const result = highlightTerms('plain message', []);
    expect(result).toEqual(['plain message']);
  });

  it('skips the wrap when the term covers the whole message', () => {
    const result = highlightTerms('Trapper', ['Trapper']);
    expect(result).toEqual(['Trapper']);
  });

  it('skips the wrap when the term covers the whole trimmed message', () => {
    const result = highlightTerms('  Trapper  ', ['Trapper']);
    expect(result).toEqual(['  Trapper  ']);
  });
});

describe('scrollToTop', () => {
  afterEach(() => vi.restoreAllMocks());

  it('scrolls the window to the top and resets the element scrollTops', () => {
    const spy = vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
    // On mobile the body is the scroll container, not the window.
    document.documentElement.scrollTop = 200;
    document.body.scrollTop = 200;
    scrollToTop();
    expect(spy).toHaveBeenCalledWith(0, 0);
    expect(document.documentElement.scrollTop).toBe(0);
    expect(document.body.scrollTop).toBe(0);
  });
});

describe('navigate', () => {
  afterEach(() => vi.restoreAllMocks());

  it('pushes the path, scrolls to top, and fires popstate', () => {
    window.history.pushState(null, '', '/start');
    const scrollSpy = vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
    const pushSpy = vi.spyOn(window.history, 'pushState');
    const onPop = vi.fn();
    window.addEventListener('popstate', onPop);
    navigate('/somechannel');
    expect(pushSpy).toHaveBeenCalledWith(null, '', '/somechannel');
    expect(scrollSpy).toHaveBeenCalledWith(0, 0);
    expect(onPop).toHaveBeenCalledTimes(1);
    window.removeEventListener('popstate', onPop);
  });

  it('is a no-op when the path is already current', () => {
    window.history.pushState(null, '', '/same');
    const scrollSpy = vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
    const pushSpy = vi.spyOn(window.history, 'pushState');
    navigate('/same');
    expect(pushSpy).not.toHaveBeenCalled();
    expect(scrollSpy).not.toHaveBeenCalled();
  });
});

describe('isLikelyTruncatedDonation', () => {
  it('flags a message at the LivePix relay cap (production shape: cut mid-word, no ellipsis)', () => {
    // Real production case: 250-char donor message ending mid-word ("...cantou is").
    const msg = 'x'.repeat(LIVEPIX_TRUNCATION_LENGTH - 20) + ' Ela cantou is';
    expect(msg.length).toBeGreaterThanOrEqual(LIVEPIX_TRUNCATION_LENGTH - 6);
    expect(isLikelyTruncatedDonation('a'.repeat(LIVEPIX_TRUNCATION_LENGTH))).toBe(true);
    expect(isLikelyTruncatedDonation('a'.repeat(LIVEPIX_TRUNCATION_LENGTH + 30))).toBe(true);
  });

  it('does not flag ordinary short messages', () => {
    expect(isLikelyTruncatedDonation('Trapper')).toBe(false);
    expect(isLikelyTruncatedDonation('a'.repeat(LIVEPIX_TRUNCATION_LENGTH - 1))).toBe(false);
  });
});
