import { describe, expect, it } from 'vitest';
import { verifyCodexAppEngineIdentity } from '../src/services/codex-app-engine-identity.js';

describe('signed Codex App engine identity', () => {
  const liveStart = (pid: number) => pid === 123 ? '456' : undefined;

  it('accepts the signed child only while its kernel birth token still matches', () => {
    expect(verifyCodexAppEngineIdentity({ pid: 123, procStart: '456' }, liveStart))
      .toEqual({ pid: 123, procStart: '456' });
    expect(verifyCodexAppEngineIdentity({ pid: 123, procStart: '455' }, liveStart)).toBeUndefined();
    expect(verifyCodexAppEngineIdentity({ pid: 124, procStart: '456' }, liveStart)).toBeUndefined();
  });

  it.each([null, [], {}, { pid: 1, procStart: '456' }, { pid: 1.5, procStart: '456' },
    { pid: '123', procStart: '456' }, { pid: 123, procStart: 456 },
    { pid: 123, procStart: '456\n' }, { pid: 123, procStart: '456', extra: true }])(
    'rejects malformed process proof %j', value => {
      expect(verifyCodexAppEngineIdentity(value, liveStart)).toBeUndefined();
    },
  );
});
