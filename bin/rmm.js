#!/usr/bin/env node
// Thin launcher so `rmm` works without a build step: run the compiled CLI when
// `npm run build` has been run, and fall back to tsx during development.
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const compiled = path.join(root, 'dist', 'src', 'cli.js');
const args = process.argv.slice(2);

const child = existsSync(compiled)
  ? spawn(process.execPath, [compiled, ...args], { stdio: 'inherit' })
  : spawn('npx', ['tsx', path.join(root, 'src', 'cli.ts'), ...args], {
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });

child.on('exit', (code) => process.exit(code ?? 0));
