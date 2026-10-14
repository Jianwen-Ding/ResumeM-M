/**
 * A screenshot sent as a data URL, checked to be the image it says it is.
 *
 * The type in a data URL is whatever the sender wrote, and a screenshot tool
 * that saves a JPEG as `.png` is common. So the first bytes decide, as they do
 * for the bug-report inbox (`bug-reports.ts`, which uses this too): PNG's
 * eight-byte signature, JPEG's FF D8 FF, or WebP's RIFF…WEBP. Anything else
 * is refused rather than stored under a name that lies about it.
 */
export interface Screenshot {
  extension: 'png' | 'jpg' | 'webp';
  bytes: Buffer;
}

const DATA_URL = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/;
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/** The image in a data URL, or undefined when it is not a PNG, JPEG or WebP whose bytes agree. */
export function decodeScreenshot(image: unknown): Screenshot | undefined {
  const match = typeof image === 'string' ? DATA_URL.exec(image) : null;
  if (!match) return undefined;
  const bytes = Buffer.from(match[2]!, 'base64');
  const kind = match[1]!;
  const valid =
    kind === 'png'
      ? bytes.subarray(0, 8).equals(PNG)
      : kind === 'jpeg'
        ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
        : bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
  if (!valid) return undefined;
  return { extension: kind === 'jpeg' ? 'jpg' : (kind as 'png' | 'webp'), bytes };
}
