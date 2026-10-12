import type { Request, RequestHandler } from 'express';

/**
 * This server is on loopback with no password, so "who is asking" is decided
 * entirely by headers. CORS already says who may *read* a reply. Two things it
 * does not say:
 *
 * DNS rebinding. A page on evil.example can publish a hostname that resolves,
 * on the second lookup, to 127.0.0.1. The browser then treats
 * `http://rebound.evil.example:4600/api/store` as same-origin with the page —
 * so there is no cross-origin request, no preflight, and no CORS header to
 * withhold. The whole store is readable and writable. The defence is the one
 * header the attacker cannot change: the request still carries
 * `Host: rebound.evil.example:4600`, and a server that only answers to its own
 * loopback names simply does not answer.
 *
 * Preflight-free writes. A cross-origin `fetch` with a JSON body is preflighted
 * and dies there, but a form POST, or a `no-cors` fetch sending `text/plain`,
 * is not preflighted at all. The reply is unreadable, which stops nothing when
 * the point of the request is the write: closing the open save, or switching it
 * to another folder, takes no body worth parsing. Those requests still carry an
 * `Origin`, so requiring it to be one of ours is enough.
 *
 * Requests with no `Origin` at all are not browsers — the CLI, the health
 * check, a script — and are left alone. A browser always sends one on a write.
 */

const LOOPBACK = ['127.0.0.1', 'localhost', '[::1]', '::1'];

/** `127.0.0.1:4600` → `127.0.0.1`, and `[::1]:4600` → `[::1]`, leaving bare names alone. */
export function hostName(header: string): string {
  const value = header.trim().toLowerCase();
  if (value.startsWith('[')) return value.slice(0, value.indexOf(']') + 1) || value;
  const colon = value.lastIndexOf(':');
  return colon === -1 ? value : value.slice(0, colon);
}

export interface GuardOptions {
  /** The address the server was told to bind, so a deliberate LAN bind still works. */
  host?: string;
  /** Extra names to answer to, e.g. `RMM_ALLOWED_HOSTS=rmm.local`. */
  allowHosts?: string[];
  /**
   * Whether a request from a browser extension carries a pairing token this
   * server gave out, to that extension. Left out, no extension is paired.
   * See `src/server/pairing.ts`.
   */
  paired?: (token: string | undefined, origin: string | undefined) => boolean;
}

const EXTENSION = /^chrome-extension:\/\/[a-p]{32}$/;
const WRITES = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** The header a paired extension sends its token in. */
export const PAIR_HEADER = 'X-RMM-Pair';

/**
 * A browser asking from somewhere that is not the editor, and not a person
 * following a link: an extension, or a page's subresource. The origin when it
 * says one, `''` when it does not, and `null` for everything else.
 *
 * Chrome leaves `Origin` off a GET an extension makes to a host it holds
 * permission for — measured, from JobHelper's own service worker, with and
 * without `no-cors`, and the reply was readable both times. So "no Origin"
 * is not "not a browser". What every browser request to loopback does carry
 * is `Sec-Fetch-Site`, which no page and no extension can set: `same-origin`
 * from the editor, and `none` or `cross-site` from an extension. The CLI,
 * scripts and tests send no `Sec-Fetch-Site` at all, and are local processes
 * that can read the save off the disk anyway, so they are left alone.
 */
export function foreignCaller(req: Request): string | null {
  const origin = req.headers.origin;
  if (typeof origin === 'string' && origin.startsWith('chrome-extension:')) return origin;
  // A web page's own origin: a write is refused below, and a read is
  // withheld by CORS, as before.
  if (origin) return null;
  const site = req.headers['sec-fetch-site'];
  const mode = req.headers['sec-fetch-mode'];
  if (typeof site === 'string' && site !== 'same-origin' && mode !== 'navigate') return '';
  return null;
}

/**
 * What an unpaired extension may still reach: whether the server is there,
 * how to pair, and the bug-report inbox (which only takes a report in, and is
 * how somebody says pairing does not work).
 */
export function openToUnpaired(method: string, path: string): boolean {
  // As Express routes it: without regard to case, or to a trailing slash.
  const p = path.toLowerCase().replace(/\/+$/, '') || '/';
  if (p === '/health') return method === 'GET' || method === 'HEAD';
  if (method !== 'POST') return false;
  return p === '/api/extension/pair' || p === '/api/bug-reports';
}

export const NOT_PAIRED =
  'This browser extension is not paired with ResumeM-M. In ResumeM-M, open Save & Files → Pair JobHelper, ' +
  'make a code, and enter it in the extension.';

