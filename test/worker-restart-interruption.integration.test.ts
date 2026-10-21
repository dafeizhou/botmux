import type { ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { spawnNodeTsScript } from './helpers/ts-runner.js';
import type { DaemonToWorker, WorkerToDaemon } from '../src/types.js';

// The real worker resumes a fake Pi whose previous process died mid-turn (the
// 10-21 tmux server loss): the resumed CLI must receive the restart note and
// the daemon one user_notify. pty backend only — never the host tmux server.

let child: ChildProcess | undefined;
let root: string | undefined;

afterEach(async () => {
  if (child && child.exitCode === null && child.signalCode === null) {
    const stopped = new Promise<void>(done => child!.once('exit', () => done()));
    child.kill('SIGKILL');
    await Promise.race([stopped, new Promise<void>(done => setTimeout(done, 2_000))]);
  }
  child = undefined;
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

async function waitUntil(check: () => boolean, logs: string[], timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    if (child?.exitCode !== null || child?.signalCode !== null) throw new Error(`Worker exited\n${logs.join('')}`);
    await new Promise(done => setTimeout(done, 25));
  }
  throw new Error(`Timed out\n${logs.join('')}`);
}

function setup(name: string) {
  root = mkdtempSync(join(tmpdir(), `botmux-${name}-`));
  const dataDir = join(root, 'data');
  mkdirSync(dataDir, { recursive: true });
  const cliSessionId = 'deadbeef-1234-4678-9abc-def012345680';
  const sessionsDir = join(root, '.pi', 'agent', 'sessions', dataDir.replace(/\//g, '--'));
  mkdirSync(sessionsDir, { recursive: true });
  const transcript = join(sessionsDir, `20261020_${cliSessionId}.jsonl`);
  writeFileSync(transcript, '');
  const inputLog = join(root, 'input.log');
  const crashFlag = join(root, 'crash');
  const fakePi = join(root, 'fake-pi');
  // Records every byte typed into it (one `--- start` line per process). On
  // Enter it writes what Pi writes for a turn cut off mid tool call: the user
  // record and an assistant `toolUse`, with no final.
  // Dynamic import: runs as CommonJS or ESM, whatever package.json sits above
  // the temp dir.
  writeFileSync(fakePi, `#!/usr/bin/env node
import('node:fs').then(fs => {
fs.appendFileSync(${JSON.stringify(inputLog)}, '--- start\\n');
process.stdout.write('pi> ');
let typed = '';
process.stdin.on('data', chunk => {
  const text = chunk.toString();
  fs.appendFileSync(${JSON.stringify(inputLog)}, text);
  typed += text;
  if (!/[\\r\\n]/.test(text)) return;
  const prompt = typed.replace(/[\\r\\n]+$/, '');
  typed = '';
  const now = new Date().toISOString();
  const row = message => JSON.stringify({ type: 'message', timestamp: now, message });
  fs.appendFileSync(${JSON.stringify(transcript)}, [
    row({ role: 'user', content: [{ type: 'text', text: prompt }] }),
    row({ role: 'assistant', stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'read-' + Date.now(), name: 'read', arguments: { path: 'src/a.ts' } }] }),
  ].join('\\n') + '\\n');
});
setInterval(() => {
  if (fs.existsSync(${JSON.stringify(crashFlag)})) { fs.unlinkSync(${JSON.stringify(crashFlag)}); process.exit(1); }
}, 20);
});
`);
  chmodSync(fakePi, 0o755);
  return { dataDir, cliSessionId, transcript, inputLog, crashFlag, fakePi };
}

describe('worker restart interruption notice (real worker, fake Pi)', () => {
  it('hands the resumed CLI the note under the cut-off turn and posts one notice', async () => {
    const env = setup('restart-interruption');
    const messages: WorkerToDaemon[] = [];
    const logs: string[] = [];
    child = spawnNodeTsScript(resolve('src/worker.ts'), [], {
      cwd: resolve('.'),
      env: {
        ...process.env, HOME: root!, SESSION_DATA_DIR: env.dataDir,
        BOTMUX_SESSION_ID: 'sid-restart-note', LARK_APP_ID: 'app_test', LARK_APP_SECRET: 'test-only',
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    child.on('message', raw => messages.push(raw as WorkerToDaemon));
    child.stdout?.on('data', chunk => logs.push(chunk.toString()));
    child.stderr?.on('data', chunk => logs.push(chunk.toString()));
    child.send({
      type: 'init', sessionId: 'sid-restart-note', chatId: 'oc_test', rootMessageId: 'om_root',
      workingDir: env.dataDir, cliId: 'pi', cliPathOverride: env.fakePi, cliSessionId: env.cliSessionId,
      backendType: 'pty', prompt: '', larkAppId: 'app_test', larkAppSecret: 'test-only', locale: 'zh',
    } satisfies DaemonToWorker);
    await waitUntil(() => messages.some(msg => msg.type === 'prompt_ready'), logs);

    // A turn the CLI consumed and was still working on.
    child.send({ type: 'message', content: 'review PR 2072', turnId: 'om_turn1' } satisfies DaemonToWorker);
    await waitUntil(() => readFileSync(env.transcript, 'utf8').includes('review PR 2072'), logs);
    // It ran long enough to go quiet on screen: the in-flight carry-over no
    // longer covers it (the shape of the interrupted pi reviews).
    await new Promise(done => setTimeout(done, 1_500));

    writeFileSync(env.crashFlag, '1');
    await waitUntil(() => messages.some(msg => msg.type === 'claude_exit'), logs);
    child.send({ type: 'restart', reason: 'cli_crash' } satisfies DaemonToWorker);

    await waitUntil(() => messages.some(msg => msg.type === 'user_notify'), logs);
    const notices = messages.filter((msg): msg is Extract<WorkerToDaemon, { type: 'user_notify' }> => msg.type === 'user_notify');
    expect(notices).toHaveLength(1);
    expect(notices[0].turnId).toBe('om_turn1');
    expect(notices[0].message).toContain('上一轮还没做完');
    expect(notices[0].message).toContain('已提醒');

    // The resumed process receives the note as its first input.
    await waitUntil(() => {
      const processes = existsSync(env.inputLog) ? readFileSync(env.inputLog, 'utf8').split('--- start\n') : [];
      return processes.length >= 3 && processes[2].includes('这个会话刚刚重启过');
    }, logs);
    const resumedInput = readFileSync(env.inputLog, 'utf8').split('--- start\n')[2];
    expect(resumedInput).toContain('那一轮还没做完');
    expect(resumedInput).not.toContain('review PR 2072');
    // Still exactly one notice once the note went in.
    await new Promise(done => setTimeout(done, 500));
    expect(messages.filter(msg => msg.type === 'user_notify')).toHaveLength(1);
  }, 60_000);

  it('a restart after a finished turn says nothing', async () => {
    const env = setup('restart-quiet');
    // History: a completed turn, long before this worker existed.
    writeFileSync(env.transcript, [
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'hello' }] },
    ].map(message => JSON.stringify({ type: 'message', timestamp: '2026-10-20T10:00:00.000Z', message })).join('\n') + '\n');
    const messages: WorkerToDaemon[] = [];
    const logs: string[] = [];
    child = spawnNodeTsScript(resolve('src/worker.ts'), [], {
      cwd: resolve('.'),
      env: {
        ...process.env, HOME: root!, SESSION_DATA_DIR: env.dataDir,
        BOTMUX_SESSION_ID: 'sid-restart-quiet', LARK_APP_ID: 'app_test', LARK_APP_SECRET: 'test-only',
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    child.on('message', raw => messages.push(raw as WorkerToDaemon));
    child.stdout?.on('data', chunk => logs.push(chunk.toString()));
    child.stderr?.on('data', chunk => logs.push(chunk.toString()));
    child.send({
      type: 'init', sessionId: 'sid-restart-quiet', chatId: 'oc_test', rootMessageId: 'om_root',
      workingDir: env.dataDir, cliId: 'pi', cliPathOverride: env.fakePi, cliSessionId: env.cliSessionId,
      backendType: 'pty', prompt: '', resume: true, larkAppId: 'app_test', larkAppSecret: 'test-only', locale: 'zh',
    } satisfies DaemonToWorker);
    await waitUntil(() => messages.some(msg => msg.type === 'prompt_ready'), logs);
    await new Promise(done => setTimeout(done, 800));
    expect(messages.some(msg => msg.type === 'user_notify')).toBe(false);
    expect(readFileSync(env.inputLog, 'utf8')).not.toContain('重启');
  }, 60_000);
});
