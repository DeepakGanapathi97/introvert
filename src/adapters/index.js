import { homedir } from 'node:os'
import { join } from 'node:path'

// Each adapter turns the one canonical rule set into the format its agent expects.
// Adding an agent means adding an entry here and nothing else.

const home = homedir()

/** Wrap text into an indented YAML folded block scalar body (the lines under `key: >`). */
function foldedBlock (text, width = 100, indent = '  ') {
  const words = text.trim().split(/\s+/)
  const lines = []
  let line = ''
  for (const word of words) {
    const next = line ? `${line} ${word}` : word
    if (next.length > width && line) {
      lines.push(indent + line)
      line = word
    } else {
      line = next
    }
  }
  if (line) lines.push(indent + line)
  return lines.join('\n')
}

/**
 * YAML frontmatter block. Long values use a folded block scalar (`key: >`), the same
 * style caveman's SKILL.md uses — wrapped across lines, no quote-escaping needed. That
 * matches what skills.sh's summary extraction expects; our previous single-line,
 * backslash-escaped JSON string produced a blank summary on the skills.sh listing page.
 * Short values stay as quoted scalars.
 */
function frontmatter (fields) {
  const lines = Object.entries(fields).map(([k, v]) => {
    if (typeof v === 'string' && v.length > 80) {
      return `${k}: >\n${foldedBlock(v)}`
    }
    return `${k}: ${JSON.stringify(v)}`
  })
  return `---\n${lines.join('\n')}\n---\n`
}

/** The Claude Code / Cursor skill file: frontmatter plus the shared rules. */
function skillFile (meta, rules) {
  return frontmatter({ name: meta.name, description: meta.description }) +
    `\n# introvert\n\n${rules}`
}

/** The slash command definition shared by agents that support commands. */
function commandFile (meta, rules) {
  return frontmatter({
    name: meta.name,
    description: `Toggle introvert. Usage: /introvert [lite|full|max|off]. ${meta.summary}`
  }) +
    `\n# /introvert\n\n` +
    `Set the response style for the rest of the session.\n\n` +
    `- \`/introvert\` — activate at the default level (${meta.defaultLevel})\n` +
    `- \`/introvert lite|full|max\` — activate at that level\n` +
    `- \`/introvert off\` — deactivate\n\n` +
    `Apply these rules until turned off:\n\n${rules}`
}

export const adapters = [
  {
    id: 'claude-code',
    label: 'Claude Code',
    // Detected by the agent's config directory existing.
    detect: [join(home, '.claude')],
    files: (meta, rules) => [
      { path: join(home, '.claude', 'skills', 'introvert', 'SKILL.md'), content: skillFile(meta, rules) },
      { path: join(home, '.claude', 'commands', 'introvert.md'), content: commandFile(meta, rules) }
    ]
  },
  {
    id: 'cursor',
    label: 'Cursor',
    detect: [join(home, '.cursor')],
    files: (meta, rules) => [
      { path: join(home, '.cursor', 'skills', 'introvert', 'SKILL.md'), content: skillFile(meta, rules) }
    ]
  },
  {
    id: 'codex',
    label: 'Codex CLI',
    detect: [join(home, '.codex')],
    files: (meta, rules) => [
      // Codex reads AGENTS.md-style instruction files from its prompts directory.
      { path: join(home, '.codex', 'prompts', 'introvert.md'), content: commandFile(meta, rules) },
      { path: join(home, '.codex', 'skills', 'introvert', 'SKILL.md'), content: skillFile(meta, rules) }
    ]
  },
  {
    id: 'gemini',
    label: 'Gemini CLI',
    detect: [join(home, '.gemini')],
    files: (meta, rules) => [
      // Gemini CLI extensions are a JSON manifest plus a context file it loads.
      {
        path: join(home, '.gemini', 'extensions', 'introvert', 'gemini-extension.json'),
        content: JSON.stringify({
          name: meta.name,
          version: meta.version,
          description: meta.summary,
          contextFileName: 'INTROVERT.md'
        }, null, 2) + '\n'
      },
      {
        path: join(home, '.gemini', 'extensions', 'introvert', 'INTROVERT.md'),
        content: `# introvert\n\n${rules}`
      }
    ]
  }
]

export { skillFile, commandFile }
