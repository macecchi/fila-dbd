import { useEffect, useRef, useState } from 'react';
import { useChannel } from '../../store';
import { fetchBotModStatus } from '../../services/api';
import { isLivePushSupported, isLivePushDisabled, isLivePushBlocked, setLivePushEnabled } from '../../services/push';
import { BotModStatusDialog, type BotModDialogMode } from '../BotModStatusDialog';
import { useTranslation } from '../../i18n';
import { SettingsSection } from './SettingsSection';
import { Toggle } from './Toggle';

export function BehaviorSection() {
  const { t } = useTranslation();
  const { useSources, canEditQueue } = useChannel();
  const { hideNonRequests, confirmInChat, setHideNonRequests, setConfirmInChat } = useSources();
  const readOnly = !canEditQueue;

  // Per-browser preference (not synced sources state): the localStorage opt-out
  // flag in services/push.ts, plus the browser permission — blocked
  // notifications mean the feature is off no matter what the flag says, so the
  // toggle reads off and the row explains why instead of silently lying.
  const [liveNotif, setLiveNotif] = useState(() => !isLivePushDisabled());
  const [liveNotifBlocked, setLiveNotifBlocked] = useState(() => isLivePushBlocked());

  // Permission is requested by ChannelContext *after* this mounts, and can also
  // change from the browser's site settings while the page is open — so track
  // it instead of snapshotting it, or the row keeps claiming the feature is on
  // long after it was denied.
  useEffect(() => {
    if (!isLivePushSupported()) return;
    let cancelled = false;
    let status: PermissionStatus | null = null;
    const update = () => { if (!cancelled) setLiveNotifBlocked(isLivePushBlocked()); };
    update();
    navigator.permissions?.query({ name: 'notifications' as PermissionName })
      .then((s) => {
        if (cancelled) return;
        status = s;
        s.addEventListener('change', update);
      })
      .catch(() => { /* Safari < 16 has no notifications permission query */ });
    document.addEventListener('visibilitychange', update);
    return () => {
      cancelled = true;
      status?.removeEventListener('change', update);
      document.removeEventListener('visibilitychange', update);
    };
  }, []);

  const handleLiveNotifClick = async () => {
    if (readOnly || liveNotifBlocked) return;
    const next = !liveNotif;
    // The preference is stored synchronously and the subscription work runs in
    // the background, so the toggle never greys out waiting on the service
    // worker.
    setLiveNotif(next);
    await setLivePushEnabled(next);
    // Enabling may have prompted for permission and been denied.
    setLiveNotifBlocked(isLivePushBlocked());
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
            <div className="behavior-row-desc">
              {liveNotifBlocked ? t('liveNotif.blocked') : t('liveNotif.toggleDesc')}
            </div>
          </div>
          <Toggle
            checked={liveNotif && !liveNotifBlocked}
            onClick={() => void handleLiveNotifClick()}
            disabled={readOnly || liveNotifBlocked}
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
