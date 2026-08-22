import { useEffect, useState } from 'react';
import { Dialog } from './Dialog';
import { fetchBotModStatus, type BotModStatus } from '../services/api';
import { useTranslation } from '../i18n';

export type BotModDialogMode = 'enabling' | 'lost-mod';

interface Props {
  isOpen: boolean;
  mode: BotModDialogMode;
  // Called when re-verification confirms the bot is a mod.
  // The parent should close the dialog and apply the enabled state.
  onVerified: () => void;
  // Cancel without changing the toggle (enabling mode).
  onCancel: () => void;
  // Dismiss and turn the feature off (lost-mod mode).
  onTurnOff: () => void;
}

type Feedback = null | { kind: 'still-not-modded' } | { kind: 'error' } | { kind: 'no-bot-token' };

export function BotModStatusDialog({ isOpen, mode, onVerified, onCancel, onTurnOff }: Props) {
  const { t } = useTranslation();
  const [verifying, setVerifying] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);

  // Reset transient state whenever the dialog opens/closes.
  useEffect(() => {
    if (!isOpen) {
      setVerifying(false);
      setFeedback(null);
    }
  }, [isOpen]);


  const verify = async () => {
    setVerifying(true);
    setFeedback(null);
    try {
      const status: BotModStatus = await fetchBotModStatus();
      if (status.ok && status.is_mod) {
        onVerified();
        return;
      }
      if (!status.ok && status.reason === 'no_bot_token') {
        setFeedback({ kind: 'no-bot-token' });
      } else if (!status.ok) {
        setFeedback({ kind: 'error' });
      } else {
        setFeedback({ kind: 'still-not-modded' });
      }
    } catch {
      setFeedback({ kind: 'error' });
    } finally {
      setVerifying(false);
    }
  };

  const dismissAction = mode === 'enabling'
    ? { label: t('chatConfirm.dialog.cancel'), onClick: onCancel }
    : { label: t('chatConfirm.dialog.turnOff'), onClick: onTurnOff };

  const title = mode === 'enabling'
    ? t('chatConfirm.dialog.enabling.title')
    : t('chatConfirm.dialog.lostMod.title');

  const body = mode === 'enabling'
    ? t('chatConfirm.dialog.enabling.body')
    : t('chatConfirm.dialog.lostMod.body');

  return (
    <Dialog isOpen={isOpen} onClose={dismissAction.onClick} className="bot-mod-dialog">
      <div className="modal-header">
        <div className="modal-title">{title}</div>
        <button className="modal-close" onClick={dismissAction.onClick} aria-label="Close">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      <div className="dialog-help-text">
        {body}

        <div className="bot-mod-command">
          <code>{t('chatConfirm.dialog.command')}</code>
        </div>
        <p className="dialog-help-text bot-mod-command-hint">
          {t('chatConfirm.dialog.commandHint')}
        </p>
      </div>

      {feedback?.kind === 'still-not-modded' && (
        <p className="bot-mod-feedback warn">{t('chatConfirm.dialog.stillNotModded')}</p>
      )}
      {feedback?.kind === 'error' && (
        <p className="bot-mod-feedback warn">{t('chatConfirm.dialog.errorChecking')}</p>
      )}
      {feedback?.kind === 'no-bot-token' && (
        <p className="bot-mod-feedback warn">{t('chatConfirm.dialog.noBotToken')}</p>
      )}

      <div className="modal-footer">
        <button className="btn btn-ghost" onClick={dismissAction.onClick} disabled={verifying}>
          {dismissAction.label}
        </button>
        <button className="btn btn-primary" onClick={() => void verify()} disabled={verifying}>
          {verifying ? t('chatConfirm.dialog.verifying') : t('chatConfirm.dialog.verifyAgain')}
        </button>
      </div>
    </Dialog>
  );
}
