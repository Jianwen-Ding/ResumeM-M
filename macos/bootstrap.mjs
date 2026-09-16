// The native app owns stdin. EOF also cleans up the server if the app crashes.
import { startServer } from './src/server/index.js';
import { Repo } from './src/git/repo.js';
import { seedStore } from './src/model/location.js';
import { fileURLToPath } from 'node:url';

let server;
const stop = () => {
  const deadline = setTimeout(() => process.exit(0), 2000);
  deadline.unref();
  if (server) server.close().finally(() => process.exit(0));
  else process.exit(0);
};
process.stdin.resume();
process.stdin.on('end', stop);
process.on('SIGTERM', stop);
process.on('SIGINT', stop);

try {
  seedStore(fileURLToPath(new URL('./data', import.meta.url)), process.env.RMM_DATA);
  await Repo.forStore(process.env.RMM_DATA).ensure();
  server = await startServer({ dataDir: process.env.RMM_DATA });
} catch (error) {
  console.error(error);
  process.exit(1);
}
