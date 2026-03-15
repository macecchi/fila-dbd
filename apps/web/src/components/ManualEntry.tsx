import { useState, useRef, useEffect, useCallback } from 'react';
import { CHARACTERS } from '../data/characters';
import { useChannel } from '../store';
import { CharacterAvatar } from './CharacterAvatar';
import { useTranslation } from '../i18n';
import type { Request } from '../types';

interface CharacterOption {
  name: string;
  type: 'killer' | 'survivor';
  portrait?: string;
  aliases: string[];
}

function getAllCharacterNames(): CharacterOption[] {
  const names: CharacterOption[] = [];
  for (const char of CHARACTERS.killers) {
    names.push({ name: char.name, type: 'killer', portrait: char.portrait, aliases: char.aliases });
  }
  for (const char of CHARACTERS.survivors) {
    names.push({ name: char.name, type: 'survivor', aliases: char.aliases });
  }
  return names;
}

function matchesSearch(char: CharacterOption, query: string): boolean {
  if (char.name.toLowerCase().includes(query)) return true;
  return char.aliases.some(a => a.toLowerCase().includes(query));
}

interface Props {
  isOpen: boolean;
  onClose: () => void;
}

export function ManualEntry({ isOpen, onClose }: Props) {
  const { useRequests, useChannelInfo } = useChannel();
  const addRequest = useRequests((s) => s.add);
  const owner = useChannelInfo((s) => s.owner);
  const { t } = useTranslation();
  const [input, setInput] = useState('');
  const [autocompleteItems, setAutocompleteItems] = useState<CharacterOption[]>([]);
  const [autocompleteIndex, setAutocompleteIndex] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const allChars = useRef<CharacterOption[]>([]);

  useEffect(() => {
    allChars.current = getAllCharacterNames();
  }, []);

  useEffect(() => {
    if (isOpen) {
      setTimeout(() => inputRef.current?.focus(), 50);
    } else {
      setInput('');
      setAutocompleteItems([]);
      setAutocompleteIndex(-1);
    }
  }, [isOpen]);

  const handleInputChange = (value: string) => {
    setInput(value);
    const val = value.toLowerCase().trim();
    if (!val) {
      setAutocompleteItems([]);
      return;
    }
    const matches = allChars.current
      .filter(c => matchesSearch(c, val))
      .sort((a, b) => {
        if (a.type === 'killer' && b.type !== 'killer') return -1;
        if (a.type !== 'killer' && b.type === 'killer') return 1;
        return 0;
      })
      .slice(0, 8);
    setAutocompleteItems(matches);
    setAutocompleteIndex(-1);
  };

  const selectCharacter = useCallback((char: CharacterOption) => {
    const request: Request = {
      id: Date.now() + Math.random(),
      timestamp: new Date(),
      donor: owner?.displayName || 'Manual',
      amount: '',
      amountVal: 0,
      message: char.name,
      character: char.name,
      type: char.type,
      source: 'manual'
    };
    addRequest(request);
    setInput('');
    setAutocompleteItems([]);
    onClose();
  }, [addRequest, onClose, owner]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      onClose();
      return;
    }
    if (autocompleteItems.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setAutocompleteIndex(i => Math.min(i + 1, autocompleteItems.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setAutocompleteIndex(i => Math.max(i - 1, 0));
    } else if (e.key === 'Enter' && autocompleteIndex >= 0) {
      e.preventDefault();
      selectCharacter(autocompleteItems[autocompleteIndex]);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="manual-entry-overlay" onClick={onClose}>
      <div className="manual-entry-popup" onClick={e => e.stopPropagation()}>
        <div className="manual-entry-header">
          <span>{t('manual.title')}</span>
          <button className="manual-entry-close" onClick={onClose}>×</button>
        </div>
        <div className="manual-entry-body">
          <input
            ref={inputRef}
            type="text"
            value={input}
            placeholder={t('manual.placeholder')}
            autoComplete="off"
            onChange={e => handleInputChange(e.target.value)}
            onKeyDown={handleKeyDown}
          />
          {autocompleteItems.length > 0 && (
            <div className="autocomplete-dropdown show">
              {autocompleteItems.map((item, i) => (
                <div
                  key={item.name}
                  className={`autocomplete-item ${item.type} ${i === autocompleteIndex ? 'active' : ''}`}
                  onClick={() => selectCharacter(item)}
                >
                  <CharacterAvatar portrait={item.portrait} type={item.type} size="sm" />
                  <span>{item.name}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
