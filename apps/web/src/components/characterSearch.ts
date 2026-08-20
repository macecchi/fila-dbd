import { CHARACTERS } from '../data/characters';

export interface CharacterOption {
  name: string;
  type: 'killer' | 'survivor';
  portrait?: string;
  aliases: string[];
}

export function getAllCharacterNames(): CharacterOption[] {
  const names: CharacterOption[] = [];
  for (const char of CHARACTERS.killers) {
    names.push({ name: char.name, type: 'killer', portrait: char.portrait, aliases: char.aliases });
  }
  for (const char of CHARACTERS.survivors) {
    names.push({ name: char.name, type: 'survivor', aliases: char.aliases });
  }
  return names;
}

export function matchesSearch(char: CharacterOption, query: string): boolean {
  if (char.name.toLowerCase().includes(query)) return true;
  return char.aliases.some(a => a.toLowerCase().includes(query));
}

// Killers first — same bias as the manual-entry autocomplete.
export function searchCharacters(all: CharacterOption[], query: string, limit = 8): CharacterOption[] {
  return all
    .filter(c => matchesSearch(c, query))
    .sort((a, b) => {
      if (a.type === 'killer' && b.type !== 'killer') return -1;
      if (a.type !== 'killer' && b.type === 'killer') return 1;
      return 0;
    })
    .slice(0, limit);
}
