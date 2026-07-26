#!/usr/bin/env node
// Live evaluation. Sends every corpus prompt to a real model with and without the
// introvert rules, measures the output tokens the API actually reported, and checks
// that the compressed answers stayed grammatical and kept every technical fact.
//
// Usage: node evals/run.mjs [--model sonnet] [--concurrency 4] [--levels standard,max]
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const exec = promisify(execFile)
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const rules = readFileSync(join(root, 'src', 'rules.md'), 'utf8').trim()
const corpus = JSON.parse(readFileSync(join(root, 'evals', 'corpus.json'), 'utf8'))

const arg = (flag, fallback) => {
  const i = process.argv.indexOf(flag)
  return i === -1 ? fallback : process.argv[i + 1]
}

const MODEL = arg('--model', 'sonnet')
const CONCURRENCY = Number(arg('--concurrency', '4'))
const LEVELS = arg('--levels', 'standard,max').split(',')

// Both arms get the same neutral system prompt. Only the rules differ, so the
// measured difference is attributable to the rules and nothing else.
const NEUTRAL = 'You are a helpful AI assistant answering software engineering questions.'
const withRules = (level) =>
  `${NEUTRAL}\n\n${rules}\n\n## Current level\n\nOperate at the **${level}** level for every response.`

// Words that mark text as machine-written. Any hit is a hard failure.
const BANNED = [
  'delve', 'crucial', 'intricate', 'pivotal', 'testament', 'underscore',
  'landscape', 'meticulous', 'garner', 'boast', 'boasts', 'foster', 'fostering',
  'showcase', 'showcases', 'seamless', 'seamlessly', 'robust', 'comprehensive',
  'holistic', 'elevate', 'empower', 'serves as', 'stands as', 'it is not just',
  'not just a', "it's not just", 'as we can see', "let's look at"
]

// Set once a rate limit is observed, so remaining queued items fail fast instead of
// each burning a full call against a quota that is already known to be exhausted.
let rateLimited = null

async function ask (systemPrompt, prompt) {
  if (rateLimited) throw new Error(`skipped: ${rateLimited}`)
  let stdout
  try {
    ;({ stdout } = await exec('claude', [
      '-p', prompt,
      '--system-prompt', systemPrompt,
      '--model', MODEL,
      '--output-format', 'json'
    ], { maxBuffer: 20 * 1024 * 1024, cwd: root }))
  } catch (err) {
    // The CLI exits non-zero on an API error but still writes the JSON body to stdout;
    // execFile attaches that stdout to the rejection, so recover it before giving up.
    stdout = err.stdout
    if (!stdout) throw err
  }
  const parsed = JSON.parse(stdout)
  if (parsed.is_error) {
    if (parsed.api_error_status === 429 || /session limit|rate limit/i.test(parsed.result || '')) {
      rateLimited = parsed.result || 'rate limited'
    }
    throw new Error(parsed.result || 'model returned an error')
  }
  return { text: parsed.result, outputTokens: parsed.usage.output_tokens }
}

/** Deterministic checks. No model involved, so these never drift. */
function staticChecks (text) {
  const lower = text.toLowerCase()
  const bannedHits = BANNED.filter(w => new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(lower))

  // Prose outside code blocks only; code has its own conventions.
  const prose = text.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`]*`/g, ' ')
  const words = prose.split(/\s+/).filter(Boolean)
  const articles = words.filter(w => /^(the|a|an)$/i.test(w.replace(/[^a-z]/gi, ''))).length
  // Article density is the clearest signal that compression turned into caveman-speak.
  const articleDensity = words.length ? +(articles / words.length * 100).toFixed(2) : 0

  return { bannedHits, articleDensity, wordCount: words.length }
}

/**
 * What regex cannot judge: is every sentence complete, and did any fact go missing.
 * Grades every level for a prompt in ONE call instead of one call per level — this is
 * the single biggest cost lever in the harness, since judge calls are half the total.
 */
