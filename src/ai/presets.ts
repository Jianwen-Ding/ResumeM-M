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

/**
 * How one CLI spells "use this model" or "think this hard".
 *
 * Declarative rather than a function, because the whole preset list is sent to
 * the editor as JSON and a function would not survive the trip. `join: '='`
 * is for the CLIs that want `--flag=value` as a single argument; the default
 * is two arguments.
 */
export interface AiSwitch {
  flag: string;
  join?: '=' | ' ';
}

export interface AiPreset {
  /** Shown in the picker. */
  label: string;
  command: string;
  args: string[];
  /** One line on what this preset does about safety, for the UI to show. */
  note: string;
  /** What changes when the AI is allowed to look things up. */
  researchNote?: string;
  /**
   * How to name a model, and which names are worth offering.
   *
   * The suggestions are a starting list, not a closed one — every one of these
   * CLIs gains models faster than this file can be edited, so the editor's box
   * is a text field with these as a datalist rather than a dropdown that would
   * go stale and start refusing things that work.
   */
  model?: AiSwitch & { suggestions: string[] };
  /**
   * How to ask for more or less thinking, where the CLI has a way to say it.
   *
   * Deliberately absent for the ones that do not. Inventing a flag is how a
   * command stops working entirely, which is a worse outcome than the model
   * simply thinking as much as it would have anyway — and the request goes
   * into the prompt either way, which is the part that always works.
   */
  effort?: AiSwitch & { values: Record<AiEffort, string> };
}

export type AiEffort = 'low' | 'medium' | 'high';

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
    /*
     * Every tool denied, not only the ones that write.
     *
     * The deny list used to be Bash, Write, Edit and the web — which left
     * reading. This tool asks a model for a paragraph of prose and gives it
     * the whole prompt on stdin; there is nothing it needs to look at, and a
     * model that can look will, because looking is usually the right instinct.
     * What it looked at was the machine: one glob of a home directory is
     * enough for macOS to ask the user whether ResumeM-M may read their Music
     * library, which is a baffling thing to be asked while writing a cover
     * letter. And in headless mode a tool that needs a permission nobody can
     * grant is auto-denied, which is how a run produced nothing at all.
     *
     * Research adds the two web tools back, and only those — see
     * `applyResearch`. Nothing else is ever put back.
     */
    args: ['-p', '--add-dir', '{sandbox}', '--disallowedTools', 'Bash,BashOutput,KillShell,Write,Edit,NotebookEdit,Read,Glob,Grep,Task,TodoWrite,SlashCommand,WebFetch,WebSearch'],
    note: 'Runs with every tool denied: it is asked for text and can reach for nothing.',
    researchNote: 'Web search and fetch are allowed; nothing else changes.',
    model: { flag: '--model', suggestions: ['opus', 'sonnet', 'haiku'] },
    // Claude Code has no reasoning-effort switch; the ask goes in the prompt.
    
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
    /*
     * `--output-last-message` is the third: Codex prints its whole session to
     * stdout — every turn, the reasoning, and a "tokens used" line at the end
     * — and this writes the final message, and only that, to a file. Reading
     * the transcript back and hoping to find the answer in it is how another
     * company's quoted cover letter once got saved as this one's.
     */
    args: [
      'exec',
      '--sandbox',
      'read-only',
      '--skip-git-repo-check',
      '--cd',
      '{sandbox}',
      '--output-last-message',
      '{sandbox}/last-message.txt',
      '{promptText}',
    ],
    note: 'Runs in Codex’s own read-only sandbox, in a scratch directory.',
    model: { flag: '--model', suggestions: ['gpt-5-codex', 'gpt-5', 'o4-mini'] },
    /*
     * Codex takes arbitrary config overrides with `-c key=value`, and
     * reasoning effort is one of them. This is the only preset here with a
     * real switch for it.
     */
    effort: {
      flag: '-c',
      values: { low: 'model_reasoning_effort=low', medium: 'model_reasoning_effort=medium', high: 'model_reasoning_effort=high' },
    },
  },
  {
    label: 'Gemini CLI',
    command: 'gemini',
    // Gemini takes the prompt inline after -p and writes the answer to stdout.
    args: ['-p', '{promptText}'],
    note: 'Prompt passed inline; nothing is written anywhere.',
    model: { flag: '--model', suggestions: ['gemini-2.5-pro', 'gemini-2.5-flash'] },
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
    model: { flag: '--model', suggestions: [] },
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

  if (named(/(^|[\\/])codex(\.exe)?$/i) && args.includes('exec')) {
    const out = [...args];
    // Refuses to start outside a git repository unless told not to check.
    if (!out.includes('--skip-git-repo-check')) out.splice(out.indexOf('exec') + 1, 0, '--skip-git-repo-check');
    /*
     * Without this the answer has to be found inside Codex's printed session
     * — every turn of it, and a "tokens used" line at the end — which is how
     * a letter Codex had quoted from the corpus once got saved as this
     * application's. Asking for the final message by itself is a file Codex
     * writes on purpose, and it costs one flag.
     */
    if (!out.some((a) => a === '--output-last-message' || a === '-o' || a.startsWith('--output-last-message='))) {
      /*
       * In front of the prompt, which Codex takes as a positional: anything
       * after it is read as more prompt.
       */
      const promptAt = out.findIndex((a) => a === '{promptText}' || a === '{prompt}');
      const at = promptAt < 0 ? out.length : promptAt;
      out.splice(at, 0, '--output-last-message', '{sandbox}/last-message.txt');
    }
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
    let out = [...args];
    const after = out.slice(out.indexOf('--disallowedTools') + 2);
    if (after.length === 1 && (after[0] === '{prompt}' || after[0] === '{promptText}')) {
      out = out.slice(0, -1);
    }

    /*
     * A config saved before the deny list covered reading keeps the old one
     * forever, and that is the list that let the model go looking at the
     * machine. Widened in place, so a research setting or a flag the user
     * added by hand survives.
     */
    const at = out.indexOf('--disallowedTools');
    let end = at + 1;
    while (end < out.length && !out[end]!.startsWith('-')) end++;
    const listed = new Set(
      out
        .slice(at + 1, end)
        .flatMap((token) => token.split(','))
        .map((t) => t.trim())
        .filter(Boolean),
    );
    if (listed.has('Bash') && !listed.has('Read')) {
      // Research is the one thing allowed to have removed the web tools, so
      // what it took out stays out.
      const researching = !listed.has('WebFetch');
      for (const tool of CONFINED_TOOLS) {
        if (researching && WEB_TOOLS.includes(tool)) continue;
        listed.add(tool);
      }
      out.splice(at + 1, end - at - 1, [...listed].join(','));
    }
    return out;
  }
  return args;
}


