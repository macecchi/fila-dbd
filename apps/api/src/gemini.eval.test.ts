// Live LLM evals for the Gemini character extractor.
//
// These tests hit the real Gemini API and verify that the prompt + model
// combination correctly identifies characters in real-world donation messages.
//
// Skipped by default. To run:
//
//   RUN_EVALS=1 GEMINI_API_KEY=... bun run --filter @filadbd/api test -- gemini.eval
//   # or, with the env var already set in apps/api/.env:
//   RUN_EVALS=1 bun run --filter @filadbd/api test -- gemini.eval
//
// Scenarios were sampled and lightly anonymized from real production donation
// messages on the @mandymess channel. Streamer-specific terms have been replaced
// with the generic placeholder "{{streamer}}"; bystander names have been replaced
// with fictitious initials. The semantic structure that the LLM must reason about
// (nicknames, quantifiers, long context, embedded requests) is preserved verbatim.
//
// Pass criterion: multiset equality — the array of returned character names must
// match `expected` regardless of order. This tolerates LLM variation in which
// character is listed first while still catching missed or fabricated entries.

import { describe, it, expect } from 'vitest';
import { extractCharacters } from './gemini';

// `process` isn't in the worker tsconfig lib but is available at runtime
// because vitest runs this file in a Node environment.
declare const process: { env: Record<string, string | undefined> };

const RUN_EVALS = !!process.env.RUN_EVALS;

interface EvalCase {
  name: string;
  message: string;
  maxCount: number;
  expected: string[]; // character names; empty = LLM should return no characters
}

// ──────────────────────────────────────────────────────────────────────────────
// Single-character scenarios
// ──────────────────────────────────────────────────────────────────────────────
const singleCases: EvalCase[] = [
  {
    name: 'single / nickname: Drácula → Dark Lord',
    message: 'Boa noite lindeza, tudo bem? Joga de Drácula, se puder, menor que três',
    maxCount: 1,
    expected: ['Dark Lord'],
  },
  {
    name: 'single / nickname: draga → Dredge',
    message: 'amiga, será q rola uma draga mais tarde?',
    maxCount: 1,
    expected: ['Dredge'],
  },
  {
    name: 'single / nickname: pirâmide → Pyramid Head',
    message: 'Oi {{streamer}}, tudo bom? Passando pra dar boa noite, pedi um pirâmide, tá bom? Beijo, boa live.',
    maxCount: 1,
    expected: ['Pyramid Head'],
  },
  {
    name: 'single / nickname: Sadako do Olhão → Onryō',
    message: '{{streamer}}, joga uma de Sadako do Olhão pra gente.',
    maxCount: 1,
    expected: ['Onryō'],
  },
  {
    name: 'single / nickname: kanekizinho → Ghoul',
    message: '{{streamer}} {{streamer}}nha poderia dar uma jogadinha do kanekizinho com buildzinha de velocidadezinha',
    maxCount: 1,
    expected: ['Ghoul'],
  },
  {
    name: 'single / nickname: huntrex → Huntress',
    message: 'Vamos barbarizar uma de huntrex',
    maxCount: 1,
    expected: ['Huntress'],
  },
  {
    name: 'single / nickname: Espectro → Wraith',
    message: 'Boa noite {{streamer}}, joga de Espectro com a nova skin do passe quando vc liberar ela <3 te amo',
    maxCount: 1,
    expected: ['Wraith'],
  },
  {
    name: 'single / nickname: wesker → Mastermind',
    message: 'Boa noite, ta bem? Ta aceitando pedido? Se tiver joga de wesker por favor. E eu nao dei sub pq esta bufado, nao está indo nem pelo site.',
    maxCount: 1,
    expected: ['Mastermind'],
  },
  {
    name: 'single / nickname: Myers → Shape (only Myers mentioned)',
    message: 'Boa noite! Vai uma Myers por favor. Um beijo!',
    maxCount: 1,
    expected: ['Shape'],
  },
  {
    name: 'single / nickname: trick trick trans → Trickster',
    message: '{{streamer}}, o que você tem a falar sobre a situação atual da R.? Vocês jogavam juntas e acho que eram amigas.. você está ajudando ela ou sabe se tem algum apoio? Joga de Trick trick trans',
    maxCount: 1,
    expected: ['Trickster'],
  },
  {
    name: 'single / nickname: Vecna novo → The First (Stranger Things crossover)',
    message: 'Oi {{streamer}}, passando pra dizer que adoro você, joga de Vecna novo',
    maxCount: 1,
    expected: ['The First'],
  },
  {
    name: 'single / nickname: Vecna do D&D → Lich (original D&D Vecna)',
    message: 'Vai uma de Vecna do D e D por favor',
    maxCount: 1,
    expected: ['Lich'],
  },
  {
    name: 'single / nickname: Adriana → Skull Merchant',
    message: 'Te amo irma, um beijo de Londres <3 Joga de Adriana! Minha rainha destruida.',
    maxCount: 1,
    expected: ['Skull Merchant'],
  },
  {
    name: 'single / nickname: Alien → Xenomorph',
    message: 'Bora de Alien, com a mais babadeira do DBD.',
    maxCount: 1,
    expected: ['Xenomorph'],
  },
  {
    name: 'single / long context, request at end: Oni',
    message: 'Bate bola jogo rápido! Um tom pantone? Uma marca de roupa? Um champion do Lol AD? Um surv? E um killer? ERRADO!!! JOGA DE Oni',
    maxCount: 1,
    expected: ['Oni'],
  },
  {
    name: 'single / embedded request among noise: Hag',
    message: 'Oi {{streamer}}, joga uma de hag com a skin de madame frost com uma Build de frankilin para acabar com esses achismo na área dos geladinhos. Pense gelado, pense hag!',
    maxCount: 1,
    expected: ['Hag'],
  },
  {
    name: 'single / request despite another character name in noise: Trickster (krasue is current killer reference, not request)',
    message: 'joga 1 trickster então pra despedir do muso tapete da krasue.',
    maxCount: 1,
    expected: ['Trickster'],
  },
  {
    name: 'single / Krasue nickname: kraseu → Krasue',
    message: 'puxa uma kraseu pa tropa, lindão. lethal, dissolution, bambas e bbq. cabeça de galinha e olho de porco de addon pro churras. amo vc tmj',
    maxCount: 1,
    expected: ['Krasue'],
  },
];