async function judgeAll (baselineText, levelTexts, prompt) {
  const levelBlock = Object.entries(levelTexts)
    .map(([level, text]) => `--- ${level.toUpperCase()} ---\n${text}`)
    .join('\n\n')
  const instruction = `You are grading deliberately compressed answers against a longer baseline answer to the same question. Grade each compressed answer independently.

QUESTION:
${prompt}

BASELINE ANSWER:
${baselineText}

COMPRESSED ANSWERS:
${levelBlock}

Each compressed answer is SUPPOSED to be much shorter than the baseline. Dropping background,
alternatives the reader did not ask about, caveats that do not change the recommendation, and
extra examples is CORRECT BEHAVIOR and must not be penalised.

Reply with ONLY a JSON object, no prose, no code fence, one key per level you were given:
{"standard": {"grammatical": true/false, "fragments": [...], "factsLost": [...], "ambiguous": true/false}, "max": {...}}

"grammatical" is false if ANY sentence lacks a subject or a main verb, or drops articles so it reads as telegraphic. Headings, list labels, and code blocks are exempt.
"factsLost" lists ONLY material losses: something that makes that compressed answer incorrect, leads the reader to a wrong action, or omits a step without which the described work fails. A fact that is merely additional context is NOT a loss. A caveat describing a scenario the QUESTION already rules out is NOT a loss. A hedge or alternative the reader did not ask about is NOT a loss. Empty array if the answer is correct and actionable for the situation as stated.
"ambiguous" is true only if that answer could be MISREAD in a way that changes what the reader would do.`
  const { stdout } = await exec('claude', [
    '-p', instruction,
    '--system-prompt', 'You are a strict grader. Output only the requested JSON.',
    '--model', MODEL,
    '--output-format', 'json'
  ], { maxBuffer: 20 * 1024 * 1024, cwd: root })
  const raw = JSON.parse(stdout).result.trim().replace(/^```(?:json)?|```$/g, '').trim()
  try {
    return JSON.parse(raw)
  } catch {
    const empty = { grammatical: null, fragments: [], factsLost: [], ambiguous: null, parseError: raw.slice(0, 200) }
    return Object.fromEntries(Object.keys(levelTexts).map(l => [l, empty]))
  }
}

/**
 * Run tasks with a bounded number in flight. A single item's rejection is caught and
 * recorded, not thrown — one rate-limited or transient-error item must never take down
 * every other item's already-computed result, and never stall the runner it was on.
 */
async function pool (items, limit, worker) {
  const results = []
  let cursor = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++
      try {
        results[index] = { status: 'fulfilled', value: await worker(items[index], index) }
      } catch (err) {
        results[index] = { status: 'rejected', reason: err }
      }
    }
  })
  await Promise.all(runners)
  return results
}

console.log(`introvert evals — model=${MODEL} prompts=${corpus.length} levels=${LEVELS.join(',')}\n`)

const rawResults = await pool(corpus, CONCURRENCY, async (item) => {
  const baseline = await ask(NEUTRAL, item.prompt)
  const runs = {}
  for (const level of LEVELS) runs[level] = await ask(withRules(level), item.prompt)
  const verdicts = await judgeAll(baseline.text, Object.fromEntries(LEVELS.map(l => [l, runs[l].text])), item.prompt)
  const levels = {}
  for (const level of LEVELS) {
    const run = runs[level]
    levels[level] = {
      outputTokens: run.outputTokens,
      reduction: +((1 - run.outputTokens / baseline.outputTokens) * 100).toFixed(1),
      ...staticChecks(run.text),
      ...(verdicts[level] || {}),
      text: run.text
    }
  }
  console.log(`  ${item.id.padEnd(20)} baseline ${String(baseline.outputTokens).padStart(4)} → ` +
    LEVELS.map(l => `${l} ${String(levels[l].outputTokens).padStart(4)} (${levels[l].reduction}%)`).join('  '))
  return {
    id: item.id,
    category: item.category,
    prompt: item.prompt,
    baseline: { outputTokens: baseline.outputTokens, text: baseline.text, ...staticChecks(baseline.text) },
    levels
  }
})

