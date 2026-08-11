// Wrapped ("Retrospectiva") API calls. Imported only by the lazy WrappedPage
// chunk — keep it out of the eager entry.
import { useAuth } from '../store/auth';
import type { WrappedPayload, WrappedLanguage } from '@filadbd/shared';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8787';

export class WrappedError extends Error {
  constructor(
    public code: 'not_generated' | 'not_enough_data' | 'daily_limit_exceeded' | 'failed',
    public detail?: { totalRequests?: number; minRequests?: number }
  ) {
    super(code);
  }
}

async function parseWrapped(res: Response): Promise<WrappedPayload> {
  if (res.status === 404) throw new WrappedError('not_generated');
  if (res.status === 422) {
    const body = await res.json().catch(() => ({})) as { totalRequests?: number; minRequests?: number };
    throw new WrappedError('not_enough_data', body);
  }
  if (res.status === 429) throw new WrappedError('daily_limit_exceeded');
  if (!res.ok) throw new WrappedError('failed');
  const data = await res.json() as { wrapped: WrappedPayload };
  return data.wrapped;
}

// Public payload (money stats stripped server-side).
export async function fetchPublicWrapped(channel: string, edition: string): Promise<WrappedPayload> {
  const res = await fetch(`${API_URL}/rooms/${channel.toLowerCase()}/wrapped/${edition}`);
  return parseWrapped(res);
}

// Owner's full payload (includes private money stats).
export async function fetchOwnerWrapped(edition: string): Promise<WrappedPayload> {
  const token = await useAuth.getState().getAccessToken();
  if (!token) throw new WrappedError('failed');
  const res = await fetch(`${API_URL}/api/wrapped/${edition}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return parseWrapped(res);
}

// `language` is baked into the payload — the whole retrospective (narrative
// and UI labels) renders in it, for every viewer.
export async function generateWrapped(edition: string, language: WrappedLanguage): Promise<WrappedPayload> {
  const token = await useAuth.getState().getAccessToken();
  if (!token) throw new WrappedError('failed');
  const res = await fetch(`${API_URL}/api/wrapped/${edition}/generate`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ language }),
  });
  return parseWrapped(res);
}
