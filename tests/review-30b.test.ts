/**
 * Round 30b: a phone number named "number ID" or "user id" in a log line, and
 * a port that needs permission reported as one already in use.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import net from 'node:net';
import { scrubText } from '../src/errorlog/scrub.js';
import { portFree, portTrouble, startServer } from '../src/server/index.js';

// 555-01xx: numbers set aside for fiction.
describe('a phone number with a word for the number between the phone word and "id"', () => {
  it('is taken out', () => {
    for (const line of [
      'Phone number ID 6175550134',
      'Mobile number id 6175550134',
      'Phone no. id: 6175550134',
      'whatsapp user id 6175550134',
      'cell number id=6175550134',
      'Phone # id 6175550134',
      'phone nr id 6175550134',
    ]) {
      expect(scrubText(line), line).not.toContain('6175550134');
    }
  });

  it('leaves a machine id with no phone word next to it', () => {
    for (const line of [
      'API call failed for job 1234567890',
      'call stack: commit 4155550134',
      'Mobile build 2024061512',
      'tel: link handler pid 1234567890',
      'user id 1234567890 not found',
      'number of jobs 1234567890',
      'phone sync worker pid 1234567890 exited',
    ]) {
      expect(scrubText(line), line).toBe(line);
    }
    expect(scrubText('Phone number ID 6175550134 then job 1234567890')).toBe('Phone number ID [phone number] then job 1234567890');
  });
});

describe('a port that needs permission', () => {
  afterEach(() => vi.restoreAllMocks());

  /** `net.createServer` answering every listen with `code`. */
  const listenFails = (code: string) =>
    vi.spyOn(net, 'createServer').mockImplementation((() => {
      const probe = new EventEmitter() as EventEmitter & { listen: () => void; close: (cb?: () => void) => void };
      probe.listen = () => queueMicrotask(() => probe.emit('error', Object.assign(new Error(code), { code })));
      probe.close = (cb) => cb?.();
      return probe;
    }) as unknown as typeof net.createServer);

  it('is told from one in use', async () => {
    listenFails('EACCES');
    expect(await portTrouble(80)).toBe('denied');
    expect(await portFree(80)).toBe(false);
    vi.restoreAllMocks();
    listenFails('EADDRINUSE');
    expect(await portTrouble(4600)).toBe('in-use');
  });

  it('is refused by the server in words about permission, not about another server', async () => {
    listenFails('EACCES');
    const err = (await startServer({ port: 80 }).catch((e: unknown) => e)) as NodeJS.ErrnoException;
    expect(err.code).toBe('EACCES');
    expect(err.message).toMatch(/needs permission/);
    expect(err.message).toMatch(/above 1024 with --port/);
    expect(err.message).not.toMatch(/already in use/);
  });

  it('a free port is free', async () => {
    const holder = net.createServer();
    await new Promise<void>((resolve) => holder.listen(0, '127.0.0.1', resolve));
    const port = (holder.address() as net.AddressInfo).port;
    expect(await portTrouble(port)).toBe('in-use');
    await new Promise<void>((resolve) => holder.close(() => resolve()));
    expect(await portTrouble(port)).toBeUndefined();
  });
});
