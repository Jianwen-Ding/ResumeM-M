/**
 * The coding-agent CLIs people actually have, and how each one wants to be
 * called.
 *
 * These lived in the editor's JavaScript, which meant the command line could
 * not offer them, nothing could test them, and a preset that stopped working
 * would only be discovered by a user. They are a fact about three external
 * programs, so they belong somewhere both ends can read and a test can check.
 *
 * Every preset is confined the same way regardless of its own flags: the child
 * runs in an empty scratch directory holding nothing but the prompt (see
 * `runAgent`). The read-only flags below are belt and braces on top of that,
 * not the guarantee.
 */

export interface AiPreset {
  /** Shown in the picker. */
  label: string;
  command: string;
  args: string[];
  /** One line on what this preset does about safety, for the UI to show. */
  note: string;
}

export const AI_PRESETS: AiPreset[] = [
  {
    label: 'Claude Code',
    command: 'claude',
    // `-p` prints and exits. The prompt is passed as a file path because these
    // prompts run to tens of kilobytes; every tool that could touch anything is
    // disallowed, and the only directory it is told about is the scratch one.
    args: ['-p', '--add-dir', '{sandbox}', '--disallowedTools', 'Bash,Write,Edit,WebFetch,WebSearch', '{prompt}'],
    note: 'Runs with every file-touching and network tool disallowed.',
  },
  {
    label: 'Codex CLI',
    command: 'codex',
    /*
     * `exec` is the non-interactive form. Two flags are not optional here:
     * `--sandbox read-only` is Codex's own confinement, and
     * `--skip-git-repo-check` because the scratch directory is deliberately not
     * a repository — without it Codex refuses to start, assuming you want
     * version control before it touches anything. It touches nothing.
     */
    args: ['exec', '--sandbox', 'read-only', '--skip-git-repo-check', '--cd', '{sandbox}', '{promptText}'],
    note: 'Runs in Codex’s own read-only sandbox, in a scratch directory.',
  },
  {
    label: 'Gemini CLI',
    command: 'gemini',
    // Gemini takes the prompt inline after -p and writes the answer to stdout.
    args: ['-p', '{promptText}'],
    note: 'Prompt passed inline; nothing is written anywhere.',
  },
];

/** Which preset a saved config matches, if any. */
export function matchPreset(command: string, args: string[]): AiPreset | undefined {
  return AI_PRESETS.find((p) => p.command === command && p.args.join(' ') === args.join(' '));
}

/**
 * Repair an AI command that cannot work as configured.
 *
 * A preset is copied when it is chosen, not referenced, so a config saved
 * before a preset was fixed keeps the broken arguments forever. The one case
 * that matters: the agent always runs in an empty scratch directory — that
 * confinement is the point — and `codex exec` refuses to start outside a git
 * repository unless told not to care. A config saved before that was understood
 * fails every time with "Not inside a trusted directory", which reads like a
 * bug in this tool rather than a missing flag.
 *
 * Only this one case is repaired, and only by adding a flag that cannot change
 * what the command does to anything outside the scratch directory: the
 * read-only sandbox stays exactly as configured.
 */
export function repairAiArgs(command: string, args: string[]): string[] {
  const isCodex = /(^|[\\/])codex(\.exe)?$/i.test(command.trim());
  if (!isCodex || !args.includes('exec') || args.includes('--skip-git-repo-check')) return args;

  const out = [...args];
  out.splice(out.indexOf('exec') + 1, 0, '--skip-git-repo-check');
  return out;
}
