import { beforeEach, describe, expect, it } from 'vitest';
import { forgetModels, listModels, modelsInHelp } from '../src/ai/models.js';

/*
 * Asking a CLI what models it takes, instead of remembering.
 *
 * The list in `presets.ts` is written by hand, and a hand-written list of
 * models is stale the week after it is written. It already was: the Claude CLI
 * on this machine documents `fable`, `opus` and `sonnet`, and the list said
 * `opus`, `sonnet`, `haiku`. Somebody picking from the buttons was picking
 * from last quarter.
 *
 * There is no listing command to call, and that is worth stating rather than
 * papering over: `claude` has no `models` subcommand, and `/models` is
 * something its interactive client understands rather than the executable —
 * put through `-p` it is a prompt, and the model answers it in conversation.
 * ("The `/models` command isn't available in this session", verbatim.) So the
 * question goes to the one interface all of these do have and do keep
 * current, which is `--help`.
 */

/** The real thing, abbreviated, from `claude --help` on this machine. */
const CLAUDE_HELP = `
Usage: claude [options] [command] [prompt]

Options:
  --mcp-config <configs...>             Load MCP servers from JSON files
  --model <model>                       Model for the current session. Provide
                                        an alias for the latest model (e.g.
                                        'fable', 'opus', or 'sonnet') or a
                                        model's full name (e.g.
                                        'claude-fable-5').
  -n, --name <name>                     Set a display name for this session
                                        (shown in the prompt box, /resume
                                        picker, and terminal title)
  --no-chrome                           Disable Claude in Chrome integration
`;

describe('reading model names out of a CLI’s help', () => {
  it('finds the aliases and the full name the help offers', () => {
    expect(modelsInHelp(CLAUDE_HELP).sort()).toEqual(['claude-fable-5', 'fable', 'opus', 'sonnet']);
  });

  /*
   * The paragraph wraps over five lines and the names are spread across three
   * of them, so anything reading line by line finds one of the four.
   */
  it('reads the whole wrapped paragraph, not one line of it', () => {
    expect(modelsInHelp(CLAUDE_HELP)).toContain('claude-fable-5');
  });

  it('stops at the next flag, so a neighbour cannot contribute a name', () => {
    // "/resume" and the words under --name are in the next entry down.
    expect(modelsInHelp(CLAUDE_HELP)).not.toContain('resume');
    expect(modelsInHelp(CLAUDE_HELP).some((m) => m.includes('picker'))).toBe(false);
  });

  it('takes the short-and-long spelling of the flag', () => {
    const help = "  -m, --model <name>   Pick a model, e.g. 'fast' or 'careful'.\n  -v, --verbose\n";
    expect(modelsInHelp(help).sort()).toEqual(['careful', 'fast']);
  });

  /*
   * Quoted words beside the model flag that are plainly not models. Wrong in
   * this direction costs a button nobody presses; the field takes anything
   * typed either way.
   */
  it('refuses the placeholder and the stock advice', () => {
    const help = `  --model <model>   Pass a 'model' name, or 'default' for the 'latest' one.\n  --other\n`;
    expect(modelsInHelp(help)).toEqual([]);
  });

  it('refuses a quoted phrase, which is prose rather than a name', () => {
    const help = `  --model <model>   For example 'the fastest one available'.\n  --other\n`;
    expect(modelsInHelp(help)).toEqual([]);
  });

  it('says nothing when the help has no model flag at all', () => {
    expect(modelsInHelp('Usage: thing [options]\n  --verbose  Say more\n')).toEqual([]);
    expect(modelsInHelp('')).toEqual([]);
  });
});

describe('asking the configured command', () => {
  beforeEach(() => forgetModels());

  it('prefers what the command said over what this project remembers', async () => {
    const found = await listModels('claude', async () => CLAUDE_HELP);
    expect(found.from).toBe('cli');
    expect(found.models).toContain('fable');
  });

  /*
   * The important one. A CLI that is not installed, hangs, or writes its help
   * somewhere unexpected must leave the picker exactly as it was before any of
   * this existed.
   */
  it('falls back to the written suggestions when the command cannot be asked', async () => {
    const found = await listModels('claude', async () => {
      throw new Error('spawn claude ENOENT');
    });
    expect(found.from).toBe('suggestions');
    expect(found.models.length).toBeGreaterThan(0);
  });

  it('falls back when the command answers with nothing useful', async () => {
    const found = await listModels('claude', async () => 'Usage: claude [options]\n');
    expect(found.from).toBe('suggestions');
    expect(found.models).toEqual(['opus', 'sonnet', 'haiku']);
  });

  it('gives an empty answer for a command it has never heard of, rather than throwing', async () => {
    const found = await listModels('not-a-real-cli', async () => {
      throw new Error('nope');
    });
    expect(found).toEqual({ models: [], from: 'suggestions' });
  });

  it('answers for a path to a particular build, not only a bare name', async () => {
    const found = await listModels('/opt/homebrew/bin/claude', async () => CLAUDE_HELP);
    expect(found.from).toBe('cli');
  });

  /*
   * Opening Settings redraws the buttons on every keystroke in the command
   * box. Running the CLI that often would be absurd.
   */
  it('asks once and remembers the answer', async () => {
    let asked = 0;
    const exec = async () => {
      asked++;
      return CLAUDE_HELP;
    };
    await listModels('claude', exec);
    await listModels('claude', exec);
    await listModels('claude', exec);
    expect(asked).toBe(1);
  });

  it('asks again after being told to forget', async () => {
    let asked = 0;
    const exec = async () => {
      asked++;
      return CLAUDE_HELP;
    };
    await listModels('claude', exec);
    forgetModels();
    await listModels('claude', exec);
    expect(asked).toBe(2);
  });

  it('asks nothing at all for an empty command', async () => {
    let asked = 0;
    const found = await listModels('', async () => {
      asked++;
      return CLAUDE_HELP;
    });
    expect(asked).toBe(0);
    expect(found.from).toBe('suggestions');
  });
});
