// Wrapped ("Retrospectiva") API calls. Imported only by the lazy WrappedPage
// chunk — keep it out of the eager entry.
import { useAuth } from '../store/auth';
import type { WrappedPayload, WrappedLanguage } from '@filadbd/shared';
import { API_URL } from '../config';

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

// Local dev only: any authenticated user acts as the room owner (mirrors the
// channel page's dev bypass), so tell the API which room to target. In prod
// this is never sent and the server would ignore it anyway.
const devChannel = (channel: string): string | undefined =>
  import.meta.env.DEV ? channel.toLowerCase() : undefined;

// Owner's full payload (includes private money stats).
export async function fetchOwnerWrapped(edition: string, channel: string): Promise<WrappedPayload> {
  const token = await useAuth.getState().getAccessToken();
  if (!token) throw new WrappedError('failed');
  const dev = devChannel(channel);
  const res = await fetch(`${API_URL}/api/wrapped/${edition}${dev ? `?channel=${dev}` : ''}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return parseWrapped(res);
}

// `language` is baked into the payload — the whole retrospective (narrative
// and UI labels) renders in it, for every viewer.
export async function generateWrapped(edition: string, language: WrappedLanguage, channel: string): Promise<WrappedPayload> {
  const token = await useAuth.getState().getAccessToken();
  if (!token) throw new WrappedError('failed');
  let res: Response;
  try {
    res = await fetch(`${API_URL}/api/wrapped/${edition}/generate`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ language, channel: devChannel(channel) }),
      // The generation call is slow (LLM); bound the wait past the server's
      // worst case so the UI shows "try again" instead of spinning for minutes.
      signal: AbortSignal.timeout(120_000),
    });
  } catch {
    throw new WrappedError('failed');
  }
  return parseWrapped(res);
}