export function localOnly({ host, allowHosts = [], paired = () => false }: GuardOptions = {}): RequestHandler {
  const allowed = new Set([
    ...LOOPBACK,
    // Binding to every interface is a choice to be reachable by whatever name
    // gets you there, so it cannot narrow the list.
    ...(host && !['0.0.0.0', '::'].includes(host) ? [host.toLowerCase()] : []),
    ...allowHosts.map((h) => h.trim().toLowerCase()).filter(Boolean),
  ]);
  const anyHost = host === '0.0.0.0' || host === '::';

  return (req, res, next) => {
    const header = req.headers.host;
    if (!anyHost && (!header || !allowed.has(hostName(header)))) {
      res.status(403).json({
        error:
          `This server answers to ${[...allowed].join(', ')} only, and the request asked for ` +
          `"${header ?? 'nothing'}". Open it at http://127.0.0.1:${req.socket.localPort ?? 4600}/.`,
      });
      return;
    }

    /*
     * An extension, only once it is paired.
     *
     * Every `chrome-extension://` origin was let through, and echoed in CORS,
     * so any extension installed in the browser could read the whole store
     * and write to it. Now the token has to be there and has to be the one
     * this machine gave that extension. The refusal is readable — it says
     * nothing about the save — so the extension can say what to do.
     */
    const foreign = foreignCaller(req);
    let pairedNow = false;
    if (foreign !== null && req.method !== 'OPTIONS') {
      const token = req.headers[PAIR_HEADER.toLowerCase()];
      pairedNow = EXTENSION.test(foreign) || foreign === ''
        ? paired(typeof token === 'string' ? token : undefined, foreign || undefined)
        : false;
      res.locals.extension = { origin: foreign || null, paired: pairedNow };
      /*
       * Everything else is refused, not a list of what holds the save: Express
       * matches `/API/store` to `/api`, and a list is one spelling away from
       * a hole. Nothing an extension legitimately asks for is left out by
       * this — the editor it frames is a navigation, and asks for its own
       * files from its own origin.
       */
      if (!pairedNow && !openToUnpaired(req.method, req.path)) {
        if (EXTENSION.test(foreign)) res.setHeader('Access-Control-Allow-Origin', foreign);
        res.setHeader('Vary', 'Origin');
        res.status(403).json({
          kind: 'not-paired',
          error: token
            ? `${NOT_PAIRED} The pairing this extension has was removed, or was made with another ResumeM-M.`
            : NOT_PAIRED,
        });
        return;
      }
    }

    const origin = req.headers.origin;
    if (origin && WRITES.has(req.method)) {
      let ok = EXTENSION.test(origin) && (pairedNow || openToUnpaired(req.method, req.path));
      if (!ok) {
        try {
          const url = new URL(origin);
          /*
           * And on this server's own port. Any other port on loopback is
           * another program — a dev server, a notebook, a page some tool
           * serves — and a form on it posting here was let through for having
           * the right name, which is the whole of the attack this check is
           * for. The editor is served from here, so its origin is the
           * address the request itself was sent to.
           */
          const own = header ? new URL(`http://${header}`) : undefined;
          const ownPort = own ? Number(own.port || 80) : req.socket.localPort;
          const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
          ok = (url.protocol === 'http:' || url.protocol === 'https:') && allowed.has(url.hostname.toLowerCase()) && port === ownPort;
        } catch {
          ok = false; // `null`, or something that is not a URL at all
        }
      }
      if (!ok) {
        res.status(403).json({ error: 'Only this machine’s editor and the browser extension may change the save.' });
        return;
      }
    }

    next();
  };
}

/**
 * The script policy every reply carries.
 *
 * Nearly everything this server shows was written somewhere else: postings
 * scraped off job boards, a store cloned from somebody's git link, a restored
 * bundle, files dropped into the inbox and served back as assets. The editor
 * builds its DOM from text rather than markup, but a policy is what holds when
 * one place gets that wrong — an SVG asset with a `<script>` in it, a
 * `javascript:` address, an attribute nobody thought of. And a script running
 * here can set `ai.command`, the command this application runs.
 *
 * Scripts only, and only our own: the one inline script in the editor, its
 * import map, is allowed by its hash, read from the page itself so editing it
 * cannot silently break the editor. Styles, images and fetches are left alone.
 */
export function scriptPolicy(indexHtml: string, hash: (text: string) => string): string {
  const inline = [...indexHtml.matchAll(/<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map(
    (m) => `'sha256-${hash(m[1] ?? '')}'`,
  );
  // No `object-src`: the PDFs served here open in Chrome's own viewer, which
  // is an embed, and a policy that stopped it would stop the files opening.
  return [`script-src 'self' ${inline.join(' ')}`.trim(), "base-uri 'none'", FRAME_ANCESTORS].join('; ');
}

/**
 * Who may put these pages inside a frame of their own.
 *
 * Nobody said, so anybody could: any page on the web could load the editor
 * into an invisible frame over a button of its own and have the click land on
 * "Delete variation" instead — the editor is on loopback with no password, so
 * the frame opens already signed in to the whole save.
 *
 * The editor itself (`'self'`), and extension pages, which is where the
 * browser extension shows it in a side panel. By scheme rather than by id: an
 * unpacked extension's id is derived from the folder it was loaded from, so it
 * is different on every machine, and an extension already holds host access
 * to loopback — it can read and write the save directly, so framing it gives
 * one nothing it did not have. What this shuts out is ordinary web pages.
 *
 * Chrome's PDF viewer is an extension too, and is the frame the typeset files
 * open in; it is covered by the same scheme.
 */
export const FRAME_ANCESTORS = "frame-ancestors 'self' chrome-extension:";
