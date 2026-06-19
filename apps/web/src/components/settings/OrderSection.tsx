import { useState } from 'react';
import { useChannel } from '../../store';
import { useTranslation } from '../../i18n';
import { SettingsSection } from './SettingsSection';
import { Toggle } from './Toggle';
import { SOURCE_ICONS, SOURCE_LABEL_KEYS, type SourceType } from './source-icons';

export function OrderSection() {
  const { t } = useTranslation();
  const { useSources, canControlConnection } = useChannel();
  const {
    priority,
    sortMode,
    prioritizeTiers,
    prioritizeDonations,
    setPriority,
    setSortMode,
    setPrioritizeTiers,
    setPrioritizeDonations,
  } = useSources();
  const readOnly = !canControlConnection;

  const [draggedItem, setDraggedItem] = useState<SourceType | null>(null);
  const filteredPriority = priority.filter((s): s is SourceType => s !== 'manual');

  const handleDragStart = (source: SourceType) => { if (!readOnly) setDraggedItem(source); };
  const handleDragOver = (e: React.DragEvent, targetSource: SourceType) => {
    e.preventDefault();
    if (!draggedItem || draggedItem === targetSource) return;
    const newPriority = [...priority].filter((s): s is SourceType => s !== 'manual');
    const draggedIdx = newPriority.indexOf(draggedItem);
    const targetIdx = newPriority.indexOf(targetSource);
    if (draggedIdx === -1 || targetIdx === -1) return;
    newPriority.splice(draggedIdx, 1);
    newPriority.splice(targetIdx, 0, draggedItem);
    setPriority([...newPriority, 'manual']);
  };
  const handleDragEnd = () => setDraggedItem(null);

  return (
    <SettingsSection title={t('settings.section.order')}>
      <div className="segmented" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={sortMode === 'fifo'}
          className={`segmented-option ${sortMode === 'fifo' ? 'active' : ''}`}
          onClick={() => !readOnly && setSortMode('fifo')}
          disabled={readOnly}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="10" />
            <polyline points="12,6 12,12 16,14" />
          </svg>
          {t('settings.order.fifo')}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={sortMode === 'priority'}
          className={`segmented-option ${sortMode === 'priority' ? 'active' : ''}`}
          onClick={() => !readOnly && setSortMode('priority')}
          disabled={readOnly}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M12 2v20M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6" />
          </svg>
          {t('settings.order.priority')}
        </button>
      </div>

      <div className={`priority-wrap ${sortMode === 'fifo' ? 'collapsed' : ''}`}>
        <div className="priority-wrap-inner">
          <p className="segmented-help">{t('settings.order.help')}</p>
          <div className="priority-list">
            {filteredPriority.map((source, idx) => (
              <div
                key={source}
                className={`priority-row ${draggedItem === source ? 'dragging' : ''}`}
                data-src={source}
                draggable={!readOnly}
                onDragStart={() => handleDragStart(source)}
                onDragOver={e => handleDragOver(e, source)}
                onDragEnd={handleDragEnd}
              >
                <span className="priority-row-handle">
                  <svg width="10" height="14" viewBox="0 0 6 10" fill="currentColor">
                    <circle cx="1.5" cy="1.5" r="1" />
                    <circle cx="4.5" cy="1.5" r="1" />
                    <circle cx="1.5" cy="5" r="1" />
                    <circle cx="4.5" cy="5" r="1" />
                    <circle cx="1.5" cy="8.5" r="1" />
                    <circle cx="4.5" cy="8.5" r="1" />
                  </svg>
                </span>
                <span className="priority-row-num">{idx + 1}</span>
                <span className="priority-row-icon">{SOURCE_ICONS[source]}</span>
                <span className="priority-row-name">{t(SOURCE_LABEL_KEYS[source])}</span>
              </div>
            ))}
          </div>

          <div style={{ marginTop: '1.25rem', display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            <div className="behavior-row" style={{ padding: '0.5rem 0' }}>
              <div className="behavior-row-label">
                <div className="behavior-row-title">{t('settings.order.prioritizeTiers')}</div>
                <div className="behavior-row-desc">{t('settings.order.prioritizeTiersDesc')}</div>
              </div>
              <Toggle
                checked={prioritizeTiers}
                onClick={() => !readOnly && setPrioritizeTiers(!prioritizeTiers)}
                disabled={readOnly}
              />
            </div>

            <div className="behavior-row" style={{ padding: '0.5rem 0' }}>
              <div className="behavior-row-label">
                <div className="behavior-row-title">{t('settings.order.prioritizeDonations')}</div>
                <div className="behavior-row-desc">{t('settings.order.prioritizeDonationsDesc')}</div>
              </div>
              <Toggle
                checked={prioritizeDonations}
                onClick={() => !readOnly && setPrioritizeDonations(!prioritizeDonations)}
                disabled={readOnly}
              />
            </div>
          </div>
        </div>
      </div>
    </SettingsSection>
  );
}
