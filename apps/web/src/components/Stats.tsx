import { useChannel } from '../store';
import { useTranslation } from '../i18n';

export function Stats() {
  const { useRequests } = useChannel();
  const { t } = useTranslation();
  const requests = useRequests((s) => s.requests);
  const pending = requests.filter(d => !d.done);
  const survivorCount = pending.filter(d => d.type === 'survivor').length;
  const killerCount = pending.filter(d => d.type === 'killer').length;

  return (
    <div className="stats">
      <div className="stat">
        <div className="stat-value">{survivorCount}</div>
        <div className="stat-label">{t('stats.survs')}</div>
      </div>
      <div className="stat">
        <div className="stat-value">{killerCount}</div>
        <div className="stat-label">{t('stats.killers')}</div>
      </div>
    </div>
  );
}
