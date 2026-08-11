import type { CharacterData } from './types';

export const CHARACTERS: CharacterData = {
    survivors: [
        { name: "Dwight Fairfield", aliases: [] },
        { name: "Meg Thomas", aliases: [] },
        { name: "Claudette Morel", aliases: [] },
        { name: "Jake Park", aliases: [] },
        { name: "Nea Karlsson", aliases: [] },
        { name: "Laurie Strode", aliases: [] },
        { name: "Ace Visconti", aliases: [] },
        { name: "William Bill Overbeck", aliases: ["Velho"] },
        { name: "Feng Min", aliases: [] },
        { name: "David King", aliases: [] },
        { name: "Quentin Smith", aliases: [] },
        { name: "David Tapp", aliases: [] },
        { name: "Kate Denson", aliases: [] },
        { name: "Adam Francis", aliases: [] },
        { name: "Jeff Johansen", aliases: [] },
        { name: "Jane Romero", aliases: [] },
        { name: "Ash Williams", aliases: [] },
        { name: "Nancy Wheeler", aliases: [] },
        { name: "Steve Harrington", aliases: [] },
        { name: "Yui Kimura", aliases: [] },
        { name: "Zarina Kassir", aliases: [] },
        { name: "Cheryl Mason", aliases: [] },
        { name: "Felix Richter", aliases: [] },
        { name: "Élodie Rakoto", aliases: [] },
        { name: "Yun-Jin Lee", aliases: [] },
        { name: "Jill Valentine", aliases: [] },
        { name: "Leon S. Kennedy", aliases: [] },
        { name: "Mikaela Reid", aliases: [] },
        { name: "Jonah Vasquez", aliases: [] },
        { name: "Yoichi Asakawa", aliases: [] },
        { name: "Haddie Kaur", aliases: [] },
        { name: "Ada Wong", aliases: [] },
        { name: "Rebecca Chambers", aliases: [] },
        { name: "Vittorio Toscano", aliases: [] },
        { name: "Thalita Lyra", aliases: [] },
        { name: "Renato Lyra", aliases: [] },
        { name: "Gabriel Soma", aliases: [] },
        { name: "Nicolas Cage", aliases: [] },
        { name: "Ellen Ripley", aliases: [] },
        { name: "Alan Wake", aliases: [] },
        { name: "Sable Ward", aliases: [] },
        { name: "Aestri Yazar", aliases: ["Baermar Uraz"] },
        { name: "Lara Croft", aliases: [] },
        { name: "Trevor Belmont", aliases: [] },
        { name: "Taurie Cain", aliases: [] },
        { name: "Orela Rose", aliases: [] },
        { name: "Rick Grimes", aliases: [] },
        { name: "Michonne Grimes", aliases: [] },
        { name: "Vee Boonyasak", aliases: [] },
        { name: "Dustin Henderson", aliases: [] },
        { name: "Eleven", aliases: ["Jane Hopper", "Onze"] },
        { name: "Kwon Tae-young", aliases: [] },
        { name: "Shane Wiigwaas", aliases: [] },
        { name: "Aurora Stardotter", aliases: [] },
    ],
    killers: [
        { name: "Trapper", aliases: ["Caçador"], portrait: "/images/portraits/K01_TheTrapper.webp" },
        { name: "Wraith", aliases: ["Espectro"], portrait: "/images/portraits/K02_TheWraith.webp" },
        { name: "Hillbilly", aliases: ["Billy", "Caipira"], portrait: "/images/portraits/K03_TheHillbilly.webp" },
        { name: "Nurse", aliases: ["Enfermeira"], portrait: "/images/portraits/K04_TheNurse.webp" },
        { name: "Shape", aliases: ["Michael Myers", "Myers"], portrait: "/images/portraits/K05_TheShape.webp" },
        { name: "Hag", aliases: ["Bruxa"], portrait: "/images/portraits/K06_TheHag.webp" },
        { name: "Doctor", aliases: ["Médico"], portrait: "/images/portraits/K07_TheDoctor.webp" },
        { name: "Huntress", aliases: ["Caçadora"], portrait: "/images/portraits/K08_TheHuntress.webp" },
        { name: "Cannibal", aliases: ["Bubba", "Leatherface", "Canibal"], portrait: "/images/portraits/K09_TheCannibal.webp" },
        { name: "Nightmare", aliases: ["Freddy", "Pesadelo"], portrait: "/images/portraits/K10_TheNightmare.webp" },
        { name: "Pig", aliases: ["Porca"], portrait: "/images/portraits/K11_ThePig.webp" },
        { name: "Clown", aliases: ["Palhaço"], portrait: "/images/portraits/K12_TheClown.webp" },
        { name: "Spirit", aliases: ["Espírito"], portrait: "/images/portraits/K13_TheSpirit.webp" },
        { name: "Legion", aliases: ["Legião"], portrait: "/images/portraits/K14_TheLegion.webp" },
        { name: "Plague", aliases: ["Praga"], portrait: "/images/portraits/K15_ThePlague.webp" },
        { name: "Ghost Face", aliases: ["ghostface"], portrait: "/images/portraits/K16_TheGhostFace.webp" },
        { name: "Demogorgon", aliases: ["Demo"], portrait: "/images/portraits/K17_TheDemogorgon.webp" },
        { name: "Oni", aliases: [], portrait: "/images/portraits/K18_TheOni.webp" },
        { name: "Deathslinger", aliases: ["Pistoleiro"], portrait: "/images/portraits/K19_TheDeathslinger.webp" },
        { name: "Pyramid Head", aliases: ["Executioner", "Pirâmide", "O Carrasco"], portrait: "/images/portraits/K20_TheExecutioner.webp" },
        { name: "Blight", aliases: ["Ferrugem"], portrait: "/images/portraits/K21_TheBlight.webp" },
        { name: "Twins", aliases: ["Gêmeos"], portrait: "/images/portraits/K22_TheTwins.webp" },
        { name: "Trickster", aliases: ["Trapaceiro", "MiNA", "Souichi Tsujii"], portrait: "/images/portraits/K23_TheTrickster.webp" },
        { name: "Nemesis", aliases: [], portrait: "/images/portraits/K24_TheNemesis.webp" },
        { name: "Cenobite", aliases: ["Cenobita", "Pinhead"], portrait: "/images/portraits/K25_TheCenobite.webp" },
        { name: "Artist", aliases: ["Artista"], portrait: "/images/portraits/K26_TheArtist.webp" },
        { name: "Onryō", aliases: ["Sadako", "Samara"], portrait: "/images/portraits/K27_TheOnryo.webp" },
        { name: "Dredge", aliases: ["Draga"], portrait: "/images/portraits/K28_TheDredge.webp" },
        { name: "Mastermind", aliases: ["Wesker", "Mentor"], portrait: "/images/portraits/K29_TheMastermind.webp" },
        { name: "Knight", aliases: ["Cavaleiro"], portrait: "/images/portraits/K30_TheKnight.webp" },
        { name: "Skull Merchant", aliases: ["Adriana", "A Mercadora de Crânios"], portrait: "/images/portraits/K31_TheSkullMerchant.webp" },
        { name: "Singularity", aliases: ["Singularidade"], portrait: "/images/portraits/K32_TheSingularity.webp" },
        { name: "Xenomorph", aliases: ["Alien", "Xenomorfo"], portrait: "/images/portraits/K33_TheXenomorph.webp" },
        { name: "Good Guy", aliases: ["Chucky", "Boneco Assassino", "Tiffany"], portrait: "/images/portraits/K34_TheGoodGuy.webp" },
        { name: "Unknown", aliases: ["Desconhecido", "Cido", "Taylor"], portrait: "/images/portraits/K35_TheUnknown.webp" },
        { name: "Lich", aliases: ["Vecna", "Vecna D&D"], portrait: "/images/portraits/K36_TheLich.webp" },
        { name: "Dark Lord", aliases: ["Dracula", "O Lorde das Trevas"], portrait: "/images/portraits/K37_TheDarkLord.webp" },
        { name: "Houndmaster", aliases: ["Mestra dos Cães"], portrait: "/images/portraits/K38_TheHoundmaster.webp" },
        { name: "Ghoul", aliases: ["Kaneki", "Carniçal"], portrait: "/images/portraits/K39_TheGhoul.webp" },
        { name: "Animatronic", aliases: ["Freddy Fazbear", "FNAF", "Animatrônico", "Springtrap"], portrait: "/images/portraits/K40_TheAnimatronic.webp" },
        { name: "Krasue", aliases: ["Senhora Linguiça"], portrait: "/images/portraits/K41_TheKrasue.webp" },
        { name: "The First", aliases: ["First", "Vecna", "Vecna Stranger Things", "Vecna Novo", "One", "Número Um", "Henry Creel"], portrait: "/images/portraits/K42_TheFirst.webp" },
        { name: "Slasher", aliases: ["Jason", "Jason Voorhees", "Voorhees", "Sexta-feira 13", "Friday the 13th"], portrait: "/images/portraits/K43_TheSlasher.webp" },
        { name: "Judgment", aliases: ["Judgement", "Julgamento"], portrait: "/images/portraits/K44_TheJudgment.webp" },
    ]
};

