import type { ReactNode } from 'react';

export const renderTwitchSubBadge = (tier: number): ReactNode => {
  const bg = tier === 3 ? '#FFB300' : tier === 2 ? '#00D5FF' : '#9146FF';
  return (
    <span className="twitch-chat-badge" title={`Subscriber Tier ${tier}`}>
      <svg viewBox="0 0 16 16" fill="none">
        <rect width="16" height="16" rx="2" fill={bg} />
        <path d="M8 2.5l1.45 2.92 3.22.47-2.33 2.27.55 3.21L8 9.86l-2.89 1.51.55-3.21-2.33-2.27 3.22-.47L8 2.5z" fill="#FFF" />
      </svg>
    </span>
  );
};

export const renderDonationBadge = (): ReactNode => {
  return (
    <span className="twitch-chat-badge" title="Donation">
      <svg viewBox="0 0 16 16" fill="none">
        <rect width="16" height="16" rx="2" fill="#1D8A5B" />
        <text x="8" y="8" fill="#FFF" fontSize="11" fontWeight="bold" textAnchor="middle" dominantBaseline="central" fontFamily="system-ui, -apple-system, sans-serif">$</text>
      </svg>
    </span>
  );
};

export const renderBroadcasterBadge = (): ReactNode => {
  return (
    <span className="twitch-chat-badge" title="Broadcaster">
      <svg viewBox="0 0 16 16" fill="none">
        <rect width="16" height="16" rx="2" fill="#E91916" />
        <path d="M4 11V6.5l2 1.5 2-2 2 2 2-1.5V11H4z" fill="#FFF" />
      </svg>
    </span>
  );
};
