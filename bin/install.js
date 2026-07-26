#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { adapters } from '../src/adapters/index.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const meta = JSON.parse(readFileSync(join(root, 'src', 'skill-meta.json'), 'utf8'))
const rules = readFileSync(join(root, 'src', 'rules.md'), 'utf8').trim()

const argv = process.argv.slice(2)
const has = (flag) => argv.includes(flag)
const valueOf = (flag) => {
  const i = argv.indexOf(flag)
  return i === -1 ? null : argv[i + 1]
}

const opts = {
  dryRun: has('--dry-run'),
  uninstall: has('--uninstall'),
  help: has('--help') || has('-h'),
  only: valueOf('--agent')
}

const HELP = `
introvert — token-efficient responses that stay grammatical

Usage:
  npx introvert-skill [options]

Options:
  --agent <id>   Install for one agent only (${adapters.map(a => a.id).join(', ')})
  --dry-run      Show what would be written, change nothing
  --uninstall    Remove introvert from every detected agent
  --help         Show this message
`

if (opts.help) {
  console.log(HELP.trim())
  process.exit(0)
}

if (opts.only && !adapters.some(a => a.id === opts.only)) {
  console.error(`Unknown agent "${opts.only}". Supported: ${adapters.map(a => a.id).join(', ')}`)
  process.exit(1)
}

const targets = adapters
  .filter(a => (opts.only ? a.id === opts.only : a.detect.some(existsSync)))

if (targets.length === 0) {
  console.error(
    opts.only
      ? `Agent "${opts.only}" selected but its config directory does not exist.`
      : `No supported agents detected.\nSupported: ${adapters.map(a => a.id).join(', ')}\nForce one with --agent <id>.`
  )
  process.exit(1)
}

let failures = 0

for (const agent of targets) {
  const files = agent.files(meta, rules)

  if (opts.uninstall) {
    for (const file of files) {
      if (!existsSync(file.path)) continue
      if (opts.dryRun) {
        console.log(`would remove  ${file.path}`)
        continue
      }
      try {
        rmSync(file.path)
        console.log(`removed  ${file.path}`)
      } catch (err) {
        console.error(`failed to remove ${file.path}: ${err.message}`)
        failures++
      }
    }
    continue
  }

  console.log(`\n${agent.label}`)
  for (const file of files) {
    if (opts.dryRun) {
      console.log(`  would write  ${file.path}`)
      continue
    }
    try {
      mkdirSync(dirname(file.path), { recursive: true })
      // Never destroy an existing file without leaving a copy behind.
      if (existsSync(file.path)) {
        const backup = `${file.path}.bak`
        copyFileSync(file.path, backup)
        console.log(`  backed up    ${backup}`)
      }
      writeFileSync(file.path, file.content)
      console.log(`  wrote        ${file.path}`)
    } catch (err) {
      console.error(`  failed       ${file.path}: ${err.message}`)
      failures++
    }
  }
}

if (!opts.uninstall && !opts.dryRun && failures === 0) {
  console.log(`\nDone. Start a new session and type /introvert to turn it on.`)
  console.log(`Levels: /introvert standard (default) | max. Turn off with /introvert off.`)
}

process.exit(failures > 0 ? 1 : 0)