/* ------------------------------------------------------------------ *
 * Looking things up                                                   *
 * ------------------------------------------------------------------ */

/** The tools a CLI needs in order to read anything on the web. */
const WEB_TOOLS = ['WebFetch', 'WebSearch'];

/**
 * Everything the confined preset denies.
 *
 * Named here rather than only in the preset, so `repairAiArgs` can widen a
 * config that was saved when the list was shorter — which is every config
 * saved before reading was understood to be the problem.
 */
const CONFINED_TOOLS = 'Bash,BashOutput,KillShell,Write,Edit,NotebookEdit,Read,Glob,Grep,Task,TodoWrite,SlashCommand,WebFetch,WebSearch'.split(',');

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
/**
 * Does this switch actually decide anything for that CLI?
 *
 * Only where the deny list is ours to write. Claude Code is told which tools
 * it may not use, so taking the web ones off that list is what "let it look
 * things up" means; nothing is added that was not there. Every other CLI here
 * is run as it comes, and whether it can reach the web is its own setting, in
 * its own configuration — this tool neither grants it nor takes it away.
 *
 * Which matters because the checkbox is drawn for all of them and its note
 * made a promise in both directions: "it may read about the company" and
 * "off: it works only from the posting and what you have written". The second
 * is the one that would be believed and the one this cannot keep. So the box
 * says whose setting it is.
 */
export function researchIsOurs(command: string): boolean {
  return /(^|[\\/])claude(\.exe)?$/i.test(command.trim());
}

