import type { RequestHandler } from 'express';

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
}

const EXTENSION = /^chrome-extension:\/\/[a-p]+$/;
const WRITES = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function localOnly({ host, allowHosts = [] }: GuardOptions = {}): RequestHandler {
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

    const origin = req.headers.origin;
    if (origin && WRITES.has(req.method)) {
      let ok = EXTENSION.test(origin);
      if (!ok) {
        try {
          const url = new URL(origin);
          ok = (url.protocol === 'http:' || url.protocol === 'https:') && allowed.has(url.hostname.toLowerCase());
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
  return [`script-src 'self' ${inline.join(' ')}`.trim(), "base-uri 'none'"].join('; ');
}
