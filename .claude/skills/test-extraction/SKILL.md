---
name: test-extraction
description: Run character extraction quality assessment against test cases
user-invocable: true
---

# Test Character Extraction

Assess character identification quality against production data.

## Step 1: Pull production data

Query D1 for active requests:

```bash
bunx wrangler d1 execute fila-dbd --remote --env production \
  --command "SELECT position, donor, message, character, type, source, room_id FROM requests WHERE done = 0 ORDER BY room_id, position" \
  --config apps/api/wrangler.toml --json > .claude/skills/test-extraction/prod-requests.json
```

Add `WHERE room_id = '<room>'` to filter by channel if specified.

## Step 2: Build test cases

Convert prod data to `.claude/skills/test-extraction/extract-cases.json`. Skip `source = 'manual'` entries (bypass extraction). Each entry:

```json
{ "pos": 123, "message": "the chat message", "expected": "Hag", "dbChar": "old wrong value" }
```

- `expected`: canonical character name from `packages/shared/src/characters.ts`, or `"(none)"` for no request
- `dbChar`: only include when fixing a known DB error (for tracking)
- Use canonical names (e.g. "Shape" not "Michael Myers", "Dark Lord" not "Dracula", "Cenobite" not "Pinhead")

### Common pitfalls when setting expected values

- **Roleplay donations**: donors with character names (e.g. "krasue safadinha", "Vecna Solteiro") often MENTION characters without REQUESTING them. If there's no "joga de" / play request, expected should be `(none)`
- **"Chega de X, joga de Y"**: the REQUEST is Y, not X. X is being dismissed
- **Multi-character messages**: "joga de Ghost Face e uma de singularidade" — system extracts one. Set expected to whichever the system should pick (typically the first)
- **Non-DBD names**: "Tifany" is NOT a DBD character — expected `(none)`, not "Good Guy"
- **Portuguese translations**: "O Doutor" = Doctor, "Artista" = Artist, "cavaleiro" = Knight, "singularidade" = Singularity, "palhaço" = Clown, "Praga" = Plague, "draga" = Dredge

## Step 3: Run the test

```bash
bun run .claude/skills/test-extraction/test-extract.ts .claude/skills/test-extraction/extract-cases.json [--runs=3] [--model=<name>]
```

- `--model=<name>`: test a specific model (substring match). Omit to test all models.
- Runs local regex + LLM extraction, reports PASS/FAIL/ERROR with summary table
- Cases run with concurrency=5 for speed

### Reading results

- **Local MISS**: regex found nothing, escalates to LLM — this is fine
- **Local WRONG (ambiguous)**: regex found wrong char but flagged ambiguous → escalates to LLM for correction — working as designed
- **Local WRONG (no ambiguous)**: regex confidently returned wrong char → **real bug**, won't escalate. Fix by adding aliases or adjusting regex
- **LLM FAIL with inconsistent results**: model returns different answers across runs → unreliable for that case
- **LLM FAIL (hallucination)**: returned a character not in the message → may need prompt fix

## When to run

- After tweaking the prompt in `apps/api/src/gemini.ts`
- After adding/removing character aliases in `packages/shared/src/characters.ts`
- To compare models (use `--model` flag for each)
- Periodically to check for model regression

## Baseline (2026-03-08, 101 cases)

```
Method                               Score  Pass Miss Wrong  Err
──────────────────────────────────────────────────────────────
Local (regex)                        79.2%    80   12     9    0
gemini-3.1-flash-lite-preview        92.1%    93    —     8    0
gemini-3-flash-preview               93.1%    94    —     7    0
```

All 9 local wrongs are ambiguous → corrected by LLM. Effective local+LLM accuracy ≈ LLM accuracy.
Flash Lite is default (0 rate limit errors, 1% less accurate than Preview).