// ──────────────────────────────────────────────────────────────────────────────
// Scenarios that should produce zero characters (no actual play request)
// ──────────────────────────────────────────────────────────────────────────────
const noneCases: EvalCase[] = [
  {
    name: 'none / personal venting, no request',
    message: '{{streamer}}, boa noite. desabafo leve. to ansioso hoje porque amanhã começa uma jornada nova na minha vida. vou pra sp fazer minha especialização e trabalhar pesado ao mesmo tempo. sei que vou dar conta mas ao mesmo tempo dá uma ansiedade maluca e um medo',
    maxCount: 1,
    expected: [],
  },
  {
    name: 'none / movie request, not DBD',
    message: 'Boa noite, posso te fazer uma proposta? Queria muito te ver assistindo O Diabo Veste Prada, tô muito ansioso pro 2',
    maxCount: 2,
    expected: [],
  },
  {
    name: 'none / birthday greeting',
    message: 'Quem é o aniversariante mais lindo, mais maravilhoso e cheio de carisma do dia? Te amo meu amor, espero que vc tenha um novo ciclo cheio de amor, sucesso e muitas conquistas.',
    maxCount: 1,
    expected: [],
  },
  {
    name: 'none / shoutout, no character',
    message: 'BORA BARBARIZAR',
    maxCount: 1,
    expected: [],
  },
  // Regression watch (real prod false positives on @mandymess): the extractor
  // fabricated characters for donations that contained no character request.
  // These guard against the model's bias toward always producing a character.
  {
    // Asking the streamer to play the KILLER SIDE generically ("we want you as
    // killer") — no specific killer named. Used to fabricate "Pig".
    name: 'none / false positive: generic "de killer" role, no character named',
    message: 'queremos a {{streamer}} de killer! DEGLADIA',
    maxCount: 1,
    expected: [],
  },
  {
    // Vague affectionate donation, zero character reference. Used to fabricate
    // "Mastermind".
    name: 'none / false positive: vague non-request donation (number + nickname)',
    message: 'Quase 30 {{streamer}}',
    maxCount: 1,
    expected: [],
  },
  {
    // Short question to the streamer, no character. Used to fabricate "Hag".
    name: 'none / false positive: short question, no character',
    message: 'Quanto tempo madre',
    maxCount: 1,
    expected: [],
  },
  {
    // Wishlist for a FUTURE DBD chapter/DLC (a non-DBD character, Dimitrescu,
    // "as killer"). Not a request to play now. Used to emit an unknown entry.
    name: 'none / false positive: wish for future DLC chapter, not a play request',
    message: '{{streamer}} avisa que queremos mais um cap de resident evil, com a dimetreCu e suas filhas como killer',
    maxCount: 1,
    expected: [],
  },
];

