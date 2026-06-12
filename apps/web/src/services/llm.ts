import { tryLocalMatch, isWholeMessageMatch } from '../data/characters';
import { useAuth } from '../store/auth';
import type { Request, RequestExtra, RequestExtraType } from '../types';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8787';

declare const __APP_VERSION__: string;

type ExtractedCharacter = {
  character: string;
  type: string;
  matchedTerm?: string;
  build?: { text: string; matchedTerms?: string[] };
};

// `ok: false` means we could not get a judgment from the LLM (no token, HTTP
// error, rate limit, network failure). Callers MUST treat this as "no answer"
// and fall back to the local match — NOT as an authoritative "not a character".
// Encoding errors as sentinel character objects (the old behavior) let a
// transient outage permanently overwrite a good local guess with "unidentified".
type APIResult =
  | { ok: true; characters: ExtractedCharacter[] }
  | { ok: false };

async function callAPI(
  message: string,
  maxCount: number,
  extras: RequestExtraType[],
  onError?: (msg: string) => void
): Promise<APIResult> {
  const token = await useAuth.getState().getAccessToken();
  if (!token) return { ok: false };

  try {
    const res = await fetch(`${API_URL}/api/extract-character`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'X-Client-Version': __APP_VERSION__,
      },
      body: JSON.stringify({ message, maxCount, extras }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      const errorCode = (err as { error?: string }).error;
      if (errorCode === 'daily_limit_exceeded') {
        onError?.('Limite diário de identificações atingido');
        return { ok: false };
      }
      const msg = (err as { message?: string }).message || errorCode || `HTTP ${res.status}`;
      onError?.(msg);
      return { ok: false };
    }

    const body = await res.json() as {
      characters?: ExtractedCharacter[];
      character?: string;
      type?: string;
      matchedTerm?: string;
    };
    if (Array.isArray(body.characters)) return { ok: true, characters: body.characters };
    if (body.character || body.type) {
      return { ok: true, characters: [{ character: body.character ?? '', type: body.type ?? 'none', matchedTerm: body.matchedTerm }] };
    }
    return { ok: true, characters: [] };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Erro de rede';
    onError?.(msg);
    return { ok: false };
  }
}

function pickExtras(c: { build?: { text: string; matchedTerms?: string[] } }): RequestExtra[] | undefined {
  if (!c.build?.text) return undefined;
  return [{ type: 'build', text: c.build.text, matchedTerms: c.build.matchedTerms }];
}

export async function identifyCharacter(
  request: Request,
  extras: RequestExtraType[] = [],
  onError?: (msg: string) => void,
  onLLMUpdate?: (result: { character: string; type: 'survivor' | 'killer' | 'unknown' | 'none'; matchedTerm?: string; extras?: RequestExtra[]; validating: false }) => void
): Promise<{ character: string; type: 'survivor' | 'killer' | 'unknown' | 'none'; matchedTerm?: string; extras?: RequestExtra[]; validating?: boolean }> {
  const local = tryLocalMatch(request.message);
  const isAuthenticated = useAuth.getState().isAuthenticated;

  // Local match is authoritative ONLY when it spans the entire message (e.g. the
  // donor just wrote "Trapper"): there's nothing else to parse — no build, no
  // ambiguity, no surrounding intent — so we skip the LLM. When the matched name
  // is embedded in prose, the word may be context, a negation, a comparison, or
  // coincidental ("yoga on the bed" is not a request), so the LLM must judge the
  // donor's intent and its answer replaces the local guess wholesale.
  if (isWholeMessageMatch(local, request.message)) return local!;

  // Without auth we can't reach the LLM; fall back to the local guess (best effort).
  if (!isAuthenticated) return local ?? { character: '', type: 'unknown' };

  // Authenticated, with a local placeholder and a streaming callback: show the
  // local character immediately, then let the LLM result replace it wholesale.
  // The LLM is the source of truth for both identification and build extraction.
  if (local && onLLMUpdate) {
    callAPI(request.message, 1, extras, onError).then(res => {
      // API unreachable/errored — keep the local guess, just stop validating.
      // Without this, a transient outage would clobber "Trapper" → "unidentified".
      if (!res.ok) {
        onLLMUpdate({ character: local.character, type: local.type, matchedTerm: local.matchedTerm, validating: false });
        return;
      }
      const llmResult = res.characters[0] ?? { character: '', type: 'none' };
      onLLMUpdate({
        character: llmResult.character || '',
        type: (llmResult.type || 'unknown') as 'survivor' | 'killer' | 'unknown' | 'none',
        matchedTerm: llmResult.matchedTerm,
        extras: pickExtras(llmResult),
        validating: false,
      });
    });
    return { ...local, validating: true };
  }

  const res = await callAPI(request.message, 1, extras, onError);
  // No judgment from the LLM — preserve the local guess (best effort) rather
  // than overwriting it with an error sentinel.
  if (!res.ok) return local ?? { character: '', type: 'unknown' };
  const result = res.characters[0] ?? { character: '', type: 'none' };
  const type = result.type || 'unknown';
  return {
    character: result.character || '',
    type: type as 'survivor' | 'killer' | 'unknown' | 'none',
    matchedTerm: result.matchedTerm,
    extras: pickExtras(result),
  };
}

