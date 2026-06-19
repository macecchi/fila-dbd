import { DEFAULT_CHARACTERS } from '@filadbd/shared';
import type { RequestExtraType } from '@filadbd/shared';

const MODEL = 'gemini-3.1-flash-lite';
const RETRIABLE_CODES = [429, 500, 502, 503, 504];
const MAX_RETRIES = 3;
const RETRY_DELAYS = [2000, 4000, 8000];

export type ExtractionResult = {
  character: string;
  type: 'survivor' | 'killer' | 'none';
  matchedTerm?: string;
  build?: { text: string; matchedTerms?: string[] };
};

export async function extractCharacters(
  message: string,
  apiKey: string,
  maxCount: number,
  extras: RequestExtraType[] = [],
  attempt = 0
): Promise<ExtractionResult[]> {
  console.log(`[extract] Starting extraction using model: ${MODEL} (attempt ${attempt + 1}/${MAX_RETRIES + 1}, maxCount=${maxCount}, extras=${extras.join(',') || 'none'})`);

  const withBuild = extras.includes('build');

  const buildBlock = withBuild ? `

ALSO extract a "build" per character entry. A build is the loadout the streamer should equip: perk names (EN or PT, with creative spellings/slang), addon names, item or item-addon names (survivor loadouts), a theme like "build de aura" / "build irritante" / "build de endgame", or an explicit "sem perks" / "no perks" instruction. Apply equally to killers and survivors.

Builds are usually terse and OFTEN omit the word "build". The phrase right after the character name almost always IS the build — extract it into the build field instead of folding it into matchedTerm:
- "hag sem perks" → Hag, build text "sem perks"
- "Pig de aura" → Pig, build text "de aura"
- "drácula com sua build favorita" → Dark Lord, build text "build favorita"
- "wraith com o addon X" → Wraith, build text "addon X"
- "joga de doctor de build irritante" → Doctor, build text "build irritante"

Distribution rules:
- Two characters sharing one build phrase ("Pig e Hag de build de aura") → copy the SAME build onto both rows.
- Two characters with separate builds ("Pig de aura e Hag de gritos") → each gets its own build.
- Quantified characters ("3 trickster de build X") → ALL three share the same build.
- Build present but unclear ownership → attach to the FIRST character entry.

NEVER confuse a meta question about perks ("as perks tem sinergia com os poderes? joga de nurse") with a build request — questions are not loadout instructions. Omit the build field ONLY when the message contains zero loadout / addon / theme reference.

Build shape:
- text: short summary in the donor's language, verbatim wording/slang preserved.
- matchedTerms: array of EXACT substrings of <user_message> describing the build (each contiguous span as its own entry).
` : '';

  const prompt = `Identify Dead by Daylight characters requested in the user message. The user may request multiple characters. This is the list of valid characters, although the user might not specify them exactly as on this list.

<survivors>
${DEFAULT_CHARACTERS.survivors.join('\n')}
</survivors>

<killers>
${DEFAULT_CHARACTERS.killers.join('\n')}
</killers>

<user_message>
${message}
</user_message>

<max_count>${maxCount}</max_count>

Return ONLY JSON with a "characters" array. Each entry has character name, type, and the exact matched substring.
- Return characters in the order they appear in the message.
- The character name MUST be the official name (the first name in the slash-separated list above). e.g. "Myers" → "Shape".
- Extract ONLY the characters the user is COMMANDING the streamer to play (the user's request/order). A numeric quantifier attached to a name multiplies that specific name: "2 de trapper" → ["Trapper","Trapper"]; "3 trickster" → ["Trickster","Trickster","Trickster"]. The count never splits across other character names.
- Character names mentioned only as CONTEXT (the streamer's current/past killer, comparisons, complaints, memories, e.g. "tapete da X", "chega de X", "depois da X") are not part of the user's command — exclude them. Example: "joga 3 trickster pra despedir da krasue" → ["Trickster","Trickster","Trickster"] (krasue = what's currently being played, not requested).
- No command present (small talk, greetings, questions, personal stories, off-topic donations, wishes for future DBD content/chapters, or merely asking the streamer to play the killer side generically without naming a killer) → empty array. A word that merely resembles or evokes a character but is ordinary language in context (an everyday word, a number, an affectionate nickname for the streamer) is NOT a request — match a character only when the donor is clearly telling the streamer to play that character.
- Cap the total returned at max_count. If the user requests more, return the first max_count in message order. If the user requests fewer, return only what they asked for — do NOT pad to max_count.
- If the user requests a generic survivor ("joga de surv", "uma de survivor"), return one entry with character "Survivor" and type "survivor".
- Recognize creative spellings, slang, and affectionate variations (e.g. "Drakuluxuuu" = Dracula, "demogogo" = Demogorgon, "pigzinha" = Pig).
- Only emit an entry when a specific character is unmistakably being requested to play. If such a character is requested but you cannot map it to the list, use empty string for character with the best-guess type. Never fabricate, guess, or pad: when no specific character is clearly commanded, return an empty array rather than an uncertain or placeholder entry.
- In "matchedTerm", return the EXACT substring referring to that specific instance, preserving the original casing and spelling. If the same character is requested twice with the same wording, both entries may share the same matchedTerm.${buildBlock}`;

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
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
              characters: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    character: { type: 'string' },
                    type: { type: 'string', enum: ['survivor', 'killer', 'none'] },
                    matchedTerm: { type: 'string' },
                    ...(withBuild ? {
                      build: {
                        type: 'object',
                        properties: {
                          text: { type: 'string' },
                          matchedTerms: { type: 'array', items: { type: 'string' } },
                        },
                        required: ['text'],
                      },
                    } : {}),
                  },
                  required: ['character', 'type'],
                },
              },
            },
            required: ['characters'],
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
      if (attempt < MAX_RETRIES) {
        console.log(`[extract] Retrying in ${RETRY_DELAYS[attempt]}ms (attempt ${attempt + 2}/${MAX_RETRIES + 1})`);
        await new Promise((r) => setTimeout(r, RETRY_DELAYS[attempt]));
        return extractCharacters(message, apiKey, maxCount, extras, attempt + 1);
      }
      console.error(`[extract] All retries exhausted after ${MAX_RETRIES + 1} attempts`);
    }

    console.error(`[extract] Non-retriable error, throwing: ${msg}`);
    throw new Error(msg);
  }

  const data = await res.json() as any;
  console.log(`[extract] Response from ${MODEL}:`, JSON.stringify(data).slice(0, 500));
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;

  if (!text) {
    const blockReason = data.promptFeedback?.blockReason
      || data.candidates?.[0]?.finishReason;
    console.warn(`[extract] Empty response from ${MODEL}: ${blockReason || 'no candidates'}`);

    if (attempt < MAX_RETRIES) {
      console.log(`[extract] Retrying in ${RETRY_DELAYS[attempt]}ms (attempt ${attempt + 2}/${MAX_RETRIES + 1})`);
      await new Promise((r) => setTimeout(r, RETRY_DELAYS[attempt]));
      return extractCharacters(message, apiKey, maxCount, extras, attempt + 1);
    }

    console.error(`[extract] All retries exhausted, returning empty`);
    return [];
  }

  const parsed = JSON.parse(text) as { characters?: ExtractionResult[] };
  const characters = Array.isArray(parsed.characters) ? parsed.characters.slice(0, maxCount) : [];
  console.log(`[extract] Success: ${characters.length} character(s): ${characters.map(c => c.character).join(', ')}`);
  return characters;
}
