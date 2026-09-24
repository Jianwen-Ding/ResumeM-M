/**
 * Text without a leading byte-order mark.
 *
 * Notepad and a good many Windows tools start a UTF-8 file with U+FEFF, and
 * the YAML parser read it as content: a hand-edited `skills.yaml` became "not
 * valid YAML" and the save would not open. It says nothing about the text.
 */
export function withoutBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}