export async function testExtraction(
  input: string,
  onError?: (msg: string) => void,
  onLLMUpdate?: (result: { character: string; type: 'killer' | 'survivor' | 'unknown' }) => void
): Promise<{ character: string; type: 'killer' | 'survivor' | 'unknown'; isLocal: boolean; ambiguous?: boolean }> {
  if (!input) return { character: '', type: 'unknown', isLocal: false };

  const localResult = tryLocalMatch(input);
  const isAuthenticated = useAuth.getState().isAuthenticated;

  if (localResult) {
    if (localResult.ambiguous && isAuthenticated && onLLMUpdate) {
      callAPI(input, 1, [], onError).then(res => {
        if (!res.ok) return;
        const llmResult = res.characters[0] ?? { character: '', type: 'none' };
        if (llmResult.type !== 'none' && llmResult.character) {
          onLLMUpdate({
            character: llmResult.character,
            type: llmResult.type as 'killer' | 'survivor' | 'unknown'
          });
        }
      });
    }
    return { ...localResult, isLocal: true };
  }

  if (!isAuthenticated) {
    return { character: '', type: 'unknown', isLocal: false };
  }

  const res = await callAPI(input, 1, [], onError);
  const llm = (res.ok ? res.characters[0] : undefined) ?? { character: '', type: 'none' };
  return {
    character: llm.character || '',
    type: (llm.type as 'killer' | 'survivor' | 'unknown') || 'unknown',
    isLocal: false
  };
}

export async function identifyMultiple(
  message: string,
  maxCount: number,
  extras: RequestExtraType[] = [],
  onError?: (msg: string) => void
): Promise<Array<{
  character: string;
  type: 'survivor' | 'killer' | 'unknown' | 'none';
  matchedTerm?: string;
  extras?: RequestExtra[];
}>> {
  const isAuthenticated = useAuth.getState().isAuthenticated;
  if (!isAuthenticated) return [];
  const res = await callAPI(message, maxCount, extras, onError);
  // On failure return [] — the caller (buildDonationRequests) then emits a single
  // `needsIdentification` placeholder that auto-identify retries, instead of a
  // request permanently stuck on an "Erro na API" sentinel.
  if (!res.ok) return [];
  return res.characters.map(c => {
    const extrasOut: RequestExtra[] = [];
    if (c.build?.text) {
      extrasOut.push({ type: 'build', text: c.build.text, matchedTerms: c.build.matchedTerms });
    }
    return {
      character: c.character ?? '',
      type: (c.type ?? 'unknown') as 'survivor' | 'killer' | 'unknown' | 'none',
      matchedTerm: c.matchedTerm,
      extras: extrasOut.length > 0 ? extrasOut : undefined,
    };
  });
}
