/** A signed runner that keeps two real children alive while changing or
 * omitting the app-server proof. Only used by the worker control-channel test. */
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync } from 'node:fs';
import { createConnection } from 'node:net';
import {
  consumeCodexAppControlBootstrap,
  encodeCodexAppControlAuth,
  encodeCodexAppSignedControlMarker,
  parseCodexAppControlWireRecord,
  readCodexAppControlLocator,
} from '../../src/utils/codex-app-control.js';
import { readProcessStartIdentity } from '../../src/utils/process-identity.js';

const sessionId = process.argv[process.argv.indexOf('--session-id') + 1]!;
const bootstrap = consumeCodexAppControlBootstrap(process.env.BOTMUX_CODEX_APP_CONTROL_BOOTSTRAP!, sessionId);
const endpoint = bootstrap.socketPath
  ?? readCodexAppControlLocator(bootstrap.locatorPath!, sessionId)?.endpoint;
if (!endpoint) throw new Error('missing test control endpoint');
const children = [0, 1].map(() => spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], { stdio: 'ignore' }));
process.on('exit', () => { for (const child of children) child.kill('SIGKILL'); });
for (const signal of ['SIGHUP', 'SIGTERM', 'SIGINT'] as const) process.on(signal, () => process.exit(0));
await Promise.all(children.map(child => new Promise<void>((resolve, reject) => {
  child.once('spawn', resolve);
  child.once('error', reject);
})));
const proofs = children.map(child => ({ pid: child.pid!, procStart: readProcessStartIdentity(child.pid!)! }));
const report = (entry: unknown) => appendFileSync(process.env.FAKE_CODEX_IDENTITY_REPORT!, `${JSON.stringify(entry)}\n`);
report({ proofs });
const socket = createConnection(endpoint);
let challenge: string;
let buffer = '';
let nextSent = false;
const state = (seq: number) => {
  const mode = process.env.FAKE_CODEX_IDENTITY_MODE;
  socket.write(`${encodeCodexAppSignedControlMarker(
    bootstrap.privateKey, sessionId, bootstrap.generation, challenge, seq, 'state', {
      busy: false, acceptingInput: true,
      ...(seq === 2 && mode === 'dropped' ? {} : { appServerProcess: proofs[seq === 2 && mode === 'changed' ? 1 : 0] }),
    },
  )}\n`);
};
socket.on('data', chunk => {
  buffer += chunk.toString();
  let index: number;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const record = parseCodexAppControlWireRecord(buffer.slice(0, index));
    buffer = buffer.slice(index + 1);
    if (record?.type === 'challenge') {
      challenge = record.challenge;
      socket.write(`${encodeCodexAppControlAuth(bootstrap.privateKey, sessionId, bootstrap.generation, challenge)}\n`);
    } else if (record?.type === 'accepted') state(1);
    else if (record?.type === 'ack') report({ ack: record.seq });
  }
});
socket.on('error', () => { /* the worker closes the rejected generation */ });
setInterval(() => {
  if (nextSent || !existsSync(process.env.FAKE_CODEX_IDENTITY_TRIGGER!)) return;
  nextSent = true;
  state(2);
}, 20);
process.stdin.resume();