export const DEFAULT_CHARACTERS = {
    survivors: CHARACTERS.survivors.map(c => [c.name, ...c.aliases].join('/')),
    killers: CHARACTERS.killers.map(c => [c.name, ...c.aliases].join('/'))
};

export function getKillerPortrait(name: string): string | undefined {
    return CHARACTERS.killers.find(k => k.name === name)?.portrait || CHARACTERS.killers.find(k => k.aliases.includes(name))?.portrait;
}

const GENERIC_SURVIVOR_PATTERNS = [
    /\b(?:jog[aue]|uma?)\s+(?:de\s+)?surv(?:ivor)?(?:zinho|zinha)?\b/i,
    /\b(?:de\s+)?surv(?:ivor)?(?:zinho|zinha)?\b/i,
    /\bsobrevivente\b/i,
];

export type LocalMatchResult = { character: string; type: 'killer' | 'survivor'; ambiguous?: boolean; matchedTerm?: string };

export function tryLocalMatch(message: string): LocalMatchResult | null {
    const lower = message.toLowerCase();
    const matches: { character: string; type: 'killer' | 'survivor'; position: number; matchedTerm: string }[] = [];

    for (const type of ['killers', 'survivors'] as const) {
        for (const char of CHARACTERS[type]) {
            for (const name of [char.name, ...char.aliases]) {
                const regex = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
                let match;
                while ((match = regex.exec(lower)) !== null) {
                    matches.push({
                        character: char.name,
                        type: type === 'killers' ? 'killer' : 'survivor',
                        position: match.index,
                        matchedTerm: message.substring(match.index, match.index + match[0].length)
                    });
                }
            }
        }
    }

    if (matches.length === 0) {
        for (const pattern of GENERIC_SURVIVOR_PATTERNS) {
            const m = pattern.exec(lower);
            if (m) {
                return { character: 'Survivor', type: 'survivor', matchedTerm: message.substring(m.index, m.index + m[0].length) };
            }
        }
        return null;
    }

    // Drop matches fully covered by a longer overlapping match, so multi-word
    // aliases like "Vecna Novo" win over the substring "Vecna".
    const filtered = matches.filter(m => {
        const end = m.position + m.matchedTerm.length;
        return !matches.some(other =>
            other !== m &&
            other.matchedTerm.length > m.matchedTerm.length &&
            other.position <= m.position &&
            other.position + other.matchedTerm.length >= end
        );
    });

    const uniqueChars = new Set(filtered.map(m => m.character));
    const lastMatch = filtered.reduce((a, b) => b.position > a.position ? b : a);

    return {
        character: lastMatch.character,
        type: lastMatch.type,
        ambiguous: uniqueChars.size > 1,
        matchedTerm: lastMatch.matchedTerm
    };
}

// True when the local match is a single unambiguous character whose matched term
// is the entire message (e.g. "Trapper"). In that case there's nothing else for the
// LLM to parse — no build text, no extra characters — so the local result is final.
export function isWholeMessageMatch(local: LocalMatchResult | null, message: string): boolean {
    return !!local && !local.ambiguous && !!local.matchedTerm &&
        local.matchedTerm.trim().toLowerCase() === message.trim().toLowerCase();
}
