const rtf = new Intl.RelativeTimeFormat('pt-BR', { numeric: 'auto' });

export function formatRelativeTime(date: Date): string {
  const diff = (date.getTime() - Date.now()) / 1000;
  if (Math.abs(diff) < 60) return rtf.format(Math.round(diff), 'second');
  if (Math.abs(diff) < 3600) return rtf.format(Math.round(diff / 60), 'minute');
  if (Math.abs(diff) < 86400) return rtf.format(Math.round(diff / 3600), 'hour');
  return rtf.format(Math.round(diff / 86400), 'day');
}

export function parseAmount(str: string): number {
  const m = str.match(/[\d,\.]+/);
  return m ? parseFloat(m[0].replace(',', '.')) : 0;
}

export interface ParsedDonationMessage {
  donor: string;
  amount: string;
  message: string;
}

export function parseDonationMessage(message: string): ParsedDonationMessage | null {
  const match = message.match(/^(.+?)\s+(?:doou|mandou)\s+(R\$\s?[\d,\.]+)(?::\s*|\s+e disse:\s*)(.*)$/i);
  if (!match) return null;
  return {
    donor: match[1].trim(),
    amount: match[2],
    message: match[3].trim()
  };
}
