#!/usr/bin/env node
/** The entry point a coding-agent CLI spawns. See `main.ts`. */
import { main } from './main.js';

main().catch((err) => {
  process.stderr.write(`${(err as Error).message}\n`);
  process.exit(1);
});
