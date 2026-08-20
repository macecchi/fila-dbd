import { useState, useRef, useEffect, useCallback } from 'react';
import { CharacterAvatar } from './CharacterAvatar';
import { useTranslation } from '../i18n';
import type { Request } from '../types';
import { getAllCharacterNames, searchCharacters, type CharacterOption } from './characterSearch';

interface Props {
  request: Request;
  onClose: () => void;
  onSave: (updates: Partial<Request>) => void;
}

// Lets the channel owner correct or fill in a request by hand — pick the right
// character and, when the source message was cut (LivePix's 250-char chat relay),
// complete the message text from the LivePix feed.
export function EditRequestDialog({ request, onClose, onSave }: Props) {
  const { t } = useTranslation();
  const [input, setInput] = useState(request.character && request.type !== 'none' ? request.character : '');
  const [selected, setSelected] = useState<CharacterOption | null>(null);
  const [message, setMessage] = useState(request.message);
  const [autocompleteItems, setAutocompleteItems] = useState<CharacterOption[]>([]);
  const [autocompleteIndex, setAutocompleteIndex] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const allChars = useRef<CharacterOption[]>([]);

  useEffect(() => {
    allChars.current = getAllCharacterNames();
    setTimeout(() => inputRef.current?.select(), 50);
  }, []);

  const handleInputChange = (value: string) => {
    setInput(value);
    setSelected(null);
    const val = value.toLowerCase().trim();
    if (!val) {
      setAutocompleteItems([]);
      return;
    }
    setAutocompleteItems(searchCharacters(allChars.current, val));
    setAutocompleteIndex(-1);
  };

  const selectCharacter = useCallback((char: CharacterOption) => {
    setSelected(char);
    setInput(char.name);
    setAutocompleteItems([]);
    setAutocompleteIndex(-1);
  }, []);

  const handleSave = useCallback(() => {
    const updates: Partial<Request> = {
      message: message.trim() || request.message,
      needsIdentification: false,
      validating: false,
    };
    if (selected) {
      updates.character = selected.name;
      updates.type = selected.type;
      // A manual pick overrides whatever term was auto-matched before.
      updates.matchedTerm = undefined;
    }
    onSave(updates);
    onClose();
  }, [selected, message, request.message, onSave, onClose]);

  const canSave = !!selected || message.trim() !== request.message;

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      onClose();
      return;
    }
    if (autocompleteItems.length === 0) {
      if (e.key === 'Enter' && canSave) handleSave();
      return;
    }
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

  return (
    <div className="manual-entry-overlay" onClick={onClose}>
      <div className="manual-entry-popup" onClick={e => e.stopPropagation()}>
        <div className="manual-entry-header">
          <span>{t('edit.title')}</span>
          <button className="manual-entry-close" onClick={onClose}>×</button>
        </div>
        <div className="manual-entry-body">
          <div className="manual-input-wrapper">
            <input
              ref={inputRef}
              type="text"
              value={input}
              placeholder={t('edit.characterPlaceholder')}
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
          <textarea
            className="manual-entry-note edit-request-message"
            value={message}
            placeholder={t('edit.messagePlaceholder')}
            rows={3}
            onChange={e => setMessage(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Escape') onClose();
            }}
          />
          <button className="edit-request-save" disabled={!canSave} onClick={handleSave}>
            {t('edit.save')}
          </button>
        </div>
      </div>
    </div>
  );
}
