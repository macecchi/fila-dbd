import { DEFAULT_CHARACTERS } from '@dbd-utils/shared';

const MODELS = ['gemini-3.1-flash-lite-preview', 'gemini-3-flash-preview', 'gemini-2.5-flash', 'gemini-2.5-flash-lite'];
const RETRIABLE_CODES = [429, 500, 502, 503, 504];
const MAX_RETRIES = 3;
const RETRY_DELAYS = [2000, 4000, 8000];

let currentModelIndex = 0;

export type ExtractionResult = {
  character: string;
  type: 'survivor' | 'killer' | 'none';
};

export async function extractCharacter(
  message: string,
  apiKey: string,
  attempt = 0,
  modelIdx = currentModelIndex,
  startIdx = currentModelIndex
): Promise<ExtractionResult> {
  const model = MODELS[modelIdx];

  console.log(`[extract] Starting extraction using model: ${model} (attempt ${attempt + 1}/${MAX_RETRIES + 1})`);

  const prompt = `Identify the Dead by Daylight character from the user message. This is the list of valid characters, although the user might not specify them exactly as on this list.

<survivors>
${DEFAULT_CHARACTERS.survivors.join('\n')}
</survivors>

<killers>
${DEFAULT_CHARACTERS.killers.join('\n')}
</killers>

<user_message>
${message}
</user_message>

Identify the Dead by Daylight character from the above user message. Return ONLY JSON with character name and type.
- The character name MUST be their official name, which is the first name in the slash-separated list provided above
  - e.g. Even if the message mentions "Myers", return "Shape", not "Michael Myers".
- Only extract a character if the user is clearly requesting one to play. Look for patterns like "joga de X", "vai de X", "uma de X", "play X", or a character name stated as a standalone request.
- Messages that are personal stories, questions, greetings, or general conversation WITHOUT a gameplay request should return type "none" — do NOT guess a character from vague context, metaphors, or unrelated words.
- If the text mentions multiple characters, determine by the intent of the message which ONE the user actually wants to play with or is requesting.
  - e.g. "I love pig, but play one with hag" should return "Hag".
  - e.g. "chega de Hag! Joga de Pinhead" should return "Cenobite" (Pinhead), not "Hag".
- If user requests a generic survivor (e.g. "joga de surv", "uma de survivor"), return character "Survivor" with type "survivor".
- Recognize creative spellings, slang, and affectionate variations of character names (e.g. "Drakuluxuuu" = Dracula, "demogogo" = Demogorgon, "pigzinha" = Pig).
- If exact character unknown, return empty character.
- If no character mentioned or requested, return type "none".`;

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          maxOutputTokens: 1000,
          responseMimeType: 'application/json',
          responseSchema: {
            type: 'object',
            properties: {
              character: { type: 'string' },
              type: { type: 'string', enum: ['survivor', 'killer', 'none'] },
            },
            required: ['character', 'type'],
          },
        },
      }),
    }
  );

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const msg = (err as any).error?.message || `HTTP ${res.status}`;

    console.warn(`[extract] Request failed with status ${res.status}: ${msg}`);

    if (RETRIABLE_CODES.includes(res.status)) {
      const nextIdx = (modelIdx + 1) % MODELS.length;
      if (nextIdx !== startIdx) {
        console.log(`[extract] Switching from ${model} to ${MODELS[nextIdx]}`);
        currentModelIndex = nextIdx;
        return extractCharacter(message, apiKey, 0, nextIdx, startIdx);
      }
      if (attempt < MAX_RETRIES) {
        console.log(`[extract] Retrying in ${RETRY_DELAYS[attempt]}ms (attempt ${attempt + 2}/${MAX_RETRIES + 1})`);
        await new Promise((r) => setTimeout(r, RETRY_DELAYS[attempt]));
        return extractCharacter(message, apiKey, attempt + 1, modelIdx, startIdx);
      }
      console.error(`[extract] All retries exhausted after ${MAX_RETRIES + 1} attempts`);
    }

    console.error(`[extract] Non-retriable error, throwing: ${msg}`);
    throw new Error(msg);
  }

  currentModelIndex = modelIdx;
  const data = await res.json() as any;
  console.log(`[extract] Response from ${model}:`, JSON.stringify(data).slice(0, 500));
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;

  if (!text) {
    const blockReason = data.promptFeedback?.blockReason
      || data.candidates?.[0]?.finishReason;
    console.warn(`[extract] Empty response from ${model}: ${blockReason || 'no candidates'}`);

    const nextIdx = (modelIdx + 1) % MODELS.length;
    if (nextIdx !== startIdx) {
      console.log(`[extract] Switching from ${model} to ${MODELS[nextIdx]}`);
      currentModelIndex = nextIdx;
      return extractCharacter(message, apiKey, 0, nextIdx, startIdx);
    }
    if (attempt < MAX_RETRIES) {
      console.log(`[extract] Retrying in ${RETRY_DELAYS[attempt]}ms (attempt ${attempt + 2}/${MAX_RETRIES + 1})`);
      await new Promise((r) => setTimeout(r, RETRY_DELAYS[attempt]));
      return extractCharacter(message, apiKey, attempt + 1, modelIdx, startIdx);
    }

    console.error(`[extract] All retries exhausted, returning empty`);
    return { character: '', type: 'none' };
  }

  const result = JSON.parse(text) as ExtractionResult;
  console.log(`[extract] Success: character="${result.character}" type="${result.type}"`);
  return result;
}
