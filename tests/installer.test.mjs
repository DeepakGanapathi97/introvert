import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync, mkdtempSync, mkdirSync, existsSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const meta = JSON.parse(readFileSync(join(root, 'src', 'skill-meta.json'), 'utf8'))
const rules = readFileSync(join(root, 'src', 'rules.md'), 'utf8').trim()

/** Run the installer with HOME pointed at a scratch directory. */
function runInstaller (args, home) {
  return execFileSync('node', [join(root, 'bin', 'install.js'), ...args], {
    env: { ...process.env, HOME: home },
    encoding: 'utf8'
  })
}

function scratchHome (agentDirs = []) {
  const home = mkdtempSync(join(tmpdir(), 'introvert-test-'))
  for (const dir of agentDirs) mkdirSync(join(home, dir), { recursive: true })
  return home
}

test('installs for a detected agent', () => {
  const home = scratchHome(['.claude'])
  runInstaller([], home)
  assert.ok(existsSync(join(home, '.claude', 'skills', 'introvert', 'SKILL.md')))
  assert.ok(existsSync(join(home, '.claude', 'commands', 'introvert.md')))
  rmSync(home, { recursive: true, force: true })
})

test('skips agents that are not installed', () => {
  const home = scratchHome(['.claude'])
  runInstaller([], home)
  assert.ok(!existsSync(join(home, '.cursor')), 'must not create config for an absent agent')
  rmSync(home, { recursive: true, force: true })
})

test('installed skill carries the canonical rules', () => {
  const home = scratchHome(['.claude'])
  runInstaller([], home)
  const written = readFileSync(join(home, '.claude', 'skills', 'introvert', 'SKILL.md'), 'utf8')
  assert.ok(written.includes(rules), 'rules.md must reach the installed file unmodified')
  assert.ok(written.startsWith('---\n'), 'must carry YAML frontmatter')
  // Long values fold into a YAML block scalar (`description: >`, wrapped, unescaped)
  // rather than a single quoted line — verify the folded form, not a literal match.
  assert.ok(written.includes('description: >'), 'long description must use a folded block scalar')
  // A YAML folded scalar wraps long lines, so compare with whitespace collapsed rather
  // than as a literal substring — wrapping can land mid-sentence.
  const normalize = (s) => s.replace(/\s+/g, ' ').trim()
  assert.ok(normalize(written).includes(normalize(meta.description)), 'folded body must contain the source text, modulo line wrapping')
  rmSync(home, { recursive: true, force: true })
})

test('is idempotent', () => {
  const home = scratchHome(['.claude'])
  runInstaller([], home)
  const first = readFileSync(join(home, '.claude', 'skills', 'introvert', 'SKILL.md'), 'utf8')
  runInstaller([], home)
  const second = readFileSync(join(home, '.claude', 'skills', 'introvert', 'SKILL.md'), 'utf8')
  assert.equal(first, second)
  rmSync(home, { recursive: true, force: true })
})

test('backs up an existing file before overwriting it', () => {
  const home = scratchHome(['.claude'])
  const target = join(home, '.claude', 'skills', 'introvert', 'SKILL.md')
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, 'PRIOR CONTENT')
  runInstaller([], home)
  assert.equal(readFileSync(`${target}.bak`, 'utf8'), 'PRIOR CONTENT')
  assert.notEqual(readFileSync(target, 'utf8'), 'PRIOR CONTENT')
  rmSync(home, { recursive: true, force: true })
})

test('dry run writes nothing', () => {
  const home = scratchHome(['.claude'])
  const out = runInstaller(['--dry-run'], home)
  assert.match(out, /would write/)
  assert.ok(!existsSync(join(home, '.claude', 'skills', 'introvert', 'SKILL.md')))
  rmSync(home, { recursive: true, force: true })
})

test('uninstall removes exactly what was installed', () => {
  const home = scratchHome(['.claude'])
  runInstaller([], home)
  runInstaller(['--uninstall'], home)
  assert.ok(!existsSync(join(home, '.claude', 'skills', 'introvert', 'SKILL.md')))
  assert.ok(!existsSync(join(home, '.claude', 'commands', 'introvert.md')))
  assert.ok(existsSync(join(home, '.claude')), 'must not remove the agent config directory itself')
  rmSync(home, { recursive: true, force: true })
})

test('--agent forces a target the detector would skip', () => {
  const home = scratchHome(['.cursor'])
  runInstaller(['--agent', 'cursor'], home)
  assert.ok(existsSync(join(home, '.cursor', 'skills', 'introvert', 'SKILL.md')))
  rmSync(home, { recursive: true, force: true })
})

test('exits non-zero when no agent is detected', () => {
  const home = scratchHome([])
  assert.throws(() => runInstaller([], home), /Command failed/)
  rmSync(home, { recursive: true, force: true })
})

test('exits non-zero on an unknown --agent', () => {
  const home = scratchHome(['.claude'])
  assert.throws(() => runInstaller(['--agent', 'emacs'], home), /Command failed/)
  rmSync(home, { recursive: true, force: true })
})
