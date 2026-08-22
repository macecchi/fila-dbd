import { useState, useRef, useEffect, useCallback, useId } from 'react';
import { Dialog } from './Dialog';
import { useChannel } from '../store';
import { CharacterAvatar } from './CharacterAvatar';
import { useTranslation } from '../i18n';
import type { Request } from '../types';
import { getAllCharacterNames, searchCharacters, type CharacterOption } from './characterSearch';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  // Edit mode: same interface, but picking a character updates this request
  // instead of adding a new one. The note field edits the request's message —
  // useful for completing LivePix donates truncated at 250 chars. Pressing
  // Enter on the note saves a message-only edit (character unchanged);
  // Shift+Enter adds a line break.
  editRequest?: Request;
  onSave?: (updates: Partial<Request>) => void;
}

export function ManualEntry({ isOpen, onClose, editRequest, onSave }: Props) {
  const { useRequests, useChannelInfo } = useChannel();
  const addRequest = useRequests((s) => s.add);
  const owner = useChannelInfo((s) => s.owner);
  const { t } = useTranslation();
  const [input, setInput] = useState('');
  const [note, setNote] = useState('');
  const [autocompleteItems, setAutocompleteItems] = useState<CharacterOption[]>([]);
  const [autocompleteIndex, setAutocompleteIndex] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const allChars = useRef<CharacterOption[]>([]);
  const isEdit = !!editRequest;
  const charFieldId = useId();
  const noteFieldId = useId();

  useEffect(() => {
    allChars.current = getAllCharacterNames();
  }, []);

  // The note is a textarea so long messages (e.g. a LivePix donate truncated at
  // 250 chars being completed by hand) stay fully visible instead of scrolling
  // inside a one-line input. Grow it to fit its content, capped by CSS max-height.
  useEffect(() => {
    const el = noteRef.current;
    if (!el) return;
    el.style.height = 'auto';
    // border-box: scrollHeight excludes the border, height includes it.
    el.style.height = `${el.scrollHeight + (el.offsetHeight - el.clientHeight)}px`;
  }, [note, isOpen]);

  useEffect(() => {
    if (isOpen) {
      setInput(editRequest && editRequest.character && editRequest.type !== 'none' ? editRequest.character : '');
      setNote(editRequest?.message ?? '');
      setTimeout(() => inputRef.current?.select(), 50);
    } else {
      setInput('');
      setNote('');
      setAutocompleteItems([]);
      setAutocompleteIndex(-1);
    }
  }, [isOpen, editRequest]);

  const handleInputChange = (value: string) => {
    setInput(value);
    const val = value.toLowerCase().trim();
    if (!val) {
      setAutocompleteItems([]);
      return;
    }
    setAutocompleteItems(searchCharacters(allChars.current, val));
    setAutocompleteIndex(-1);
  };

  const finishEdit = useCallback((char: CharacterOption | null) => {
    if (!editRequest || !onSave) return;
    const trimmedNote = note.trim();
    const updates: Partial<Request> = {
      message: trimmedNote || editRequest.message,
      needsIdentification: false,
      validating: false,
    };
    if (char) {
      updates.character = char.name;
      updates.type = char.type;
      // A manual pick overrides whatever term was auto-matched before.
      updates.matchedTerm = undefined;
    }
    onSave(updates);
    onClose();
  }, [editRequest, onSave, note, onClose]);

  const selectCharacter = useCallback((char: CharacterOption) => {
    if (isEdit) {
      finishEdit(char);
      return;
    }
    const trimmedNote = note.trim();
    const request: Request = {
      id: Date.now() + Math.random(),
      timestamp: new Date(),
      donor: owner?.displayName || 'Manual',
      amount: '',
      amountVal: 0,
      message: trimmedNote || char.name,
      character: char.name,
      type: char.type,
      source: 'manual'
    };
    addRequest(request);
    setInput('');
    setNote('');
    setAutocompleteItems([]);
    onClose();
  }, [addRequest, onClose, owner, note, isEdit, finishEdit]);

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


  return (
    <Dialog isOpen={isOpen} onClose={onClose} className="manual-entry-popup">
      <div className="manual-entry-header">
        <span>{isEdit ? t('edit.title') : t('manual.title')}</span>
        <button className="manual-entry-close" onClick={onClose}>×</button>
      </div>
      <div className="manual-entry-body">
        <div className="modal-field">
          <label htmlFor={charFieldId}>{t('manual.characterLabel')}</label>
          <div className="manual-input-wrapper">
            <input
              id={charFieldId}
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
        <div className="modal-field">
          <label htmlFor={noteFieldId}>{isEdit ? t('edit.messageLabel') : t('manual.noteLabel')}</label>
          <textarea
            id={noteFieldId}
            ref={noteRef}
            className="manual-entry-note"
            rows={1}
            value={note}
            placeholder={isEdit ? t('edit.messagePlaceholder') : t('manual.notePlaceholder')}
            autoComplete="off"
            onChange={e => setNote(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Escape') onClose();
              // Edit mode: Enter on the note saves a message-only correction;
              // Shift+Enter inserts a line break instead.
              if (e.key === 'Enter' && !e.shiftKey && isEdit) {
                e.preventDefault();
                finishEdit(null);
              }
            }}
          />
        </div>
      </div>
    </Dialog>
  );
}
