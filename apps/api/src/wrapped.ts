import type {
  WrappedStats,
  WrappedPrivate,
  WrappedNarrative,
  WrappedEdition,
  WrappedLanguage,
} from '@filadbd/shared';

// Quality-first single model for the narrative: it runs at most 5x/day per
// room, so unlike the high-volume extraction path it's worth paying for the
// strongest flash model rather than degrading to a weaker fallback. It gets
// one retry on transient errors (429/5xx) or a timeout.
const NARRATIVE_MODEL = 'gemini-3.6-flash';
const NARRATIVE_ATTEMPTS = 2;
const RETRIABLE_CODES = [429, 500, 502, 503, 504];
const RETRY_DELAY_MS = 2000;
const ATTEMPT_TIMEOUT_MS = 25_000;

// The narrative is the heart of the retrospective — if every model fails, the
// generation fails (nothing is stored) rather than caching a generic recap.
export class NarrativeError extends Error {
  constructor() {
    super('narrative_failed');
  }
}

// Requests that count as real character requests for stats. `type = 'none'`
// rows are detected non-requests (small talk donations etc.) — excluded from
// request stats but their money still counts toward donation totals.
const REQ_FILTER = `room_id = ?1 AND deleted_at IS NULL AND timestamp >= ?2 AND timestamp < ?3 AND type != 'none'`;

