#!/usr/bin/env bun
/**
 * Test character extraction against expected results.
 *
 * Usage:
 *   bun run .claude/skills/test-extraction/test-extract.ts <cases.json> [--runs=3] [--model=<name>]
 *
 * Options:
 *   --runs=N       Run each case N times for LLM (default 3)
 *   --model=NAME   Use a specific model (no fallback). Omit to test all models.
 *
 * Reads GEMINI_API_KEY from apps/api/.env
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { tryLocalMatch } from '../../../packages/shared/src/characters';
import { extractCharacter } from '../../../apps/api/src/gemini';

const ALL_MODELS = ['gemini-3.1-flash-lite-preview', 'gemini-3-flash-preview', 'gemini-2.5-flash', 'gemini-2.5-flash-lite'];

const envPath = resolve(import.meta.dir, '../../../apps/api/.env');
const envContent = readFileSync(envPath, 'utf-8');
const apiKey = envContent.match(/^GEMINI_API_KEY=(.+)$/m)?.[1]?.trim();
if (!apiKey) {
  console.error('GEMINI_API_KEY not found in apps/api/.env');
  process.exit(1);
}

const args = process.argv.slice(2);
const casesFile = args.find(a => !a.startsWith('--'));
const runs = Number(args.find(a => a.startsWith('--runs='))?.split('=')[1] || 3);
const modelArg = args.find(a => a.startsWith('--model='))?.split('=')[1];

if (!casesFile) {
  console.error('Usage: bun run .claude/skills/test-extraction/test-extract.ts <cases.json> [--runs=3] [--model=<name>]');
  console.error(`Available models: ${ALL_MODELS.join(', ')}`);
  process.exit(1);
}

const modelsToTest = modelArg
  ? [ALL_MODELS.find(m => m.includes(modelArg)) || modelArg]
  : ALL_MODELS;

type TestCase = { message: string; expected: string; pos?: number; dbChar?: string };
const testCases: TestCase[] = JSON.parse(readFileSync(casesFile, 'utf-8'));

function normalize(char: string): string {
  if (!char || char === 'none') return '(none)';
  return char;
}

// ── Local extraction score ──

function runLocalExtraction() {
  console.log(`━━━ Local (regex) extraction ━━━\n`);

  let correct = 0, wrong = 0, missed = 0;
  const issues: string[] = [];

  for (const tc of testCases) {
    const label = tc.pos != null ? `pos=${tc.pos}` : tc.message.slice(0, 30);
    const expected = normalize(tc.expected);
    const local = tryLocalMatch(tc.message);
    const got = local ? local.character : '(none)';
    const ambiguous = local?.ambiguous ? ' (ambiguous)' : '';

    if (got === expected) {
      correct++;
      console.log(`  PASS ${label} → ${got}${ambiguous}`);
    } else if (got === '(none)' && expected !== '(none)') {
      missed++;
      console.log(`  MISS ${label} → no local match, needs LLM (expected ${expected})`);
      issues.push(`MISS ${label}: expected ${expected}`);
    } else {
      wrong++;
      console.log(`  WRONG ${label} → got ${got}${ambiguous}, expected ${expected}`);
      issues.push(`WRONG ${label}: got ${got}, expected ${expected}`);
    }
  }

  const total = testCases.length;
  const localRate = ((correct / total) * 100).toFixed(1);
  const wrongRate = ((wrong / total) * 100).toFixed(1);

  console.log(`\n  Local accuracy: ${correct}/${total} (${localRate}%) correct`);
  console.log(`  Missed (needs LLM): ${missed}/${total}`);
  console.log(`  Wrong: ${wrong}/${total} (${wrongRate}%)`);

  return { correct, wrong, missed, total, issues };
}

// ── Concurrency pool ──

const CONCURRENCY = 5;

async function pool<T>(tasks: (() => Promise<T>)[], concurrency: number): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let idx = 0;
  async function worker() {
    while (idx < tasks.length) {
      const i = idx++;
      results[i] = await tasks[i]();
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker()));
  return results;
}

// ── LLM extraction score ──

type CaseResult = { label: string; status: 'pass' | 'fail' | 'error'; line: string; failure?: string };
type ModelStats = { pass: number; fail: number; error: number; failures: string[] };

async function runCase(tc: TestCase, model: string): Promise<CaseResult> {
  const label = tc.pos != null ? `pos=${tc.pos}` : tc.message.slice(0, 30);
  const expected = normalize(tc.expected);
  const dbChar = tc.dbChar ? normalize(tc.dbChar) : undefined;
  const modelIdx = ALL_MODELS.indexOf(model);

  const results = await Promise.all(
    Array.from({ length: runs }, () =>
      extractCharacter(tc.message, apiKey!, 0, modelIdx, modelIdx)
        .then(r => normalize(r.character))
        .catch(() => 'ERROR')
    )
  );

  const allFailed = results.every(r => r === 'ERROR');
  if (allFailed) return { label, status: 'error', line: `  ERR  ${label} — all retries failed` };

  const valid = results.filter(r => r !== 'ERROR');
  const allMatch = valid.every(r => r === expected);
  const majority = valid.filter(r => r === expected).length > valid.length / 2;

  if (allMatch) {
    const tag = dbChar && dbChar !== expected ? ` (was ${dbChar})` : '';
    const consistent = new Set(valid).size === 1;
    return { label, status: 'pass', line: `  PASS ${label} → ${expected}${tag}${consistent ? '' : ' (inconsistent)'}` };
  }

  const got = [...new Set(valid)].join(', ');
  return {
    label, status: 'fail',
    line: `  FAIL ${label} → expected ${expected}, got [${got}]${majority ? ' (majority ok)' : ''}\n       MSG: ${tc.message.slice(0, 90)}`,
    failure: `${label} → expected ${expected}, got [${got}]`,
  };
}

async function runLLMModel(model: string): Promise<ModelStats> {
  const caseResults = await pool(
    testCases.map(tc => () => runCase(tc, model)),
    CONCURRENCY,
  );

  const stats: ModelStats = { pass: 0, fail: 0, error: 0, failures: [] };
  for (const r of caseResults) {
    stats[r.status]++;
    console.log(r.line);
    if (r.failure) stats.failures.push(r.failure);
  }
  return stats;
}

// ── Main ──

async function main() {
  console.log(`Cases: ${testCases.length} | LLM runs per case: ${runs}\n`);

  // Local score
  const local = runLocalExtraction();

  // LLM scores
  console.log(`\nLLM models: ${modelsToTest.join(', ')}`);

  const llmSummary: { model: string; stats: ModelStats }[] = [];

  for (const model of modelsToTest) {
    console.log(`\n━━━ ${model} ━━━\n`);
    const stats = await runLLMModel(model);
    llmSummary.push({ model, stats });

    const total = stats.pass + stats.fail;
    const score = total > 0 ? ((stats.pass / total) * 100).toFixed(1) : 'N/A';
    console.log(`\n  Score: ${score}% (${stats.pass}/${total} pass, ${stats.error} errors)`);
  }

  // Summary
  console.log(`\n========== SUMMARY ==========\n`);
  console.log(`${'Method'.padEnd(35)} ${'Score'.padStart(6)}  ${'Pass'.padStart(4)} ${'Miss'.padStart(4)} ${'Wrong'.padStart(5)} ${'Err'.padStart(4)}`);
  console.log('─'.repeat(62));

  const localScore = local.total > 0 ? ((local.correct / local.total) * 100).toFixed(1) + '%' : 'N/A';
  console.log(`${'Local (regex)'.padEnd(35)} ${localScore.padStart(6)}  ${String(local.correct).padStart(4)} ${String(local.missed).padStart(4)} ${String(local.wrong).padStart(5)} ${String(0).padStart(4)}`);

  for (const { model, stats } of llmSummary) {
    const total = stats.pass + stats.fail;
    const score = total > 0 ? ((stats.pass / total) * 100).toFixed(1) + '%' : 'N/A';
    console.log(`${model.padEnd(35)} ${score.padStart(6)}  ${String(stats.pass).padStart(4)} ${'—'.padStart(4)} ${String(stats.fail).padStart(5)} ${String(stats.error).padStart(4)}`);
  }

  // Failures detail
  const anyIssues = local.issues.length > 0 || llmSummary.some(s => s.stats.failures.length > 0);
  if (anyIssues) {
    console.log(`\nIssues:`);
    if (local.issues.length > 0) {
      console.log(`  Local:`);
      local.issues.forEach(f => console.log(`    ${f}`));
    }
    for (const { model, stats } of llmSummary) {
      if (stats.failures.length === 0) continue;
      console.log(`  ${model}:`);
      stats.failures.forEach(f => console.log(`    ${f}`));
    }
  }
}

main();
