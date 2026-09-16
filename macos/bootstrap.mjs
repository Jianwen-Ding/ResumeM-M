// The native app owns stdin. EOF also cleans up the server if the app crashes.
import { startServer } from './src/server/index.js';

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
  server = await startServer({ dataDir: process.env.RMM_DATA, requireProjectSelection: true });
} catch (error) {
  console.error(error);
  process.exit(1);
}