export async function computeWrappedStats(
  db: D1Database,
  roomId: string,
  edition: WrappedEdition
): Promise<{ stats: WrappedStats; priv: WrappedPrivate; sampleMessages: string[]; requesterNames: string[] }> {
  const bind = [roomId, edition.start, edition.end] as const;

  const [
    totals,
    topKillers,
    topSurvivors,
    topRequesters,
    monthly,
    busiestDay,
    sources,
    firstRequest,
    loyalFan,
    money,
    topDonors,
    biggestDonation,
    samples,
    requesterNames,
  ] = await Promise.all([
    db.prepare(
      `SELECT COUNT(*) AS total,
              SUM(done) AS done_count,
              SUM(CASE WHEN type = 'killer' THEN 1 ELSE 0 END) AS killer_count,
              SUM(CASE WHEN type = 'survivor' THEN 1 ELSE 0 END) AS survivor_count,
              COUNT(DISTINCT CASE WHEN character != '' THEN character END) AS distinct_chars,
              COUNT(DISTINCT LOWER(donor)) AS distinct_requesters
       FROM requests WHERE ${REQ_FILTER}`
    ).bind(...bind).first<Record<string, number>>(),

    db.prepare(
      `SELECT character, COUNT(*) AS count FROM requests
       WHERE ${REQ_FILTER} AND type = 'killer' AND character != ''
       GROUP BY character ORDER BY count DESC LIMIT 5`
    ).bind(...bind).all<{ character: string; count: number }>(),

    db.prepare(
      `SELECT character, COUNT(*) AS count FROM requests
       WHERE ${REQ_FILTER} AND type = 'survivor' AND character != ''
       GROUP BY character ORDER BY count DESC LIMIT 5`
    ).bind(...bind).all<{ character: string; count: number }>(),

    db.prepare(
      `SELECT donor, COUNT(*) AS count FROM requests
       WHERE ${REQ_FILTER} AND source != 'manual' AND LOWER(donor) != LOWER(?1)
       GROUP BY LOWER(donor) ORDER BY count DESC LIMIT 5`
    ).bind(...bind).all<{ donor: string; count: number }>(),

    db.prepare(
      `SELECT substr(timestamp, 1, 7) AS month, COUNT(*) AS count FROM requests
       WHERE ${REQ_FILTER} GROUP BY month ORDER BY month ASC`
    ).bind(...bind).all<{ month: string; count: number }>(),

    db.prepare(
      `SELECT substr(timestamp, 1, 10) AS date, COUNT(*) AS count FROM requests
       WHERE ${REQ_FILTER} GROUP BY date ORDER BY count DESC, date ASC LIMIT 1`
    ).bind(...bind).first<{ date: string; count: number }>(),

    db.prepare(
      `SELECT source, COUNT(*) AS count FROM requests
       WHERE ${REQ_FILTER} GROUP BY source`
    ).bind(...bind).all<{ source: string; count: number }>(),

    db.prepare(
      `SELECT donor, character, timestamp FROM requests
       WHERE ${REQ_FILTER} AND character != ''
       ORDER BY timestamp ASC LIMIT 1`
    ).bind(...bind).first<{ donor: string; character: string; timestamp: string }>(),

    db.prepare(
      `SELECT donor, character, COUNT(*) AS count FROM requests
       WHERE ${REQ_FILTER} AND character != '' AND source != 'manual' AND LOWER(donor) != LOWER(?1)
       GROUP BY LOWER(donor), character ORDER BY count DESC LIMIT 1`
    ).bind(...bind).first<{ donor: string; character: string; count: number }>(),

    // Money stats include ALL donation rows in range (even type='none' — the
    // donation happened regardless of whether it carried a request).
    db.prepare(
      `SELECT COUNT(*) AS donation_count, COALESCE(SUM(amount_val), 0) AS total_amount FROM requests
       WHERE room_id = ?1 AND deleted_at IS NULL AND timestamp >= ?2 AND timestamp < ?3
         AND source = 'donation' AND amount_val > 0`
    ).bind(...bind).first<{ donation_count: number; total_amount: number }>(),

    db.prepare(
      `SELECT donor, SUM(amount_val) AS total FROM requests
       WHERE room_id = ?1 AND deleted_at IS NULL AND timestamp >= ?2 AND timestamp < ?3
         AND source = 'donation' AND amount_val > 0
       GROUP BY LOWER(donor) ORDER BY total DESC LIMIT 5`
    ).bind(...bind).all<{ donor: string; total: number }>(),

    db.prepare(
      `SELECT donor, amount_val AS amount, character FROM requests
       WHERE room_id = ?1 AND deleted_at IS NULL AND timestamp >= ?2 AND timestamp < ?3
         AND source = 'donation' AND amount_val > 0
       ORDER BY amount_val DESC, timestamp ASC LIMIT 1`
    ).bind(...bind).first<{ donor: string; amount: number; character: string }>(),

    // Sample of real messages for the LLM (longest ones carry the most voice).
    db.prepare(
      `SELECT donor, message, character FROM requests
       WHERE ${REQ_FILTER} AND message != '' AND source != 'manual'
       ORDER BY LENGTH(message) DESC LIMIT 40`
    ).bind(...bind).all<{ donor: string; message: string; character: string }>(),

    // All distinct requester usernames — the LLM picks the funniest ones.
    db.prepare(
      `SELECT DISTINCT donor FROM requests
       WHERE ${REQ_FILTER} AND source != 'manual' AND LOWER(donor) != LOWER(?1)
       LIMIT 200`
    ).bind(...bind).all<{ donor: string }>(),
  ]);

  const sourceMap: Record<string, number> = {};
  for (const s of sources.results ?? []) sourceMap[s.source] = s.count;

  const stats: WrappedStats = {
    totalRequests: totals?.total ?? 0,
    doneRequests: totals?.done_count ?? 0,
    killerCount: totals?.killer_count ?? 0,
    survivorCount: totals?.survivor_count ?? 0,
    distinctCharacters: totals?.distinct_chars ?? 0,
    distinctRequesters: totals?.distinct_requesters ?? 0,
    topKillers: topKillers.results ?? [],
    topSurvivors: topSurvivors.results ?? [],
    topRequesters: topRequesters.results ?? [],
    monthly: monthly.results ?? [],
    busiestDay: busiestDay ?? null,
    sources: {
      donation: sourceMap.donation ?? 0,
      resub: sourceMap.resub ?? 0,
      chat: sourceMap.chat ?? 0,
      manual: sourceMap.manual ?? 0,
    },
    firstRequest: firstRequest ?? null,
    loyalFan: loyalFan && loyalFan.count >= 3 ? loyalFan : null,
  };

  const priv: WrappedPrivate = {
    totalAmount: Math.round((money?.total_amount ?? 0) * 100) / 100,
    donationCount: money?.donation_count ?? 0,
    topDonors: (topDonors.results ?? []).map((d) => ({ donor: d.donor, total: Math.round(d.total * 100) / 100 })),
    biggestDonation: biggestDonation ?? null,
  };

  const sampleMessages = (samples.results ?? []).map(
    (s) => `${s.donor}${s.character ? ` (pediu ${s.character})` : ''}: ${s.message.slice(0, 200)}`
  );

  return { stats, priv, sampleMessages, requesterNames: (requesterNames.results ?? []).map((r) => r.donor) };
}

