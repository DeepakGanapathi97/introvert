#!/usr/bin/env node
// Regenerates the committed artifacts from src/rules.md.
// Run with --check to fail when a committed copy has drifted from the source.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { skillFile, commandFile } from '../src/adapters/index.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const meta = JSON.parse(readFileSync(join(root, 'src', 'skill-meta.json'), 'utf8'))
const rules = readFileSync(join(root, 'src', 'rules.md'), 'utf8').trim()

const artifacts = [
  { path: join(root, 'skills', 'introvert', 'SKILL.md'), content: skillFile(meta, rules) },
  { path: join(root, 'commands', 'introvert.md'), content: commandFile(meta, rules) },
  {
    path: join(root, '.claude-plugin', 'plugin.json'),
    content: JSON.stringify({
      name: meta.name,
      version: meta.version,
      description: meta.summary,
      author: { name: 'Deepak Ganapathi', url: 'https://github.com/DeepakGanapathi97' },
      homepage: meta.homepage,
      license: meta.license,
      keywords: ['tokens', 'concise', 'efficiency', 'output', 'style']
    }, null, 2) + '\n'
  }
]

const check = process.argv.includes('--check')
let drifted = 0

for (const artifact of artifacts) {
  if (check) {
    const current = existsSync(artifact.path) ? readFileSync(artifact.path, 'utf8') : null
    if (current !== artifact.content) {
      console.error(`drifted from src/rules.md: ${artifact.path}`)
      drifted++
    }
    continue
  }
  mkdirSync(dirname(artifact.path), { recursive: true })
  writeFileSync(artifact.path, artifact.content)
  console.log(`wrote ${artifact.path.replace(root + '/', '')}`)
}

if (check) {
  if (drifted > 0) {
    console.error(`\n${drifted} artifact(s) out of date. Run: npm run build`)
    process.exit(1)
  }
  console.log('artifacts match src/rules.md')
}
