#!/usr/bin/env node
// Live evaluation. Sends every corpus prompt to a real model with and without the
// introvert rules, measures the output tokens the API actually reported, and checks
// that the compressed answers stayed grammatical and kept every technical fact.
//
// Usage: node evals/run.mjs [--model sonnet] [--concurrency 4] [--levels lite,full,max]
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
const LEVELS = arg('--levels', 'lite,full,max').split(',')

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

async function ask (systemPrompt, prompt) {
  const { stdout } = await exec('claude', [
    '-p', prompt,
    '--system-prompt', systemPrompt,
    '--model', MODEL,
    '--output-format', 'json'
  ], { maxBuffer: 20 * 1024 * 1024, cwd: root })
  const parsed = JSON.parse(stdout)
  if (parsed.is_error) throw new Error(parsed.result || 'model returned an error')
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

/** What regex cannot judge: is every sentence complete, and did any fact go missing. */
async function judge (baselineText, compressedText, prompt) {
  const instruction = `You are grading a deliberately compressed answer against a longer baseline answer to the same question.

QUESTION:
${prompt}

BASELINE ANSWER:
${baselineText}

COMPRESSED ANSWER:
${compressedText}

The compressed answer is SUPPOSED to be much shorter. Dropping background, alternatives the
reader did not ask about, caveats that do not change the recommendation, and extra examples is
CORRECT BEHAVIOR and must not be penalised.

Reply with ONLY a JSON object, no prose, no code fence:
{"grammatical": true/false, "fragments": ["sentences that are not complete grammatical sentences"], "factsLost": ["only facts whose absence makes the compressed answer WRONG, MISLEADING, or UNACTIONABLE"], "ambiguous": true/false}

"grammatical" is false if ANY sentence lacks a subject or a main verb, or drops articles so it reads as telegraphic. Headings, list labels, and code blocks are exempt.
"factsLost" lists ONLY material losses: something that makes the compressed answer incorrect, leads the reader to a wrong action, or omits a step without which the described work fails. A fact that is merely additional context is NOT a loss. A caveat describing a scenario the QUESTION already rules out is NOT a loss. A hedge or alternative the reader did not ask about is NOT a loss. Return an empty array if the compressed answer is correct and actionable for the situation as stated in the question.
"ambiguous" is true only if the compressed answer could be MISREAD in a way that changes what the reader would do.`
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
    return { grammatical: null, fragments: [], factsLost: [], ambiguous: null, parseError: raw.slice(0, 200) }
  }
}

/** Run tasks with a bounded number in flight. */
async function pool (items, limit, worker) {
  const results = []
  let cursor = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++
      results[index] = await worker(items[index], index)
    }
  })
  await Promise.all(runners)
  return results
}

console.log(`introvert evals — model=${MODEL} prompts=${corpus.length} levels=${LEVELS.join(',')}\n`)

const rows = await pool(corpus, CONCURRENCY, async (item) => {
  const baseline = await ask(NEUTRAL, item.prompt)
  const levels = {}
  for (const level of LEVELS) {
    const run = await ask(withRules(level), item.prompt)
    const checks = staticChecks(run.text)
    const verdict = await judge(baseline.text, run.text, item.prompt)
    levels[level] = {
      outputTokens: run.outputTokens,
      reduction: +((1 - run.outputTokens / baseline.outputTokens) * 100).toFixed(1),
      ...checks,
      ...verdict,
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

const summary = { model: MODEL, promptCount: corpus.length, levels: {} }
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
