import { readProcessStartIdentity } from '../utils/process-identity.js';

export interface CodexAppEngineIdentity {
  pid: number;
  procStart: string;
}

/** Only call on an authenticated, signed runner payload. The signer owns the
 * app-server child; the kernel start token prevents trusting a recycled PID. */
export function verifyCodexAppEngineIdentity(
  value: unknown,
  readStart = readProcessStartIdentity,
): CodexAppEngineIdentity | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some(key => key !== 'pid' && key !== 'procStart')
    || !Number.isSafeInteger(record.pid) || (record.pid as number) <= 1
    || typeof record.procStart !== 'string' || !/^\d+$/.test(record.procStart)
    || record.procStart.length > 64) return undefined;
  const pid = record.pid as number;
  return readStart(pid) === record.procStart ? { pid, procStart: record.procStart } : undefined;
}
