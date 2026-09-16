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
  /** What changes when the AI is allowed to look things up. */
  researchNote?: string;
}

export const AI_PRESETS: AiPreset[] = [
  {
    label: 'Claude Code',
    command: 'claude',
    /*
     * `-p` prints and exits. The prompt goes in on stdin and is named by no
     * argument at all, which is not a stylistic choice: `--disallowedTools`
     * takes a list, so it swallows whatever follows it, and a prompt passed
     * positionally after it became a deny rule —
     *
     *   Permission deny rule "/tmp/rmm-ai-xxx/prompt.md" matches no known tool
     *   Error: Input must be provided either through stdin or as a prompt
     *          argument when using --print
     *
     * — which is what "the AI does nothing" looked like from the outside.
     * Stdin also has no length limit, and these prompts run to tens of
     * kilobytes.
     */
    args: ['-p', '--add-dir', '{sandbox}', '--disallowedTools', 'Bash,Write,Edit,WebFetch,WebSearch'],
    note: 'Runs with every file-touching and network tool disallowed.',
    researchNote: 'Web search and fetch are allowed; nothing else changes.',
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
  const named = (re: RegExp) => re.test(command.trim());

  // Codex: refuses to start outside a git repository unless told not to check.
  if (named(/(^|[\\/])codex(\.exe)?$/i) && args.includes('exec') && !args.includes('--skip-git-repo-check')) {
    const out = [...args];
    out.splice(out.indexOf('exec') + 1, 0, '--skip-git-repo-check');
    return out;
  }

  /*
   * Claude Code: a prompt placed after `--disallowedTools` is read as another
   * tool to deny, and the prompt then never arrives — so the command fails
   * every time, having been configured from a preset that looked reasonable.
   * Dropping the token leaves the prompt to stdin, which is where it should
   * have gone.
   */
  if (named(/(^|[\\/])claude(\.exe)?$/i) && args.includes('--disallowedTools')) {
    const after = args.slice(args.indexOf('--disallowedTools') + 2);
    if (after.length === 1 && (after[0] === '{prompt}' || after[0] === '{promptText}')) {
      return args.slice(0, -1);
    }
  }
  return args;
}


/* ------------------------------------------------------------------ *
 * Looking things up                                                   *
 * ------------------------------------------------------------------ */

/** The tools a CLI needs in order to read anything on the web. */
const WEB_TOOLS = ['WebFetch', 'WebSearch'];

/**
 * Make the arguments agree with the research setting.
 *
 * Telling a model it may look something up while denying it the tools to do
 * so is the worst of both: it either says it cannot, or it makes something up.
 * So the setting and the arguments are kept in step at the one place the
 * config is read, rather than relying on the argument box having been edited
 * to match a checkbox somewhere else.
 *
 * Only the deny list moves. The filesystem confinement — an empty scratch
 * directory, and nothing else named — is untouched either way: what changes is
 * whether the model may read the company's own careers page, not whether it
 * may read yours.
 */
export function applyResearch(command: string, args: string[], research: boolean): string[] {
  const at = args.indexOf('--disallowedTools');
  if (!/(^|[\\/])claude(\.exe)?$/i.test(command.trim()) || at < 0) return args;

  const listed = (args[at + 1] ?? '').split(',').map((t) => t.trim()).filter(Boolean);
  const next = research
    ? listed.filter((t) => !WEB_TOOLS.includes(t))
    : [...listed, ...WEB_TOOLS.filter((t) => !listed.includes(t))];

  if (next.join(',') === listed.join(',')) return args;

  const out = [...args];
  // Nothing left to deny: drop the flag rather than pass it an empty list.
  if (next.length === 0) out.splice(at, 2);
  else out[at + 1] = next.join(',');
  return out;
}
