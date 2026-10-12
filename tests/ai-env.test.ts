import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { envForAgent } from '../src/ai/env.js';
import { runAgent } from '../src/ai/agent.js';
import { captureModelPicker } from '../src/ai/models.js';
import { DEFAULT_CONFIG, type StoreConfig } from '../src/model/types.js';

/*
 * The AI CLIs were started with the server's whole environment, so every
 * token in the shell that ran `rmm serve` reached a program a job posting's
 * text can steer. These pin the allow-list that replaced it.
 */

const SECRETS = {
  GITHUB_TOKEN: 'ghp_planted',
  AWS_SECRET_ACCESS_KEY: 'aws-planted',
  AWS_ACCESS_KEY_ID: 'AKIAPLANTED',
  NPM_TOKEN: 'npm-planted',
  DATABASE_URL: 'postgres://user:pw@db/prod',
  NODE_OPTIONS: '--require /somewhere/loader.cjs',
  GIT_ASKPASS: '/usr/bin/askpass',
};

const NEEDED = {
  PATH: '/usr/bin:/bin',
  HOME: '/home/someone',
  LANG: 'en_US.UTF-8',
  LC_ALL: 'en_US.UTF-8',
  XDG_CONFIG_HOME: '/home/someone/.config',
  ANTHROPIC_API_KEY: 'sk-ant-kept',
  CLAUDE_CODE_USE_VERTEX: '1',
  OPENAI_API_KEY: 'sk-openai-kept',
  CODEX_HOME: '/home/someone/.codex',
  GEMINI_API_KEY: 'gemini-kept',
  GOOGLE_API_KEY: 'google-kept',
  GOOGLE_GENAI_USE_VERTEXAI: 'true',
  GOOGLE_CLOUD_PROJECT: 'proj',
  GOOGLE_APPLICATION_CREDENTIALS: '/home/someone/adc.json',
  HTTP_PROXY: 'http://proxy:3128',
  HTTPS_PROXY: 'http://proxy:3128',
  NO_PROXY: 'localhost',
  http_proxy: 'http://proxy:3128',
  https_proxy: 'http://proxy:3128',
  no_proxy: 'localhost',
  ALL_PROXY: 'socks5://proxy:1080',
  SSL_CERT_FILE: '/etc/ssl/ca.pem',
  NODE_EXTRA_CA_CERTS: '/etc/ssl/ca.pem',
  REQUESTS_CA_BUNDLE: '/etc/ssl/ca.pem',
};

describe('envForAgent', () => {
  it('drops tokens the CLIs never needed and keeps what they do', () => {
    const out = envForAgent({ ...SECRETS, ...NEEDED });
    for (const name of Object.keys(SECRETS)) expect(out, name).not.toHaveProperty(name);
    expect(out).toEqual(NEEDED);
  });

  it('keeps the Windows spellings it is given, in their own case', () => {
    const out = envForAgent({ Path: 'C:\\Windows', SystemRoot: 'C:\\Windows', APPDATA: 'C:\\x', GITHUB_TOKEN: 't' });
    expect(out).toEqual({ Path: 'C:\\Windows', SystemRoot: 'C:\\Windows', APPDATA: 'C:\\x' });
  });

  it('lets AWS through only when Claude Code is told to use Bedrock', () => {
    const aws = { AWS_REGION: 'us-east-1', AWS_PROFILE: 'bedrock', AWS_SECRET_ACCESS_KEY: 'k', AWS_SESSION_TOKEN: 's' };

    expect(envForAgent({ ...aws })).toEqual({});
    expect(envForAgent({ ...aws, CLAUDE_CODE_USE_BEDROCK: '0' })).toEqual({ CLAUDE_CODE_USE_BEDROCK: '0' });
    expect(envForAgent({ ...aws, CLAUDE_CODE_USE_BEDROCK: '' })).toEqual({ CLAUDE_CODE_USE_BEDROCK: '' });

    const on = envForAgent({ ...aws, CLAUDE_CODE_USE_BEDROCK: '1', GITHUB_TOKEN: 't' });
    expect(on).toEqual({ ...aws, CLAUDE_CODE_USE_BEDROCK: '1' });
  });

  it('passes the extra names the owner lists in RMM_AI_ENV_PASS, and only those', () => {
    const out = envForAgent({
      RMM_AI_ENV_PASS: ' NODE_OPTIONS , MY_GATEWAY_KEY,,',
      NODE_OPTIONS: '--max-old-space-size=8192',
      MY_GATEWAY_KEY: 'kept',
      MY_GATEWAY_KEY_2: 'not named',
      GITHUB_TOKEN: 't',
    });
    expect(out).toEqual({ NODE_OPTIONS: '--max-old-space-size=8192', MY_GATEWAY_KEY: 'kept' });
  });

  it('reads process.env when it is given nothing', () => {
    expect(envForAgent().PATH).toBe(process.env.PATH);
  });
});

/*
 * And end to end: a stand-in CLI that prints the environment it was started
 * with, run the way the app runs the real ones.
 */
describe('what a launched CLI actually sees', () => {
  const planted = { GITHUB_TOKEN: 'ghp_planted_in_server_env', ANTHROPIC_API_KEY: 'sk-ant-planted' };
  const saved: Record<string, string | undefined> = {};
  const dirs: string[] = [];

  function plant() {
    for (const [k, v] of Object.entries(planted)) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
  }

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  /** A shim called `claude` that prints its environment as JSON. */
  function fakeClaude(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rmm-env-cli-'));
    dirs.push(dir);
    const script = path.join(dir, 'print-env.cjs');
    fs.writeFileSync(script, 'process.stdout.write(JSON.stringify(process.env));\n', 'utf8');
    const shim = path.join(dir, 'claude');
    fs.writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, { mode: 0o755 });
    return shim;
  }

  const config = (command: string): StoreConfig => ({
    ...DEFAULT_CONFIG,
    ai: { ...DEFAULT_CONFIG.ai, enabled: true, command, args: ['-p', '{prompt}'], timeoutMs: 20_000 },
  });

  it.skipIf(process.platform === 'win32')('a run gets the CLI its key and not the server its token', async () => {
    plant();
    const tools = {
      wire: () => ({ args: [], out: path.join(os.tmpdir(), 'rmm-env-nothing.json'), env: { RMM_TAILOR_SESSION: '/s.json' } }),
      read: () => undefined,
    };
    const result = await runAgent(config(fakeClaude()), 'print it', tools);
    const seen = JSON.parse(result.output) as Record<string, string>;

    expect(seen.GITHUB_TOKEN).toBeUndefined();
    expect(seen.ANTHROPIC_API_KEY).toBe('sk-ant-planted');
    expect(seen.PATH).toBe(process.env.PATH);
    // What the app adds for the run still arrives on top of the list.
    expect(seen.RMM_TAILOR_SESSION).toBe('/s.json');
    expect(seen.PWD).toContain('rmm-ai-');
  });

  it.skipIf(process.platform === 'win32')('so does asking it which models it has', async () => {
    plant();
    const out = await captureModelPicker(fakeClaude(), { mode: 'command', args: ['models'], parser: 'claude' }, os.tmpdir());
    const seen = JSON.parse(out) as Record<string, string>;

    expect(seen.GITHUB_TOKEN).toBeUndefined();
    expect(seen.ANTHROPIC_API_KEY).toBe('sk-ant-planted');
  });
});
