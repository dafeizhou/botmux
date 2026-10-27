import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, extname, join } from 'node:path';
import { resolveBotmuxDataDir } from '../core/data-dir.js';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { writeAndFlush } from './stdout-flush.js';
import {
  RIFF_HOST_BINDING_ENV, RIFF_HOST_MAX_BYTES, riffHostFileArguments,
  type RiffHostBinding, type RiffHostRequest, type RiffHostResult,
} from '../services/riff-host-tools.js';

function bindingPath(env: NodeJS.ProcessEnv): string {
  if (!env.BOTMUX_SESSION_ID) throw new Error('riff_host_session_missing');
  return env[RIFF_HOST_BINDING_ENV] ?? join(resolveBotmuxDataDir({ env }), 'riff-host-bindings',
    `${createHash('sha256').update(env.BOTMUX_SESSION_ID).digest('hex')}.json`);
}

export function installRiffHostBinding(encoded: string, env = process.env): void {
  const b = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as RiffHostBinding;
  const url = new URL(b.url);
  if (b.sessionId !== env.BOTMUX_SESSION_ID || !b.turnId || !/^[A-Za-z0-9_-]{43}$/.test(b.token)
    || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('riff_host_binding_invalid');
  const path = bindingPath(env);
  mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 });
  atomicWriteFileSync(path, JSON.stringify(b), { mode: 0o600 });
}

export async function prepareRiffHostRequest(argv: string[], readStdin: () => Promise<string>): Promise<RiffHostRequest> {
  const args = [...argv];
  if (args[0] === 'ask' && args[1]?.startsWith('--')) args.splice(1, 0, 'buttons');
  const paths = riffHostFileArguments(args);
  const files: NonNullable<RiffHostRequest['files']> = [];
  let total = 0;
  for (const i of paths) {
    const path = args[i]!;
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > 24 * 1024 * 1024) throw new Error('riff_host_upload_too_large');
    const bytes = readFileSync(path);
    total += bytes.length;
    if (total * 4 / 3 > RIFF_HOST_MAX_BYTES - 1024 * 1024) throw new Error('riff_host_upload_too_large');
    // Keep only an inert filename; paths and unicode names never select host files.
    const name = basename(path).replace(/[^\w. -]/g, '_').slice(-160) || `upload${extname(path)}`;
    args[i] = `riff-upload:${files.length}`;
    files.push({ name, dataBase64: bytes.toString('base64') });
  }
  // cmdSend reads stdin only when neither a positional body nor a card/content
  // file was supplied. An empty pipe must not swallow a positional message.
  let stdin: string | undefined;
  const hasFlag = (flag: string) => args.some(a => a === flag || a.startsWith(`${flag}=`));
  if (args[0] === 'send' && !hasFlag('--content-file') && !hasFlag('--card-file') && !hasFlag('--card-json')) {
  const valueFlags = new Set(['--response-kind', '--mention', '--layout', '--expected-link', '--quote', '--as', '--plugin-card-action', '--image-mode', '--text', '--images', '--image', '--files', '--file', '--videos', '--video-covers', '--completion-proposal-file']);
    let positional = false;
    for (let i = 1; i < args.length; i++) {
      if (valueFlags.has(args[i]!)) { i++; continue; }
      if (!args[i]!.startsWith('-')) positional = true;
    }
    if (!positional) stdin = await readStdin();
  }
  const request = { operationId: randomUUID(), argv: args, stdin, ...(files.length ? { files } : {}) };
  if (Buffer.byteLength(JSON.stringify(request)) > RIFF_HOST_MAX_BYTES) throw new Error('riff_host_request_too_large');
  return request;
}

export async function callRiffHostTool(binding: RiffHostBinding, request: RiffHostRequest, fetchImpl = fetch): Promise<RiffHostResult> {
  const headers = { 'x-riff-host-token': binding.token, 'content-type': 'application/json' };
  const deadline = Date.now() + 62 * 60_000;
  let posted = false, transportFailures = 0;
  while (Date.now() < deadline) {
    // One POST only. A transport-ambiguous POST is reconciled by GET with the
    // same operation id; never fall back to direct Lark or create a fresh id.
    const init = !posted ? { method: 'POST', headers, body: JSON.stringify(request) } : { method: 'GET', headers };
    const url = posted ? `${binding.url}?operationId=${encodeURIComponent(request.operationId)}` : binding.url;
    posted = true;
    let response: Response;
    try { response = await fetchImpl(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(15_000) }); }
    catch {
      if (++transportFailures >= 3) throw new Error('riff_host_transport_unknown; do not repeat automatically');
      await new Promise(resolve => setTimeout(resolve, 500)); continue;
    }
    transportFailures = 0;
    const body = await response.json() as { state?: string; result?: RiffHostResult; error?: string };
    if (!response.ok) throw new Error(body.error ?? `riff_host_http_${response.status}`);
    if (body.state === 'completed' && body.result) return body.result;
    if (body.state !== 'running') throw new Error('riff_host_response_invalid');
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  throw new Error('riff_host_execution_unknown; do not repeat automatically');
}

export function restoreRiffHostAttachments(result: RiffHostResult): RiffHostResult {
  if (!result.attachments?.length) return result;
  const directory = mkdtempSync(join(tmpdir(), 'botmux-riff-quoted-'));
  const parsed = JSON.parse(result.stdout) as { attachments?: Array<{ path: string }> };
  for (const [index, item] of result.attachments.entries()) {
    const path = join(directory, `${index}-${basename(item.name)}`);
    writeFileSync(path, Buffer.from(item.dataBase64, 'base64'), { mode: 0o600 });
    for (const attachment of parsed.attachments ?? []) {
      if (attachment.path === item.placeholder) attachment.path = path;
    }
  }
  return { ...result, stdout: `${JSON.stringify(parsed, null, 2)}\n` };
}

/** Returns false for a local invocation. A configured remote command either
 * completes on the host or fails explicitly; it never edits sandbox-local state. */
export async function maybeRunRiffHostTool(argv: string[], readStdin: () => Promise<string>, env = process.env): Promise<boolean> {
  if (env.BOTMUX_HOST_RELAY_AUTHORIZED === '1' || !env.BOTMUX_SESSION_ID) return false;
  if (argv[0] === 'riff-host-bind') {
    if (argv.length !== 2) throw new Error('riff_host_binding_invalid');
    installRiffHostBinding(argv[1]!, env);
    return true;
  }
  const path = bindingPath(env);
  if (env.BOTMUX_RIFF_HOST_TOOLS !== '1' && !existsSync(path)) return false;
  if (['--version', '-v', '--help', '-h', 'help', 'capabilities', 'skill'].includes(argv[0] ?? '')
    || (argv[0] === 'send' && argv.includes('--dry-run'))) return false;
  const b = JSON.parse(readFileSync(path, 'utf8')) as RiffHostBinding;
  if (b.sessionId !== env.BOTMUX_SESSION_ID) throw new Error('riff_host_session_mismatch');
  const result = restoreRiffHostAttachments(await callRiffHostTool(b, await prepareRiffHostRequest(argv, readStdin)));
  await Promise.all([writeAndFlush(process.stdout, result.stdout), writeAndFlush(process.stderr, result.stderr)]);
  process.exitCode = result.exitCode;
  return true;
}
