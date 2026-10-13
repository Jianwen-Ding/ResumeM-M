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

  it('lets AWS through when ~/.claude/settings.json turns Bedrock on, and shrugs off a broken one', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rmm-env-home-'));
    try {
      const aws = { AWS_REGION: 'us-east-1', AWS_PROFILE: 'bedrock' };
      fs.mkdirSync(path.join(home, '.claude'));
      const settings = path.join(home, '.claude', 'settings.json');

      expect(envForAgent({ HOME: home, ...aws })).toEqual({ HOME: home });

      fs.writeFileSync(settings, JSON.stringify({ env: { CLAUDE_CODE_USE_BEDROCK: '1' } }));
      expect(envForAgent({ HOME: home, ...aws, GITHUB_TOKEN: 't' })).toEqual({ HOME: home, ...aws });
      // Claude Code's own CLAUDE_CONFIG_DIR, when it is set, is where the file is.
      expect(envForAgent({ HOME: '/nowhere', CLAUDE_CONFIG_DIR: path.join(home, '.claude'), ...aws })).toMatchObject(aws);

      fs.writeFileSync(settings, JSON.stringify({ env: { CLAUDE_CODE_USE_BEDROCK: '0' } }));
      expect(envForAgent({ HOME: home, ...aws })).toEqual({ HOME: home });
      fs.writeFileSync(settings, '{ not json');
      expect(envForAgent({ HOME: home, ...aws })).toEqual({ HOME: home });
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  /*
   * Claude Code's Vertex guide turns Vertex on in the same settings file as
   * Bedrock's does, and only Bedrock was looked for there: a Vertex setup
   * made the documented way lost its Google credentials and could not sign in.
   */
  it('lets Google credentials through when ~/.claude/settings.json turns Vertex on', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rmm-env-home-'));
    try {
      const creds = { GOOGLE_APPLICATION_CREDENTIALS: '/home/me/vertex-sa.json', CLOUDSDK_CONFIG: '/home/me/.gcloud' };
      const aws = { AWS_PROFILE: 'deploy' };
      fs.mkdirSync(path.join(home, '.claude'));
      const settings = path.join(home, '.claude', 'settings.json');

      for (const flag of ['CLAUDE_CODE_USE_VERTEX', 'GOOGLE_GENAI_USE_VERTEXAI']) {
        fs.writeFileSync(settings, JSON.stringify({ env: { [flag]: '1' } }));
        // Google's, and not AWS's: one switch does not open the other.
        expect(envForAgent({ HOME: home, ...creds, ...aws }, 'claude'), flag).toEqual({ HOME: home, ...creds });
        fs.writeFileSync(settings, JSON.stringify({ env: { [flag]: 'false' } }));
        expect(envForAgent({ HOME: home, ...creds }, 'claude'), flag).toEqual({ HOME: home });
      }
      // Both in one file: each opens its own.
      fs.writeFileSync(settings, JSON.stringify({ env: { CLAUDE_CODE_USE_VERTEX: true, CLAUDE_CODE_USE_BEDROCK: 1 } }));
      expect(envForAgent({ HOME: home, ...creds, ...aws }, 'claude')).toEqual({ HOME: home, ...creds, ...aws });
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('lets Google account credentials through only to a Vertex or Gemini setup', () => {
    const creds = { GOOGLE_APPLICATION_CREDENTIALS: '/home/me/deploy-sa.json', CLOUDSDK_CONFIG: '/home/me/.gcloud' };

    expect(envForAgent({ ...creds })).toEqual({});
    expect(envForAgent({ ...creds }, 'claude')).toEqual({});
    expect(envForAgent({ ...creds, CLAUDE_CODE_USE_VERTEX: '0' })).toEqual({ CLAUDE_CODE_USE_VERTEX: '0' });

    expect(envForAgent({ ...creds, CLAUDE_CODE_USE_VERTEX: '1' })).toEqual({ ...creds, CLAUDE_CODE_USE_VERTEX: '1' });
    expect(envForAgent({ ...creds, GOOGLE_GENAI_USE_VERTEXAI: 'true' })).toEqual({ ...creds, GOOGLE_GENAI_USE_VERTEXAI: 'true' });
    expect(envForAgent({ ...creds }, 'gemini')).toEqual(creds);
    expect(envForAgent({ ...creds }, '/usr/local/bin/gemini')).toEqual(creds);
    expect(envForAgent({ ...creds }, 'C:\\Users\\me\\AppData\\Roaming\\npm\\gemini.cmd')).toEqual(creds);
  });

  it('keeps the gateway, project, keyring and Windows names the CLIs read', () => {
    const kept = {
      GOOGLE_GEMINI_BASE_URL: 'https://gw',
      GOOGLE_VERTEX_BASE_URL: 'https://gw',
      GOOGLE_CLOUD_QUOTA_PROJECT: 'q',
      GCLOUD_PROJECT: 'p',
      CLOUDSDK_CORE_PROJECT: 'p',
      DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
      USERNAME: 'win',
      'ProgramFiles(x86)': 'C:\\PF86',
      CommonProgramFiles: 'C:\\CPF',
      ALLUSERSPROFILE: 'C:\\PD',
    };
    expect(envForAgent({ ...kept, ...SECRETS })).toEqual(kept);
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
  function fakeClaude(name = 'claude'): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rmm-env-cli-'));
    dirs.push(dir);
    const script = path.join(dir, 'print-env.cjs');
    fs.writeFileSync(script, 'process.stdout.write(JSON.stringify(process.env));\n', 'utf8');
    const shim = path.join(dir, name);
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

  it.skipIf(process.platform === 'win32')('a run of gemini gets the Google credentials, and claude does not', async () => {
    saved.GOOGLE_APPLICATION_CREDENTIALS = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    saved.CLAUDE_CODE_USE_VERTEX = process.env.CLAUDE_CODE_USE_VERTEX;
    saved.GOOGLE_GENAI_USE_VERTEXAI = process.env.GOOGLE_GENAI_USE_VERTEXAI;
    process.env.GOOGLE_APPLICATION_CREDENTIALS = '/home/me/adc.json';
    delete process.env.CLAUDE_CODE_USE_VERTEX;
    delete process.env.GOOGLE_GENAI_USE_VERTEXAI;
    const tools = { wire: () => null, read: () => undefined };
    const asGemini = JSON.parse((await runAgent(config(fakeClaude('gemini')), 'print it', tools)).output) as Record<string, string>;
    const asClaude = JSON.parse((await runAgent(config(fakeClaude()), 'print it', tools)).output) as Record<string, string>;
    expect(asGemini.GOOGLE_APPLICATION_CREDENTIALS).toBe('/home/me/adc.json');
    expect(asClaude.GOOGLE_APPLICATION_CREDENTIALS).toBeUndefined();
  });

  it.skipIf(process.platform === 'win32')('so does asking it which models it has', async () => {
    plant();
    const out = await captureModelPicker(fakeClaude(), { mode: 'command', args: ['models'], parser: 'claude' }, os.tmpdir());
    const seen = JSON.parse(out) as Record<string, string>;

    expect(seen.GITHUB_TOKEN).toBeUndefined();
    expect(seen.ANTHROPIC_API_KEY).toBe('sk-ant-planted');
  });
});