export function applyResearch(command: string, args: string[], research: boolean): string[] {
  if (!researchIsOurs(command)) return args;

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

/**
 * Put the chosen model and effort into an invocation.
 *
 * Applied on load beside `applyResearch`, for the same reason: the saved
 * arguments stay preset-shaped, so switching model does not quietly turn the
 * configuration into a custom one that then drifts out of date with the
 * preset it came from.
 *
 * Only ever touches its own flags, and only for a command it recognises.
 * A hand-written command line with a `--model` already in it is left exactly
 * as written — somebody who typed that meant it.
 */
export function applyModelAndEffort(
  command: string,
  args: string[],
  choice: { model?: string; effort?: AiEffort } = {},
): string[] {
  const preset = AI_PRESETS.find((p) => matchesCommand(p.command, command));
  if (!preset) return args;

  let out = [...args];
  out = setSwitch(out, preset.model, choice.model?.trim() || undefined);
  out = setSwitch(out, preset.effort, choice.effort ? preset.effort?.values[choice.effort] : undefined);
  return out;
}

/** Does this command line name that CLI, with or without a path or a .exe? */
function matchesCommand(name: string, command: string): boolean {
  return new RegExp(`(^|[\\\\/])${name}(\\.exe)?$`, 'i').test(command.trim());
}

/**
 * Set, replace or remove one flag, leaving everything else where it is.
 *
 * Removing when the value is empty is the half that is easy to forget: a
 * model chosen and then cleared has to take its flag with it, or the box says
 * "whatever the CLI defaults to" while the command line still pins one.
 */
function setSwitch(
  args: string[],
  spec: (AiSwitch & { values?: Record<string, string> }) | undefined,
  value: string | undefined,
): string[] {
  if (!spec) return args;
  const out: string[] = [];

  /*
   * Which occurrences of this flag are this switch's to remove.
   *
   * A flag like `--model` is the setting: every `--model` on the line is one
   * of these and replacing it is right. `-c` is not — it is Codex's general
   * config override, and the effort switch is only one of the things people
   * put behind it. Removing every `-c` pair meant that picking an effort
   * silently deleted `-c model_provider=myproxy` off somebody's command line,
   * and clearing the effort afterwards did not bring it back. Measured: the
   * override was gone from the args and nothing said so.
   *
   * So a switch with named values owns only the values it names — matched on
   * the key in front of the `=`, since that is what is being set.
   */
  const owned = spec.values
    ? new Set(Object.values(spec.values).map((v) => v.split('=')[0]))
    : null;
  const mine = (v: string | undefined) => !owned || (v !== undefined && owned.has(v.split('=')[0]!));

  // Drop whatever is there now, in either spelling.
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === spec.flag) {
      const next = args[i + 1];
      if (mine(next)) {
        i++; // and its value
        continue;
      }
      // Somebody else's use of the same flag. Both parts stay where they are.
      out.push(a);
      if (next !== undefined) {
        out.push(next);
        i++;
      }
      continue;
    }
    if (a.startsWith(`${spec.flag}=`)) {
      if (mine(a.slice(spec.flag.length + 1))) continue;
      out.push(a);
      continue;
    }
    out.push(a);
  }

  if (!value) return out;

  /*
   * In front of the prompt, not after it.
   *
   * Three of the four presets pass the prompt as the last argument, and a CLI
   * that takes a positional prompt reads whatever follows it as more prompt —
   * so appending `--model opus` to Codex's line made "opus" part of the
   * posting. Inserted before the first argument that carries the prompt, or
   * at the end when none does.
   */
  const promptAt = out.findIndex((a) => a.includes('{prompt}') || a.includes('{promptText}'));
  const added = spec.join === '=' ? [`${spec.flag}=${value}`] : [spec.flag, value];
  if (promptAt < 0) return [...out, ...added];
  return [...out.slice(0, promptAt), ...added, ...out.slice(promptAt)];
}

/**
 * What to say in the prompt about how hard to think.
 *
 * The flag is the better mechanism and only one CLI here has one, so this is
 * what makes the choice mean something everywhere else. It is a sentence
 * about the work rather than a number, because "reasoning effort: high" means
 * nothing to a model that was never given such a parameter.
 */
export function effortInstruction(effort?: AiEffort): string {
  if (effort === 'low') {
    return 'Work quickly. Take the obvious reading of the posting and the obvious matches in the store; do not weigh every alternative.';
  }
  if (effort === 'high') {
    return 'Take your time with this. Read the whole posting before deciding anything, consider every phrasing that could fit each requirement, and satisfy yourself that a choice is better than what it replaces before making it.';
  }
  return '';
}

/* ------------------------------------------------------------------ *
 * Which model does which job                                          *
 * ------------------------------------------------------------------ */

/**
 * The kinds of work this asks an AI to do.
 *
 * One model for all of it is the wrong shape, and obviously so once the list
 * is written down: tailoring is a selection problem over a fixed inventory
 * and rewards a model that will sit with it; drafting a letter is a writing
 * problem in somebody else's voice; reading a repository and proposing an
 * entry is neither, and is the one that runs while you wait. These are
 * different enough to be worth different answers, and expensive enough that
 * using the careful model for all five is a real cost.
 *
 * Grouped as coarsely as the work allows. Six switches nobody adjusts are
 * worse than three that get used.
 */
export const AI_TASKS = [
  {
    key: 'tailor',
    label: 'Tailoring a resume',
    note: 'Choosing which of your wordings suit a posting, and what order they go in.',
  },
  {
    key: 'write',
    label: 'Writing letters and answers',
    note: 'Drafting a cover letter or an application answer in your voice.',
  },
  {
    key: 'review',
    label: 'Reviewing what you wrote',
    note: 'Reading a resume, a letter or an answer and saying what is weak.',
  },
  {
    key: 'author',
    label: 'Drafting new entries and wordings',
    note: 'Reading a repository or a note and proposing something to add. Runs while you wait.',
  },
] as const;

export type AiTask = (typeof AI_TASKS)[number]['key'];

/** The model this kind of work should use, falling back to the one model. */
export function modelFor(ai: { model?: string; models?: Partial<Record<AiTask, string>> }, task: AiTask): string {
  return (ai.models?.[task] ?? '').trim() || (ai.model ?? '').trim();
}

/**
 * The config a particular kind of work should run with.
 *
 * Returns the same object when nothing differs, so the twelve call sites can
 * wrap themselves in this without anybody wondering whether it costs
 * something.
 */
export function configForTask<T extends { ai: { command: string; args: string[]; model?: string; models?: Partial<Record<AiTask, string>>; effort?: AiEffort } }>(
  config: T,
  task: AiTask,
): T {
  const model = modelFor(config.ai, task);
  if (model === (config.ai.model ?? '').trim()) return config;
  return {
    ...config,
    ai: {
      ...config.ai,
      args: applyModelAndEffort(config.ai.command, config.ai.args, { model, effort: config.ai.effort }),
    },
  };
}
