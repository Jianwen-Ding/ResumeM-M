/**
 * The coding-agent CLIs people actually have, and how each one wants to be
 * called.
 *
 * These lived in the editor's JavaScript, which meant the command line could
 * not offer them, nothing could test them, and a preset that stopped working
 * would only be discovered by a user. They are a fact about the external
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
  {
    label: 'Antigravity (agy)',
    command: 'agy',
    /*
     * agy 1.1.28 requires a string value for --print; it does not read a text
     * prompt from stdin. Attach the value so leading dashes in a prompt cannot
     * be mistaken for another flag. A filename is just literal text.
     *
     * `--disable-slash-commands` is gone because it cancelled the flag that
     * matters. agy said so itself — "warning: --mode plan has no effect while
     * slash command expansion is disabled" — and then, no longer in plan mode,
     * reached for a tool needing the `command` permission, which headless mode
     * cannot prompt for and therefore refused. The run produced nothing, every
     * time, and the advice it printed was to allow the command or to re-run
     * with every permission check disabled. Plan mode is what stops it wanting
     * the permission in the first place, so plan mode stays and the flag that
     * silently disabled it does not.
     */
    args: ['--mode', 'plan', '--sandbox', '--output-format', 'text', '--print={promptText}'],
    note: 'Runs in plan mode, which cannot run commands, in a scratch directory.',
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
 * before a preset was fixed keeps the broken arguments forever. Repair known
 * invocation errors here: Codex's git check in the scratch directory, Claude's
 * prompt swallowed by its deny list, and agy's literal prompt-file path.
 * Preserve custom flags and the configured permission restrictions.
 */
export function repairAiArgs(command: string, args: string[]): string[] {
  const named = (re: RegExp) => re.test(command.trim());

  // The old README suggested -p {prompt} for any CLI. agy treats that path
  // as the prompt itself, so give print mode the actual prompt text instead.
  if (named(/(^|[\\/])agy(\.exe)?$/i)) {
    /*
     * `--disable-slash-commands` silently cancels `--mode plan`, and without
     * plan mode agy reaches for a tool needing a permission that headless mode
     * cannot prompt for — so every run produced nothing at all. A preset is
     * copied when it is chosen rather than referenced, so a config saved before
     * this was understood keeps the combination forever.
     */
    let out = [...args];
    if (out.includes('--mode') && out.includes('--disable-slash-commands')) {
      out = out.filter((a) => a !== '--disable-slash-commands');
    }
    const printFlags = ['-p', '--print', '--prompt'];
    for (let i = 0; i < out.length; i++) {
      if (printFlags.includes(out[i]!) && ['{prompt}', '{promptText}'].includes(out[i + 1] ?? '')) {
        out.splice(i, 2, `${out[i]}={promptText}`);
      } else if (printFlags.some((flag) => out[i] === `${flag}={prompt}`)) {
        out[i] = out[i]!.replace('{prompt}', '{promptText}');
      }
    }
    return out;
  }

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
  if (!/(^|[\\/])claude(\.exe)?$/i.test(command.trim())) return args;

  const at = args.indexOf('--disallowedTools');
  if (at < 0) {
    /*
     * No deny list at all. With research off, that is a Claude invocation with
     * the web wide open, so say what is denied — and it is also how the flag
     * comes back after the branch below has legitimately removed it. Without
     * this, switching research off could never restore what switching it on
     * took away.
     */
    return research ? args : [...args, '--disallowedTools', WEB_TOOLS.join(',')];
  }

  /*
   * `--disallowedTools` takes a *list*, and a list may be written either way:
   * `--disallowedTools Bash,Write` or `--disallowedTools Bash Write Edit`. The
   * settings box is whitespace-separated, so people write the second.
   *
   * Reading only args[at + 1] saw one entry of it. With research on, that one
   * entry was WebFetch, the remainder came out empty, and `splice(at, 2)`
   * removed the flag together with its first value — leaving Bash, Write and
   * Edit no longer denied and sitting in the command line as positional
   * arguments. The flag was then gone, so nothing could put it back.
   */
  let end = at + 1;
  while (end < args.length && !args[end]!.startsWith('-')) end++;
  const listed = args
    .slice(at + 1, end)
    .flatMap((token) => token.split(','))
    .map((t) => t.trim())
    .filter(Boolean);

  const next = research
    ? listed.filter((t) => !WEB_TOOLS.includes(t))
    : [...listed, ...WEB_TOOLS.filter((t) => !listed.includes(t))];

  if (next.join(',') === listed.join(',') && end === at + 2) return args;

  const out = [...args];
  // Nothing left to deny: drop the flag rather than pass it an empty list —
  // and drop every one of its values with it, not just the first.
  if (next.length === 0) out.splice(at, end - at);
  else out.splice(at + 1, end - at - 1, next.join(','));
  return out;
}