// ──────────────────────────────────────────────────────────────────────────────
// Multi-character scenarios (the new feature)
// ──────────────────────────────────────────────────────────────────────────────
const multiCases: EvalCase[] = [
  {
    name: 'multi / "uma de X e uma de Y" (real prod msg)',
    message: 'Oi {{streamer}}, joga uma de pig e uma de hag. Obrigado',
    maxCount: 2,
    expected: ['Pig', 'Hag'],
  },
  {
    name: 'multi / quantifier "duas de" → 2 of same character',
    message: 'Oiii {{streamer}}! Cê tá maravilhosa, como sempre. Hoje assisti uma gameplay de Detroit e achei tudo. Joga duas de Chucky, por favor!',
    maxCount: 2,
    expected: ['Good Guy', 'Good Guy'],
  },
  {
    name: 'multi / quantifier "3" → 3 of same character',
    message: 'joga 3 trickster então pra fechar a noite, beijos',
    maxCount: 3,
    expected: ['Trickster', 'Trickster', 'Trickster'],
  },
  {
    name: 'multi / two distinct nicknames: Adriana + Alien',
    message: 'Boa noite {{streamer}}, tá pedindo uma Adriana e um Alien de musas.',
    maxCount: 2,
    expected: ['Skull Merchant', 'Xenomorph'],
  },
  {
    name: 'multi / two distinct nicknames in long message: Ghost Face + Singularity',
    message: 'Boa noite minha ancestral, minha tuntancamon, minha mao ze dong, minha Hamurabi, joga uma de Ghost face e uma de singularidade, beijos',
    maxCount: 2,
    expected: ['Ghost Face', 'Singularity'],
  },
  {
    name: 'multi / "vecna novo" + "dracula" (both nicknames map to different chars)',
    message: 'pois joga uma de vecna novo e uma de dracula',
    maxCount: 2,
    expected: ['The First', 'Dark Lord'],
  },
  {
    name: 'multi / "vecna antigo" + singularidade',
    message: 'Agora joga com killers que nos vestem: maceta uma singularidade e um vecna antigo, beijos',
    maxCount: 2,
    expected: ['Singularity', 'Lich'],
  },
  {
    name: 'multi / Vecna + Myers (real prod msg, paid 10 with min 5)',
    message: 'Boa noite mamis! Vai uma de Vecna do D e D que meu maridinho pediu e uma Myers por favor. Um beijo!',
    maxCount: 2,
    expected: ['Lich', 'Shape'],
  },
  {
    name: 'multi / quantifier + extra: "2 de trapper e 1 de nurse"',
    message: 'oie {{streamer}}, joga 2 de trapper e 1 de nurse por favor',
    maxCount: 3,
    expected: ['Trapper', 'Trapper', 'Nurse'],
  },
  {
    name: 'multi / cap enforcement: user requests 3 but maxCount=2 → first 2',
    message: 'joga uma de pig, uma de hag e uma de nurse',
    maxCount: 2,
    expected: ['Pig', 'Hag'],
  },
  {
    name: 'multi / under-asks vs entitlement: user requests 1 but maxCount=3',
    message: 'pode jogar uma de Spirit por favor',
    maxCount: 3,
    expected: ['Spirit'],
  },
  {
    // Regression watch: the LLM used to return ['Krasue', 'Trickster'] here —
    // it missed the "3" quantifier and treated the contextual "krasue"
    // reference (the current killer the user is saying goodbye to) as a
    // separate request. Fixed by reframing the prompt around the user's
    // command/intent and excluding context-only mentions.
    name: 'multi / current-killer reference is NOT a request: "tapete da krasue" + "joga 3 trickster"',
    message: 'joga 3 trickster então pra despedir do muso tapete da krasue.',
    maxCount: 3,
    expected: ['Trickster', 'Trickster', 'Trickster'],
  },
];

