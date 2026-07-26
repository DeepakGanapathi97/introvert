import { homedir } from 'node:os'
import { join } from 'node:path'

// Each adapter turns the one canonical rule set into the format its agent expects.
// Adding an agent means adding an entry here and nothing else.

const home = homedir()

/** YAML frontmatter block. Values are quoted so colons in descriptions stay safe. */
function frontmatter (fields) {
  const lines = Object.entries(fields).map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
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