function buildNarrativePrompt(
  language: WrappedLanguage,
  channelName: string,
  stats: WrappedStats,
  priv: WrappedPrivate,
  sampleMessages: string[],
  requesterNames: string[]
): string {
  if (language === 'en') {
    return `You write the "Wrapped" for Fila DBD — a Spotify-Wrapped-style recap for Dead by Daylight streamers on Twitch. The wrapped for channel "${channelName}" is a sequence of slides; you write the texts that make each slide personal, funny and emotional.

<stats>
${JSON.stringify(stats, null, 2)}
</stats>

<private_money>
Total raised in donations: R$ ${priv.totalAmount} across ${priv.donationCount} donations.
Biggest donation: ${priv.biggestDonation ? `R$ ${priv.biggestDonation.amount} from ${priv.biggestDonation.donor}` : 'none'}.
</private_money>

<real_messages>
${sampleMessages.join('\n')}
</real_messages>

<usernames>
${requesterNames.join(', ')}
</usernames>

Write in English, in a fun, affectionate and dramatic tone (DBD theme: the fog, the Entity, hooks, generators — don't overdo it). Use the REAL nicknames and slang the community uses in the messages above when they exist. Never invent numbers — only use the ones provided, and write large numbers with thousands separators (e.g. 1,361). Short sentences: each text fits a phone slide (max ~140 characters, titles max ~40).

Requests are characters the community asks the streamer to PLAY, so the killerCount vs survivorCount split defines the channel's identity: a killer-heavy split means "${channelName}" mostly plays killer (and vice versa). Write every text from that identity — never portray the streamer as the opposite side.

Return ONLY JSON:
- personaTitle: a "personality" title for the community/streamer based on the data (e.g. "The Huntress Nation", "Temple of Killer Terror"). Creative and specific to this channel.
- personaText: 1 sentence explaining the title.
- intro: 1 opening sentence for the wrapped, building anticipation.
- captions: a short, witty caption for each slide — totals (total requests), topKiller, topSurvivor, ratio (killer vs survivor split), requesters (who requested most), timeline (record month/day), money (donations — owner-only; do NOT cite amounts, comment on the community's support).
- funniestNames: 2 to 4 genuinely funny/creative usernames picked EXACTLY as they appear in <usernames> (puns, references, absurdities). For each, a short good-humored comment celebrating the name (never mocking the person). If no name is truly funny, return an empty array — don't force it.
- highlights: 2 to 3 highlights that only make sense FOR THIS CHANNEL — pick what's unusual in the data (a fan obsessed with one character, an explosive day, one request source dominating, a memorable real message from above, etc). Each with title and text; when the highlight is about a specific character, also include character with their exact OFFICIAL name (the first name from the stats list, e.g. "Hag") — omit character when there isn't one. No emojis in any text.
- superlative: a final yearbook-style superlative "award" (title + text), specific to this channel.`;
  }
  return `Você escreve a "Retrospectiva" do Fila DBD — um recap estilo Spotify Wrapped para streamers de Dead by Daylight na Twitch. A retrospectiva do canal "${channelName}" é uma sequência de slides; você escreve os textos que tornam cada slide pessoal, engraçado e emocionante.

<estatisticas>
${JSON.stringify(stats, null, 2)}
</estatisticas>

<financeiro_privado>
Total arrecadado em donates: R$ ${priv.totalAmount} em ${priv.donationCount} donates.
Maior donate: ${priv.biggestDonation ? `R$ ${priv.biggestDonation.amount} de ${priv.biggestDonation.donor}` : 'nenhum'}.
</financeiro_privado>

<mensagens_reais>
${sampleMessages.join('\n')}
</mensagens_reais>

<nomes_de_usuarios>
${requesterNames.join(', ')}
</nomes_de_usuarios>

Escreva em português brasileiro, tom divertido, carinhoso e dramático (tema DBD: neblina, a Entidade, ganchos, geradores — sem exagerar). Use os apelidos e gírias REAIS que a comunidade usa nas mensagens acima quando existirem (ex: "demogogo", "pigzinha"). Nunca invente números — use apenas os fornecidos, e escreva números grandes com separador de milhar (ex: 1.361). Frases curtas: cada texto cabe num slide de celular (máx ~140 caracteres, títulos máx ~40).

Os pedidos são personagens que a comunidade pede para o streamer JOGAR, então a proporção killerCount vs survivorCount define a identidade do canal: maioria killer significa que "${channelName}" joga principalmente de killer (e vice-versa). Escreva todos os textos a partir dessa identidade — nunca retrate o streamer como o lado oposto.

Retorne APENAS JSON:
- personaTitle: um título de "personalidade" para a comunidade/streamer baseado nos dados (ex: "A Nação da Huntress", "Templo do Terror dos Killers"). Criativo e específico deste canal.
- personaText: 1 frase explicando o título.
- intro: 1 frase de abertura da retrospectiva, criando expectativa.
- captions: legenda curta e espirituosa para cada slide — totals (total de pedidos), topKiller, topSurvivor, ratio (proporção killer vs survivor), requesters (quem mais pediu), timeline (mês/dia recorde), money (arrecadação — só o dono vê; NÃO cite valores, comente o apoio da comunidade).
- funniestNames: 2 a 4 nomes de usuário genuinamente engraçados/criativos escolhidos EXATAMENTE como aparecem em <nomes_de_usuarios> (trocadilhos, referências, absurdos). Para cada um, um comment curto e bem-humorado celebrando o nome (nunca zombando da pessoa). Se nenhum nome for realmente engraçado, retorne array vazio — não force.
- highlights: 2 a 3 destaques que só fazem sentido PARA ESTE CANAL — escolha o que os dados têm de incomum (um fã obcecado por um personagem, um dia explosivo, domínio de uma fonte de pedidos, uma mensagem marcante das reais acima, etc). Cada um com title e text; quando o destaque for sobre um personagem específico, inclua também character com o nome OFICIAL exato dele (o primeiro nome da lista de estatísticas, ex: "Hag") — omita character quando não houver um. Não use emojis em nenhum texto.
- superlative: um "prêmio" final no estilo superlativo de anuário (title + text), específico deste canal.`;
}