// One item's failure (rate limit, transient API error) must not discard every other
// item's results. Isolate failures, report them, and score only what succeeded.
const failed = []
const rows = []
for (let i = 0; i < corpus.length; i++) {
  const outcome = rawResults[i]
  if (outcome.status === 'fulfilled') {
    rows.push(outcome.value)
  } else {
    const reason = outcome.reason?.message || String(outcome.reason)
    failed.push({ id: corpus[i].id, error: reason })
    console.error(`  ${corpus[i].id.padEnd(20)} FAILED: ${reason.split('\n')[0].slice(0, 120)}`)
  }
}

if (rows.length === 0) {
  console.error('\nEvery prompt failed. Nothing to score. Check the errors above.')
  mkdirSync(join(root, 'evals', 'results'), { recursive: true })
  writeFileSync(join(root, 'evals', 'results', 'latest.json'), JSON.stringify({ summary: null, rows: [], failed }, null, 2))
  process.exit(1)
}

const summary = { model: MODEL, promptCount: corpus.length, completedCount: rows.length, failedCount: failed.length, levels: {} }
for (const level of LEVELS) {
  const all = rows.map(r => r.levels[level])
  const mean = (nums) => +(nums.reduce((a, b) => a + b, 0) / nums.length).toFixed(1)
  summary.levels[level] = {
    meanReduction: mean(all.map(r => r.reduction)),
    medianReduction: (() => {
      const s = all.map(r => r.reduction).sort((a, b) => a - b)
      return s.length % 2 ? s[(s.length - 1) / 2] : +((s[s.length / 2 - 1] + s[s.length / 2]) / 2).toFixed(1)
    })(),
    totalBaselineTokens: rows.reduce((a, r) => a + r.baseline.outputTokens, 0),
    totalLevelTokens: all.reduce((a, r) => a + r.outputTokens, 0),
    grammaticalFailures: all.filter(r => r.grammatical === false).length,
    bannedWordFailures: all.filter(r => r.bannedHits.length > 0).length,
    factsLostFailures: all.filter(r => (r.factsLost || []).length > 0).length,
    ambiguousFailures: all.filter(r => r.ambiguous === true).length,
    meanArticleDensity: mean(all.map(r => r.articleDensity))
  }
}
summary.baselineArticleDensity = +(rows.reduce((a, r) => a + r.baseline.articleDensity, 0) / rows.length).toFixed(1)

mkdirSync(join(root, 'evals', 'results'), { recursive: true })
writeFileSync(join(root, 'evals', 'results', 'latest.json'), JSON.stringify({ summary, rows }, null, 2))

console.log('\n' + '='.repeat(72))
console.log(`Baseline totals: ${summary.levels[LEVELS[0]].totalBaselineTokens} output tokens across ${corpus.length} prompts`)
console.log(`Baseline article density: ${summary.baselineArticleDensity}%\n`)
console.log('level  mean cut  median cut   tokens   grammar  banned  facts lost  ambiguous  articles')
for (const level of LEVELS) {
  const s = summary.levels[level]
  console.log(
    `${level.padEnd(6)} ${String(s.meanReduction + '%').padStart(8)} ${String(s.medianReduction + '%').padStart(11)} ` +
    `${String(s.totalLevelTokens).padStart(8)} ${String(s.grammaticalFailures).padStart(9)} ${String(s.bannedWordFailures).padStart(7)} ` +
    `${String(s.factsLostFailures).padStart(11)} ${String(s.ambiguousFailures).padStart(10)} ${String(s.meanArticleDensity + '%').padStart(9)}`
  )
}

const gateFailures = LEVELS.reduce((acc, l) => acc +
  summary.levels[l].grammaticalFailures + summary.levels[l].bannedWordFailures + summary.levels[l].factsLostFailures, 0)
console.log('\n' + (gateFailures === 0
  ? 'All release gates passed.'
  : `${gateFailures} release gate failure(s). See evals/results/latest.json.`))
console.log('Full results: evals/results/latest.json')
process.exit(gateFailures > 0 ? 1 : 0)