const allCases = [...singleCases, ...noneCases, ...multiCases];

function multisetSorted(arr: string[]): string[] {
  return [...arr].sort();
}

describe.concurrent('Gemini extractCharacters — live LLM evals', () => {
  it.skipIf(!RUN_EVALS).concurrent.each(allCases)('$name', async ({ message, maxCount, expected }) => {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error('Set GEMINI_API_KEY (e.g. in apps/api/.env or .dev.vars) to run evals');
    }

    const result = await extractCharacters(message, apiKey, maxCount);
    const names = result.map((r) => r.character);

    // Multiset comparison: order doesn't matter, duplicates do.
    expect(multisetSorted(names)).toEqual(multisetSorted(expected));
  }, 30_000);
});

// ──────────────────────────────────────────────────────────────────────────────
// Build extraction evals
// These cases verify that when extras=['build'] is passed the LLM correctly
// extracts build descriptions and attaches them to the right characters.
// Assertions are structural (non-empty, substring containment) to tolerate
// LLM variation in exact phrasing.
// ──────────────────────────────────────────────────────────────────────────────
describe.concurrent('Gemini extractCharacters — build extraction evals', () => {
  it.skipIf(!RUN_EVALS)('fully specified killer build (Krasue)', async () => {
    const message = 'puxa uma kraseu pa tropa, lindão. lethal, dissolution, bambas e bbq. cabeça de galinha e olho de porco de addon pro churras. amo vc tmj';
    const apiKey = process.env.GEMINI_API_KEY!;
    const result = await extractCharacters(message, apiKey, 3, ['build']);

    expect(result).toHaveLength(1);
    expect(result[0].character).toBe('Krasue');

    const build = result[0].build;
    expect(build?.text).toBeTruthy();
    expect((build?.matchedTerms ?? []).length).toBeGreaterThanOrEqual(1);

    for (const term of build?.matchedTerms ?? []) {
      expect(message.toLowerCase()).toContain(term.toLowerCase());
    }
  }, 30_000);

  it.skipIf(!RUN_EVALS)('survivor build (Jill Valentine + perk list)', async () => {
    const message = 'Mainha estou pedindo a buildas de surv. Perk se totem da jill valentine Perk sensorial da eleven Perk de cura da Nancy Perk da hady kour';
    const apiKey = process.env.GEMINI_API_KEY!;
    const result = await extractCharacters(message, apiKey, 4, ['build']);

    expect(result.length).toBeGreaterThanOrEqual(1);
    const withBuild = result.filter(r => r.build?.text);
    expect(withBuild.length).toBeGreaterThanOrEqual(1);
  }, 30_000);

  it.skipIf(!RUN_EVALS)('themed build (Doctor de build irritante)', async () => {
    const message = 'Doctor de build irritante';
    const apiKey = process.env.GEMINI_API_KEY!;
    const result = await extractCharacters(message, apiKey, 1, ['build']);

    expect(result).toHaveLength(1);
    expect(result[0].character).toBe('Doctor');
    expect(result[0].build?.text.toLowerCase()).toContain('irritante');
  }, 30_000);

  it.skipIf(!RUN_EVALS)('quantified multi-char same build (3 Trickster with build)', async () => {
    const message = '3 trickster de build de aura';
    const apiKey = process.env.GEMINI_API_KEY!;
    const result = await extractCharacters(message, apiKey, 5, ['build']);

    expect(result).toHaveLength(3);
    for (const r of result) {
      expect(r.character).toBe('Trickster');
      expect(r.build?.text).toBeTruthy();
    }
  }, 30_000);

  it.skipIf(!RUN_EVALS)('different builds per character (Pig aura, Hag gritos)', async () => {
    const message = 'Pig de aura e Hag de gritos';
    const apiKey = process.env.GEMINI_API_KEY!;
    const result = await extractCharacters(message, apiKey, 2, ['build']);

    expect(result).toHaveLength(2);

    const pig = result.find(r => r.character === 'Pig');
    const hag = result.find(r => r.character === 'Hag');
    expect(pig).toBeDefined();
    expect(hag).toBeDefined();
    expect(pig?.build?.text.toLowerCase()).toContain('aura');
    expect(hag?.build?.text.toLowerCase()).toContain('grito');
  }, 30_000);

  it.skipIf(!RUN_EVALS)('no-perk build (Hag sem perks)', async () => {
    const message = 'hag sem perks';
    const apiKey = process.env.GEMINI_API_KEY!;
    const result = await extractCharacters(message, apiKey, 1, ['build']);

    expect(result).toHaveLength(1);
    expect(result[0].character).toBe('Hag');
    expect(result[0].build?.text.toLowerCase()).toContain('sem perks');
  }, 30_000);

  // Donor mentions "perks" contextually (asking a question) but is not actually
  // requesting a build. Real production case: "as perks originais dos killers
  // tem alguma sinergia… joga de nurse". The character is the request; nothing
  // about Nurse's loadout is being asked for.
  it.skipIf(!RUN_EVALS)('false positive: "perks" mentioned contextually but no build requested', async () => {
    const message = 'Mandy, as perks originais dos killers tem alguma sinergia com os poderes únicos deles? Fico pensando nisso as vezes, joga de nurse!';
    const apiKey = process.env.GEMINI_API_KEY!;
    const result = await extractCharacters(message, apiKey, 2, ['build']);

    expect(result).toHaveLength(1);
    expect(result[0].character).toBe('Nurse');
    // No actual build was requested — the word "perks" appears in a meta-question,
    // not as a loadout instruction.
    expect(result[0].build).toBeUndefined();
  }, 30_000);

  // Addon-only build with a perk borrowed from another killer. Real production:
  // "wraith com o addon marrom de sair do poder quando chutar um gerador junto
  // da perk do vecnussy de chutar gerador via bluetooth". Build text should
  // mention the addon and the perk even without naming them canonically.
  it.skipIf(!RUN_EVALS)('addons + slang perk reference (Wraith)', async () => {
    const message = 'joga de wraith com o addon marrom de sair do poder quando chutar um gerador junto da perk do vecnussy de chutar gerador via bluetooth';
    const apiKey = process.env.GEMINI_API_KEY!;
    const result = await extractCharacters(message, apiKey, 2, ['build']);

    expect(result).toHaveLength(1);
    expect(result[0].character).toBe('Wraith');
    expect(result[0].build?.text).toBeTruthy();
    // The build mentions both an addon and a perk-by-effect; the text should
    // reflect at least one of them.
    const text = result[0].build!.text.toLowerCase();
    expect(text.includes('addon') || text.includes('chutar') || text.includes('gerador')).toBe(true);
  }, 30_000);

  // Shared build across two explicitly named characters (not via quantifier).
  // Real production-style: "Pig e Hag de build de aura". Both characters get
  // the same build text.
  it.skipIf(!RUN_EVALS)('shared build across two named characters (Pig e Hag de aura)', async () => {
    const message = 'Pig e Hag de build de aura';
    const apiKey = process.env.GEMINI_API_KEY!;
    const result = await extractCharacters(message, apiKey, 3, ['build']);

    expect(result).toHaveLength(2);
    const pig = result.find(r => r.character === 'Pig');
    const hag = result.find(r => r.character === 'Hag');
    expect(pig?.build?.text.toLowerCase()).toContain('aura');
    expect(hag?.build?.text.toLowerCase()).toContain('aura');
  }, 30_000);

  // Build mentioned with the streamer's "favorite build" — themed reference
  // without specifics. Real production: "Mandy barbariza com um Drácula com
  // sua build favorita e a skin mais bafo".
  it.skipIf(!RUN_EVALS)('themed reference to streamer\'s own build (favorita)', async () => {
    const message = 'Mandy barbariza com um Drácula com sua build favorita e a skin mais bafo';
    const apiKey = process.env.GEMINI_API_KEY!;
    const result = await extractCharacters(message, apiKey, 1, ['build']);

    expect(result).toHaveLength(1);
    expect(result[0].character).toBe('Dark Lord');
    expect(result[0].build?.text.toLowerCase()).toContain('favorita');
  }, 30_000);
});
