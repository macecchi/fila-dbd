import { useAuth } from '../store/auth';
import type { SerializedRequest } from '../types';
import { API_URL } from '../config';

export async function fetchRequestsHistory(channel: string): Promise<SerializedRequest[]> {
  const token = await useAuth.getState().getAccessToken();
  if (!token) throw new Error('not_authenticated');

  const res = await fetch(`${API_URL}/api/rooms/${channel.toLowerCase()}/requests`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });

  if (!res.ok) {
    throw new Error(`fetch_failed:${res.status}`);
  }

  const data = await res.json() as { requests: SerializedRequest[] };
  return data.requests;
}

export type BotModStatus =
  | { ok: true; is_mod: boolean; bot_login: string }
  | { ok: false; reason: 'no_bot_token' | 'scope_missing' | 'twitch_error'; detail?: string };

export async function fetchBotModStatus(): Promise<BotModStatus> {
  const token = await useAuth.getState().getAccessToken();
  if (!token) throw new Error('not_authenticated');

  const res = await fetch(`${API_URL}/api/chat/mod-status`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });

  if (!res.ok) {
    throw new Error(`fetch_failed:${res.status}`);
  }
  return res.json() as Promise<BotModStatus>;
}
