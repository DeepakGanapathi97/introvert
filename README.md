# introvert

**Say it once. Say it right. Stop.**

A skill for AI coding agents that cuts output tokens without breaking a single sentence.

```bash
npx introvert-skill
```

Installs for Claude Code, Cursor, Codex CLI, and Gemini CLI — whichever it finds.

---

## Why this exists

[Caveman](https://github.com/JuliusBrussee/caveman) proved people will trade prose for tokens.
It saves about 65% by dropping articles, verbs, and sentence structure:

> "Bug in auth middleware. Token expiry check use `<` not `<=`. Fix:"

You understand it. But "check use" is not English, and you cannot paste it into a PR without
rewriting it. On a personal project that is a fine trade. On enterprise code — a migration, an
auth check, an incident postmortem read by six people — an ambiguous instruction costs more
than the tokens it saved.

introvert makes the opposite trade on grammar and the same trade on tokens:

> "The auth middleware compares expiry with `<` instead of `<=`. Change it to `<=`."

Same information. Same order of magnitude of savings. Still a sentence.

**Measured on 5 live prompts** (real engineering questions, run against Claude Sonnet, output
tokens taken from the API's own usage reporting — not estimated):

| Level | Mean cut | Grammar clean |
|---|---|---|
| `lite` | 51% | 5/5 |
| `full` | 53% | 5/5 |
| `max` | 85% | 4/5 |

`max` failed its own rule once in this run — a one-word answer to a yes/no question came back
as a sentence fragment (`"Redis."` instead of `"Use Redis."`). Documented here instead of
re-run until clean: at `max`, treat the grammatical floor as measured, not guaranteed. `lite`
and `full` held it in every run so far. Full methodology and results:
[`evals/results/latest.json`](evals/results/latest.json).

## Install

```bash
npx introvert-skill              # every detected agent
npx introvert-skill --dry-run    # show what would be written, change nothing
npx introvert-skill --agent cursor
npx introvert-skill --uninstall
```

Node 18 or newer. No runtime dependencies. Existing files are backed up to `.bak` before
anything is overwritten.

**Claude Code plugin marketplace:** the repo is a valid plugin — point your marketplace at
`DeepakGanapathi97/introvert`.

**Any other agent:** paste [`src/rules.md`](src/rules.md) into its system prompt or rules file.
That file is the whole skill; everything else is packaging.

## Use

```
/introvert            activate at full (default)
/introvert lite       lighter compression
/introvert max        hardest compression
/introvert off        deactivate
```

Natural phrases work too: "introvert mode", "quiet mode", "talk less", "be minimal", "less
words", "stop rambling", "fewer tokens".

A one-off "be brief" does **not** activate it. That asks for one short answer, not a mode.

## Levels

| Level | Cuts | Length |
|---|---|---|
| `lite` | Filler, hedging, preamble, sign-offs | Baseline structure, tightened wording |
| `full` | Also redundant clauses, restatements, padded phrasing | One short paragraph for most questions |
| `max` | Also every supporting clause that is not load-bearing | The answer, plus at most one supporting sentence |

The grammatical floor never moves between levels. Only the amount of supporting detail does. A
sentence at `max` has a subject and a verb exactly as one at `lite` does.

## What it never touches

Code blocks, commit messages, PR bodies, error strings, identifiers, file paths, and CLI
commands are reproduced verbatim at every level.

## When it gets out of the way

Compression suspends completely, then resumes on its own, when:

- Another skill or command defines the output format. introvert governs prose style and never
  overrides another skill's required structure.
- The response carries a security warning.
- The response confirms a destructive or irreversible action.
- Steps are ordered and dropping a clause could scramble them.
- You ask for clarification or repeat a question. The compression failed; you get the full
  answer.

This is the difference between a style and a straitjacket. A skill that compresses a
`DROP TABLE` confirmation is a bug.

## It also stops sounding like a model

Compressed text still reads as machine-written if it keeps machine vocabulary. introvert bans
the tells — *delve, crucial, pivotal, testament, robust, seamless, comprehensive, leverage,
foster, showcase* — along with negative parallelism ("not just X, but Y"), rule-of-three
padding, and "serves as" standing in for "is".

These cuts serve both goals at once, because the tell-words are almost always padding. The list
is derived from Wikipedia's [Signs of AI writing](https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing).

## Honest limits

- **Output tokens only.** Input and reasoning tokens are unchanged. Anyone claiming otherwise
  is measuring wrong.
- **The skill costs input tokens.** It is loaded into context on every turn. On short
  exchanges that overhead can exceed what it saves; the savings compound over long sessions.
- **Every number in this README was measured**, not estimated. Reproduce them with
  `npm run eval`.

## How it is validated

`npm run eval` sends every prompt in [`evals/corpus.json`](evals/corpus.json) to a live model
twice: once with a neutral system prompt, once with the same prompt plus the introvert rules.
Both arms are identical except for the rules, so the difference is attributable to the rules.
Token counts come from the API's own usage reporting, not from an estimator.

Every run is then graded on four gates:

| Gate | Fails when |
|---|---|
| Grammar | Any sentence lacks a subject or a main verb |
| AI vocabulary | Any banned word appears |
| Information parity | A fact is lost that makes the answer wrong or unactionable |
| Ambiguity | The compressed answer can be misread in a way the baseline cannot |

A failure on grammar, vocabulary, or parity blocks a release regardless of how good the token
number looks. The token number is the reward; the gates are the product.

## Development

```bash
npm run build     # regenerate agent artifacts from src/rules.md
npm run check     # fail if a committed artifact drifted from the source
npm test          # installer tests
npm run eval      # live model evaluation
```

`src/rules.md` is the single source of truth. Every agent-specific file is generated from it,
so a rule fix is a one-file edit. `npm run check` fails the build if a committed artifact has
drifted.

## Credit

[caveman](https://github.com/JuliusBrussee/caveman) by Julius Brussee came first and proved the
idea. introvert is not a replacement for it — it is the other side of the same trade. If you
want maximum compression and do not mind fragments, use caveman. If your output ends up in code
review, use this.

## License

MIT
