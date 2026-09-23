/**
 * Just enough of the Model Context Protocol to be a tool server.
 *
 * Written out rather than pulled in. MCP over stdio is newline-delimited
 * JSON-RPC 2.0 with five methods, and this is all five of them; an SDK would
 * be a dependency that the macOS build has to snapshot, that has its own
 * release cadence, and that would sit between a bug and the person reading
 * this file. The protocol is small enough that writing it down is cheaper
 * than depending on it.
 *
 * What a client actually sends, in order:
 *
 *   → initialize                    ← capabilities and a name
 *   → notifications/initialized     (no reply: it is a notification)
 *   → tools/list                    ← the tools and their schemas
 *   → tools/call                    ← content, or an error the model reads
 *   → ping                          ← {}
 *
 * Anything else gets a "method not found", which every client tolerates.
 */

import type { Readable, Writable } from 'node:stream';

/**
 * The version we answer with.
 *
 * Clients send the version *they* want and are required to accept a different
 * one back. Echoing theirs would be the friendlier-looking choice and the
 * wrong one: it would claim support for whatever they asked for.
 */
export const PROTOCOL_VERSION = '2024-11-05';

export interface ToolResult {
  /** Text the model reads. */
  text: string;
  /** True when the call failed in a way the model should react to. */
  isError?: boolean;
}

export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema for the arguments. */
  inputSchema: Record<string, unknown>;
  run: (args: Record<string, unknown>) => ToolResult | Promise<ToolResult>;
}

interface Request {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

const RESULT = (id: Request['id'], result: unknown) => ({ jsonrpc: '2.0', id, result });
const ERROR = (id: Request['id'], code: number, message: string) => ({ jsonrpc: '2.0', id, error: { code, message } });

/**
 * Answer one request.
 *
 * Returns `null` for a notification, which by the JSON-RPC rules must produce
 * no reply at all — writing one back is how a client ends up trying to match
 * a response to a request it never made.
 */
export async function handle(
  request: Request,
  tools: ToolDefinition[],
  serverInfo: { name: string; version: string },
): Promise<unknown | null> {
  /*
   * A batch — `[{...}, {...}]` rather than one object — is valid JSON-RPC and
   * answered with silence here, because destructuring an array gives `id`
   * `undefined` the same as a notification does, and a notification gets no
   * reply by design. The difference matters: a notification is silence the
   * client asked for, and this is silence for a request it is still waiting
   * on. None of the five methods above batch anyone sends over this stdio
   * transport, so rather than implement it, this says so — which is still an
   * answer, and the one thing a hung client cannot get from saying nothing.
   */
  if (Array.isArray(request)) {
    return ERROR(null, -32600, 'Batch requests are not supported; send one request per line.');
  }

  const { id, method, params } = request;

  if (method === 'initialize') {
    return RESULT(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo,
    });
  }

  // Notifications carry no id and get no answer.
  if (method?.startsWith('notifications/')) return null;

  if (method === 'ping') return RESULT(id, {});

  if (method === 'tools/list') {
    return RESULT(id, {
      tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
    });
  }

  if (method === 'tools/call') {
    const name = typeof params?.name === 'string' ? params.name : '';
    const tool = tools.find((t) => t.name === name);
    if (!tool) {
      /*
       * A protocol error, not a tool error, so the model never sees it — and
       * a model that called a tool it invented would then get nothing back
       * and try again identically. Answering as a failed *call* puts the list
       * of real names in front of it instead.
       */
      return RESULT(id, {
        content: [{ type: 'text', text: `There is no tool called "${name}". The tools are: ${tools.map((t) => t.name).join(', ')}.` }],
        isError: true,
      });
    }
    const args = (params?.arguments as Record<string, unknown>) ?? {};
    try {
      const result = await tool.run(args);
      return RESULT(id, { content: [{ type: 'text', text: result.text }], isError: Boolean(result.isError) });
    } catch (err) {
      // The same reasoning: a thrown error is still something the model can
      // act on, and it can only act on what comes back as content.
      return RESULT(id, {
        content: [{ type: 'text', text: `${name} failed: ${(err as Error).message}` }],
        isError: true,
      });
    }
  }

  if (id === undefined || id === null) return null;
  return ERROR(id, -32601, `Method not found: ${method}`);
}

/**
 * Read newline-delimited JSON off one stream and write answers to another.
 *
 * Buffered by hand because a single `data` event is not a single message:
 * a large `tools/list` reply arrives in pieces, and two small requests arrive
 * together. Splitting on newlines and keeping the remainder is the whole of
 * what the framing needs.
 */
export function serve(
  input: Readable,
  output: Writable,
  tools: ToolDefinition[],
  serverInfo: { name: string; version: string },
): Promise<void> {
  return new Promise((resolve) => {
    let buffer = '';
    // Answers go out in the order the requests came in, which a client is
    // entitled to but not required to rely on — and which costs nothing here.
    let queue: Promise<void> = Promise.resolve();

    input.setEncoding('utf8');
    input.on('data', (chunk: string) => {
      buffer += chunk;
      let at = buffer.indexOf('\n');
      while (at >= 0) {
        const line = buffer.slice(0, at).trim();
        buffer = buffer.slice(at + 1);
        at = buffer.indexOf('\n');
        if (!line) continue;

        queue = queue.then(async () => {
          let request: Request;
          try {
            request = JSON.parse(line) as Request;
          } catch {
            output.write(`${JSON.stringify(ERROR(null, -32700, 'Parse error'))}\n`);
            return;
          }
          const reply = await handle(request, tools, serverInfo);
          if (reply !== null) output.write(`${JSON.stringify(reply)}\n`);
        });
      }
    });

    input.on('end', () => queue.then(() => resolve()));
    input.on('close', () => queue.then(() => resolve()));
  });
}
