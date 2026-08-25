import { useEffect, useRef, useState } from 'react';
import { useChannel } from '../../store';
import { fetchBotModStatus } from '../../services/api';
import { isLivePushSupported, isLivePushDisabled, setLivePushEnabled } from '../../services/push';
import { BotModStatusDialog, type BotModDialogMode } from '../BotModStatusDialog';
import { useTranslation } from '../../i18n';
import { SettingsSection } from './SettingsSection';
import { Toggle } from './Toggle';

export function BehaviorSection() {
  const { t } = useTranslation();
  const { useSources, canEditQueue } = useChannel();
  const { hideNonRequests, confirmInChat, setHideNonRequests, setConfirmInChat } = useSources();
  const readOnly = !canEditQueue;

  // Per-browser preference (not synced sources state): tracks the localStorage
  // opt-out flag in services/push.ts.
  const [liveNotif, setLiveNotif] = useState(() => !isLivePushDisabled());
  const [liveNotifPending, setLiveNotifPending] = useState(false);

  const handleLiveNotifClick = async () => {
    if (readOnly || liveNotifPending) return;
    const next = !liveNotif;
    setLiveNotif(next);
    setLiveNotifPending(true);
    try {
      await setLivePushEnabled(next);
    } finally {
      setLiveNotifPending(false);
    }
  };

  const [dialogMode, setDialogMode] = useState<BotModDialogMode | null>(null);
  const [togglePending, setTogglePending] = useState(false);
  const lostModCheckRanRef = useRef(false);

  // Session-start check: if confirm-in-chat is already on, verify the bot is still a mod.
  useEffect(() => {
    if (!confirmInChat || readOnly) return;
    if (lostModCheckRanRef.current) return;
    lostModCheckRanRef.current = true;

    void (async () => {
      try {
        const status = await fetchBotModStatus();
        if (status.ok && !status.is_mod) setDialogMode('lost-mod');
      } catch { /* transient — silent */ }
    })();
  }, [confirmInChat, readOnly]);

  const handleConfirmInChatClick = async () => {
    if (readOnly || togglePending) return;
    if (confirmInChat) { setConfirmInChat(false); return; }
    setTogglePending(true);
    try {
      const status = await fetchBotModStatus();
      if (status.ok && status.is_mod) setConfirmInChat(true);
      else setDialogMode('enabling');
    } catch {
      setDialogMode('enabling');
    } finally {
      setTogglePending(false);
    }
  };

  return (
    <SettingsSection title={t('settings.section.behavior')}>
      <div className="behavior-row">
        <div className="behavior-row-label">
          <div className="behavior-row-title">{t('sources.hideNonRequests')}</div>
          <div className="behavior-row-desc">{t('sources.hideNonRequestsDesc')}</div>
        </div>
        <Toggle
          checked={hideNonRequests}
          onClick={() => !readOnly && setHideNonRequests(!hideNonRequests)}
          disabled={readOnly}
        />
      </div>

      <div className="behavior-row">
        <div className="behavior-row-label">
          <div className="behavior-row-title">{t('chatConfirm.toggle')}</div>
          <div className="behavior-row-desc">{t('chatConfirm.toggleDesc')}</div>
        </div>
        <Toggle
          checked={confirmInChat}
          onClick={() => void handleConfirmInChatClick()}
          disabled={readOnly || togglePending}
        />
      </div>

      {isLivePushSupported() && (
        <div className="behavior-row">
          <div className="behavior-row-label">
            <div className="behavior-row-title">{t('liveNotif.toggle')}</div>
            <div className="behavior-row-desc">{t('liveNotif.toggleDesc')}</div>
          </div>
          <Toggle
            checked={liveNotif}
            onClick={() => void handleLiveNotifClick()}
            disabled={readOnly || liveNotifPending}
          />
        </div>
      )}

      <BotModStatusDialog
        isOpen={dialogMode !== null}
        mode={dialogMode ?? 'enabling'}
        onVerified={() => { setDialogMode(null); setConfirmInChat(true); }}
        onCancel={() => setDialogMode(null)}
        onTurnOff={() => { setDialogMode(null); setConfirmInChat(false); }}
      />
    </SettingsSection>
  );
}
