import { useContextMenu } from '../context/ContextMenuContext';
import { useTranslation } from '../i18n';

interface Props {
  onToggleDone: (id: number) => void;
  onRerun: (id: number) => void;
  onSkip: (id: number) => void;
}

export function ContextMenu({ onToggleDone, onRerun, onSkip }: Props) {
  const { state, hide } = useContextMenu();
  const { t } = useTranslation();

  const handleAction = (action: 'done' | 'rerun' | 'skip') => {
    if (!state.requestId) return;
    switch (action) {
      case 'done': onToggleDone(state.requestId); break;
      case 'rerun': onRerun(state.requestId); break;
      case 'skip': onSkip(state.requestId); break;
    }
    hide();
  };

  if (!state.show) return null;

  return (
    <div
      className="context-menu show"
      style={{ left: state.x, top: state.y }}
    >
      <div className="context-menu-item" onClick={() => handleAction('done')}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <polyline points="20 6 9 17 4 12"></polyline>
        </svg>
        <span>{state.isDone ? t('context.markUndone') : t('context.markDone')}</span>
      </div>
      <div className="context-menu-item" onClick={() => handleAction('rerun')}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <polyline points="23 4 23 10 17 10"></polyline>
          <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path>
        </svg>
        {t('context.reidentify')}
      </div>
      <div className="context-menu-item" onClick={() => handleAction('skip')}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M9 18l6-6-6-6" />
        </svg>
        {t('context.skip')}
      </div>
    </div>
  );
}
