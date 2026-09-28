import { useChannel } from '../store';
import { useTranslation } from '../i18n';
import { useQueueStatus } from '../hooks/useQueueStatus';

export function SourcesBadges() {
    const { useSources, useChannelInfo } = useChannel();
    const channelStatus = useChannelInfo((s) => s.status);
    const queueState = useQueueStatus().state;
    const sourcesEnabled = useSources((s) => s.enabled);
    const minDonation = useSources((s) => s.minDonation);
    const chatCommand = useSources((s) => s.chatCommand);
    const chatTiers = useSources((s) => s.chatTiers);

    const { t } = useTranslation();

    const badges = (() => {
        // Before the server's first status only a queue saved closed says so; the sources
        // wait for the sync that brings them.
        if (channelStatus === null) return queueState === 'closed' ? [t('badges.queueClosed')] : [];
        if (channelStatus !== 'live') return [t('badges.queueClosed')];
        const parts: string[] = [];
        if (sourcesEnabled.donation) parts.push(t('badges.donates', { amount: String(minDonation) }));
        if (sourcesEnabled.chat) {
            const minTier = chatTiers.length ? Math.min(...chatTiers) : 1;
            parts.push(`${chatCommand} (tier ${minTier}+)`);
        }
        if (sourcesEnabled.resub) parts.push(t('badges.resubs'));
        return parts.length ? parts : [t('badges.queueClosed')];
    })();

    return (
        <>
            {badges.map((badge, i) => (
                <span key={i} className="sources-summary">{badge}</span>
            ))}
        </>
    );
}
