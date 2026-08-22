import { useChannel } from '../../store';
import { useTranslation } from '../../i18n';
import { SettingsSection } from './SettingsSection';

interface ActionsSectionProps {
  onReview?: () => void;
  onRecover?: () => void;
}

const Chevron = () => (
  <svg className="settings-action-btn-arrow" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M9 18l6-6-6-6" />
  </svg>
);

export function ActionsSection({ onReview, onRecover }: ActionsSectionProps) {
  const { t } = useTranslation();
  const { canEditQueue } = useChannel();

  if (!canEditQueue) return null;
  if (!onReview && !onRecover) return null;

  return (
    <SettingsSection title={t('settings.section.actions')}>
      <div className="settings-actions">
        {onReview && (
          <button type="button" className="settings-action-btn" onClick={onReview}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <path d="M3 9h18M9 3v18" />
            </svg>
            {t('sources.reviewRequests')}
            <Chevron />
          </button>
        )}
        {onRecover && (
          <button type="button" className="settings-action-btn" onClick={onRecover}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10" />
              <polyline points="12,6 12,12 16,14" />
            </svg>
            {t('sources.recoverVod')}
            <Chevron />
          </button>
        )}
      </div>
    </SettingsSection>
  );
}
