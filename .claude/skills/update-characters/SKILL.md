---
name: update-characters
description: Check the Dead by Daylight wiki for new playable characters (released or on the PTB) and add any missing ones to the character base, including killer portraits. Use when asked to update/sync the character database or check for new DBD characters.
---

# Update DBD character base from the wiki

Adds newly announced Dead by Daylight characters to `packages/shared/src/characters.ts` (the single source of truth; `apps/web/src/data/characters.ts` just re-exports it).

## 1. Find new characters

1. Fetch https://deadbydaylight.wiki.gg/wiki/Characters (the official wiki; ignore fandom.com mirrors) and list all killers and survivors. Also check https://deadbydaylight.wiki.gg/wiki/Chapters for recent/upcoming chapters.
2. **Only include characters that are playable**: released, or currently on the PTB (Player Test Build). Skip characters that are merely announced/teased — viewers can't request to play what doesn't exist yet, and announced details (names, titles, portraits) often change before release. A chapter's wiki page states its release date and PTB status; when in doubt, treat a character with no PTB date and a release date more than ~3 weeks away as announced-only and skip it.
3. Compare the playable set against the `CHARACTERS` object in `packages/shared/src/characters.ts`. Note the naming convention: killer names drop the "The" prefix (`Trapper`, `Slasher`) unless the bare name would be too generic to match safely (`The First`).
4. If nothing is missing, stop and report "character base is up to date".

## 2. Add entries

For each new character, follow the existing entry style:

- **Killers**: `{ name, aliases, portrait }`. Aliases should include: the official PT-BR localized name (the userbase is Brazilian — check the wiki or use the obvious translation, e.g. Judgment → "Julgamento"), common community nicknames, licensed-character real names (e.g. "Jason Voorhees"), and frequent misspellings (e.g. "Judgement"). Avoid aliases that are everyday words in English or Portuguese chat (e.g. "Art", "Campeão") — matching is word-boundary based and such aliases cause false positives on ordinary messages.
- **Survivors**: `{ name, aliases }`. Aliases are usually empty for originals; add well-known alternate names for licensed characters (e.g. Eleven → "Jane Hopper").
- Append at the end of the respective array, preserving release order.

## 3. Killer portrait

1. On the wiki, the killer page references a portrait file like `K##_TheName_Portrait.png` (the `K##` index continues the sequence — check the highest existing file in `apps/web/public/images/portraits/`, and it must match the wiki's index).
2. Download the original: `https://deadbydaylight.wiki.gg/images/K##_TheName_Portrait.png?format=original` (verify it's a real PNG with `file`).
3. Convert to the repo format (200×200 webp): `cwebp -quiet -resize 200 200 -q 85 in.png -o apps/web/public/images/portraits/K##_TheName.webp` (note: no `_Portrait` suffix in the repo filename).
4. Reference it in the entry as `/images/portraits/K##_TheName.webp`.

Survivors have no portraits in this app.

## 4. Verify

```bash
bun install
bun run test        # Vitest — never `bun test`
bun run typecheck
```

Sanity-check matching (from `packages/shared/`):

```bash
bun -e "import {tryLocalMatch, getKillerPortrait} from './src/characters.ts'; console.log(tryLocalMatch('<new name>'), tryLocalMatch('<pt-br alias>'), getKillerPortrait('<new killer name>'))"
```

If running locally with a browser available, also confirm the webp serves/renders via the `web` launch config.

## 5. Release impact + ship

This is a purely additive data change: no storage migrations, old caches keep working, and `DEFAULT_CHARACTERS` / LLM extraction pick the new names up automatically. No special release steps.

- Interactive session: commit with message `Add <chapter name> chapter characters (<Killer>, <Survivor>)` and follow the user's lead on merging/pushing.
- Autonomous/scheduled run: create a branch, commit, push, and open a PR with the wiki links for the new chapter — never push directly to `main`.
