/**
 * Two options that say the same thing.
 *
 * A skills group is a list of options and so is a list bullet — "Unity,
 * Unreal, Godot" — and nothing stopped the same one going in twice. It is an
 * easy thing to do: the groups are long, the add dialog shows none of them,
 * and a technology added to "Engines" six months ago is not something anybody
 * remembers. What it produces is a resume line reading "Unity, Unreal, Unity",
 * which is the sort of mistake a reader notices and the writer never does.
 *
 * The rule is enforced where every writer passes rather than in the dialog:
 * the editor, the HTTP API, the CLI and the MCP authoring tools all write
 * through the store, and a rule in one of them is a rule three ways round.
 *
 * What it is *not* is a rule about what a store may contain. Checking on load
 * would make a save that already holds a duplicate — written by hand, or by
 * an older build — impossible to open, and the fix for a resume you cannot
 * open is not a better error message. So this compares a write against what
 * is already there and refuses only what the write would *add*: a store with
 * "Unity" twice in it goes on saving, and does not acquire a third.
 */

/**
 * What two options have to share to be the same one.
 *
 * Case and spacing, because "unity" and "Unity " are the same technology
 * typed twice. Not punctuation: "Node" and "Node.js" are two names somebody
 * might deliberately keep apart, and a rule that merges them is a rule that
 * deletes a decision.
 */
export function optionKey(text: unknown): string {
  return String(text ?? '')
    .normalize('NFC')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export interface Option {
  id: string;
  text?: unknown;
}

/** Every key that appears more than once, and the ids that carry it. */
export function repeatedIn(items: readonly Option[]): Map<string, string[]> {
  const seen = new Map<string, string[]>();
  for (const item of items ?? []) {
    const key = optionKey(item?.text);
    if (!key) continue;
    seen.set(key, [...(seen.get(key) ?? []), item.id]);
  }
  return new Map([...seen].filter(([, ids]) => ids.length > 1));
}

/**
 * The options this write would newly repeat, as the text a person would read.
 *
 * `before` is what the store holds; a key already repeated there is somebody
 * else's problem and stays theirs.
 */
export function newlyRepeated(before: readonly Option[], after: readonly Option[]): string[] {
  const had = repeatedIn(before);
  const out: string[] = [];
  for (const [key, ids] of repeatedIn(after)) {
    if (had.has(key)) continue;
    const said = (after.find((i) => i.id === ids[0])?.text ?? key) as string;
    out.push(String(said));
  }
  return out;
}

/**
 * "Unity" — or "Unity and Godot", or "Unity, Godot and Unreal".
 *
 * A refusal that names one of three repeats and leaves the others to be
 * found one save at a time is a refusal somebody meets three times.
 */
export function andList(items: readonly string[]): string {
  const said = items.map((i) => `"${i}"`);
  if (said.length <= 1) return said[0] ?? '';
  return `${said.slice(0, -1).join(', ')} and ${said[said.length - 1]}`;
}