// One narrative attempt against one model. Returns the parsed narrative, or
// throws — { retriable: true } errors mean "same model may still work".
async function narrativeAttempt(
  model: string,
  prompt: string,
  requesterNames: string[],
  apiKey: string
): Promise<WrappedNarrative> {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          // Generous: 3.6-flash is a thinking model and its thought tokens
          // count toward this limit — too tight a cap truncates the JSON.
          maxOutputTokens: 8000,
          temperature: 1.0,
          responseMimeType: 'application/json',
          responseSchema: {
            type: 'object',
            properties: {
              personaTitle: { type: 'string' },
              personaText: { type: 'string' },
              intro: { type: 'string' },
              captions: {
                type: 'object',
                properties: {
                  totals: { type: 'string' },
                  topKiller: { type: 'string' },
                  topSurvivor: { type: 'string' },
                  ratio: { type: 'string' },
                  requesters: { type: 'string' },
                  timeline: { type: 'string' },
                  money: { type: 'string' },
                },
              },
              highlights: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    title: { type: 'string' },
                    text: { type: 'string' },
                    character: { type: 'string' },
                  },
                  required: ['title', 'text'],
                },
              },
              funniestNames: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    name: { type: 'string' },
                    comment: { type: 'string' },
                  },
                  required: ['name', 'comment'],
                },
              },
              superlative: {
                type: 'object',
                properties: { title: { type: 'string' }, text: { type: 'string' } },
                required: ['title', 'text'],
              },
            },
            required: ['personaTitle', 'personaText', 'intro', 'captions', 'highlights', 'funniestNames', 'superlative'],
          },
        },
      }),
    }
  );

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const msg = (err as any).error?.message || `HTTP ${res.status}`;
    throw Object.assign(new Error(`${model}: ${res.status} ${msg}`), {
      retriable: RETRIABLE_CODES.includes(res.status),
    });
  }

  const data = (await res.json()) as any;
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw Object.assign(new Error(`${model}: empty response`), { retriable: true });

  const parsed = JSON.parse(text) as WrappedNarrative; // throws → not retriable on this attempt
  // Cap highlights defensively — the UI renders each as its own slide.
  parsed.highlights = (parsed.highlights ?? []).slice(0, 3);
  // Only keep funniest-name picks that actually exist in the community (no
  // hallucinated names), matched case-insensitively against the real list.
  const known = new Map(requesterNames.map((n) => [n.toLowerCase(), n]));
  parsed.funniestNames = (parsed.funniestNames ?? [])
    .filter((f) => known.has(f.name?.toLowerCase?.()))
    .map((f) => ({ name: known.get(f.name.toLowerCase())!, comment: f.comment }))
    .slice(0, 4);
  return parsed;
}

export async function generateWrappedNarrative(
  channelName: string,
  stats: WrappedStats,
  priv: WrappedPrivate,
  sampleMessages: string[],
  requesterNames: string[],
  apiKey: string,
  language: WrappedLanguage = 'pt-BR'
): Promise<{ narrative: WrappedNarrative; model: string }> {
  const prompt = buildNarrativePrompt(language, channelName, stats, priv, sampleMessages, requesterNames);

  for (let attempt = 0; attempt < NARRATIVE_ATTEMPTS; attempt++) {
    try {
      const narrative = await narrativeAttempt(NARRATIVE_MODEL, prompt, requesterNames, apiKey);
      return { narrative, model: NARRATIVE_MODEL };
    } catch (e: any) {
      console.warn(`[wrapped] Narrative attempt failed (${NARRATIVE_MODEL}, attempt ${attempt + 1}): ${e?.message ?? e}`);
      const hasRetry = attempt < NARRATIVE_ATTEMPTS - 1 && (e?.retriable || e?.name === 'TimeoutError');
      if (hasRetry) await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    }
  }

  console.error('[wrapped] Narrative generation failed');
  throw new NarrativeError();
}
