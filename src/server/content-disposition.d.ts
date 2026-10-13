/**
 * The `content-disposition` package ships no types of its own, and Express
 * depends on it directly — so it is already installed with the server, and
 * this is the one call the server makes into it.
 */
declare module 'content-disposition' {
  function contentDisposition(
    filename?: string,
    options?: { type?: 'attachment' | 'inline' | string; fallback?: string | boolean },
  ): string;
  export default contentDisposition;
}
