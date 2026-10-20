/**
 * ⌘K 全局搜索（src/dashboard/web/command-palette*.ts[x]）的行为契约：
 *
 *   - model：匹配分档 / 多词 AND / 高亮区间 / 分组排序与截断 / 最近记录 / 唤起键
 *   - sources：会话推荐顺序与跳转目标、设置索引都有译文且能落到真实区块
 *   - 面板交互：键盘上下选择、回车与 ⌘↵ 两种动作、Tab 切分类、输入法组字、Esc
 *
 * 面板用原生 <dialog>：react-test-renderer 没有 DOM 宿主，ref 恒为 null，ModalDialog
 * 与面板里的 focus / scroll effect 都有 null 兜底；只 stub 面板真正碰到的浏览器全局
 * （location / localStorage / setTimeout / fetch）。
 */
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import {
  PALETTE_RECENT_LIMIT,
  PALETTE_RECENT_STORAGE_KEY,
  isPaletteHotkey,
  matchItem,
  matchToken,
  nextScope,
  pushRecentKey,
  readRecentKeys,
  searchPalette,
  splitHighlights,
  type PaletteItem,
} from '../src/dashboard/web/command-palette-model.js';
import {
  SETTINGS_SEARCH_INDEX,
  buildSessionItems,
  buildSettingItems,
  orderSessionsForPalette,
} from '../src/dashboard/web/command-palette-sources.js';
import { CommandPalette, type CommandPaletteProps } from '../src/dashboard/web/command-palette.js';
import { clearHashQueryParam } from '../src/dashboard/web/dashboard-routes.js';
import { createDashboardTranslator } from '../src/dashboard/web/i18n.js';
import { store } from '../src/dashboard/web/store.js';
import { ui } from '../src/dashboard/web/ui.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function item(partial: Partial<PaletteItem> & Pick<PaletteItem, 'key' | 'kind' | 'title'>): PaletteItem {
  return { primary: { label: 'open', href: `#/${partial.key}` }, ...partial };
}

describe('command palette model: matching', () => {
  it('ranks exact > prefix > word start > mid-word substring > fuzzy', () => {
    const exact = matchToken('agent', 'agent')!.score;
    const prefix = matchToken('agents page', 'agent')!.score;
    const wordStart = matchToken('my agent', 'agent')!.score;
    const midWord = matchToken('reagents', 'agent')!.score;
    const fuzzy = matchToken('a great entry', 'agent')!.score;
    expect(exact).toBeGreaterThan(prefix);
    expect(prefix).toBeGreaterThan(wordStart);
    expect(wordStart).toBeGreaterThan(midWord);
    expect(midWord).toBeGreaterThan(fuzzy);
  });

  it('highlights the word-start occurrence when a token appears more than once', () => {
    expect(matchToken('xbot bot', 'bot')!.ranges).toEqual([{ start: 5, end: 8 }]);
    // CJK 与拉丁字母交界也算词首：「飞书bot」里的 bot。
    expect(matchToken('飞书bot', 'bot')!.ranges).toEqual([{ start: 2, end: 5 }]);
  });

  it('only fuzzy-matches ASCII tokens of 3+ chars and rejects widely scattered letters', () => {
    expect(matchToken('session control', 'sesctl')).toMatchObject({ tier: 'fuzzy' });
    expect(matchToken('会话控制', '会控')).toBeNull();
    expect(matchToken('a stream group', 'ag')).toBeNull();
    expect(matchToken(`a${'x'.repeat(40)}b${'x'.repeat(40)}c`, 'abc')).toBeNull();
  });

  it('hidden fields need a real hit: no fuzzy, and short Latin tokens must start a word', () => {
    const listeners = item({ key: 'page:message-listeners', kind: 'page', title: '消息监听', keywords: ['Message Listener'] });
    expect(matchItem(listeners, ['ag'])).toBeNull();
    expect(matchItem(listeners, ['mess'])).not.toBeNull();
    expect(matchItem(listeners, ['listen'])).not.toBeNull();
    const proxy = item({ key: 'setting:proxy', kind: 'setting', title: 'GitHub 下载代理', subtitle: '全局设置 › 自动维护', keywords: ['GitHub download proxy'] });
    expect(matchItem(proxy, ['dwnld'])).toBeNull();
    // CJK 没有词边界：副标题 / 关键词里的中文子串照常命中。
    expect(matchItem(proxy, ['维护'])).not.toBeNull();
  });

  it('requires every query word to match (AND) and keeps title highlights per word', () => {
    const it1 = item({ key: 'session:1', kind: 'session', title: 'Deploy staging api', subtitle: 'bot-a · repo' });
    expect(matchItem(it1, ['deploy', 'missing'])).toBeNull();
    const match = matchItem(it1, ['api', 'deploy'])!;
    expect(match.titleRanges).toEqual([{ start: 0, end: 6 }, { start: 15, end: 18 }]);
    expect(match.subtitleRanges).toEqual([]);
  });

  it('matches hidden keywords (the other locale) without inventing title highlights', () => {
    const settings = item({ key: 'page:settings', kind: 'page', title: '全局设置', keywords: ['Global Settings'] });
    const match = matchItem(settings, ['settings'])!;
    expect(match.score).toBeGreaterThan(0);
    expect(match.titleRanges).toEqual([]);
  });

  it('splits text into highlighted and plain parts', () => {
    expect(splitHighlights('hello world', [{ start: 0, end: 2 }, { start: 6, end: 11 }])).toEqual([
      { text: 'he', hit: true },
      { text: 'llo ', hit: false },
      { text: 'world', hit: true },
    ]);
    expect(splitHighlights('abc', [])).toEqual([{ text: 'abc', hit: false }]);
  });
});

describe('command palette model: search & grouping', () => {
  const sessions = Array.from({ length: 7 }, (_, i) => item({ key: `session:${i}`, kind: 'session', title: `alpha session ${i}` }));
  const items: PaletteItem[] = [
    ...sessions,
    item({ key: 'skill:alpha', kind: 'skill', title: 'alpha' }),
    item({ key: 'setting:access', kind: 'setting', title: 'Access' }),
    item({ key: 'action:create', kind: 'action', title: 'Create session' }),
    item({ key: 'page:settings', kind: 'page', title: 'Settings' }),
  ];

  it('empty query in "all": recent first, then a few session suggestions with a "show all" row, actions, pages', () => {
    const result = searchPalette({ items, query: '', scope: 'all', recentKeys: ['page:settings', 'gone:key'] });
    expect(result.groups.map(group => group.id)).toEqual(['recent', 'session', 'action']);
    const sessionGroup = result.groups[1]!;
    expect(sessionGroup.rows.filter(row => row.type === 'item')).toHaveLength(5);
    expect(sessionGroup.rows.at(-1)).toMatchObject({ type: 'more', scope: 'session', count: 7 });
    // 已在「最近使用」里的条目不在下面的分组重复出现。
    expect(result.rows.filter(row => row.type === 'item' && row.item.key === 'page:settings')).toHaveLength(1);
  });

  it('empty query in a single scope lists only that kind', () => {
    const result = searchPalette({ items, query: '', scope: 'setting' });
    expect(result.groups.map(group => group.id)).toEqual(['setting']);
  });

  it('orders groups by their best score and caps each group in "all" with a "show all" row', () => {
    const result = searchPalette({ items, query: 'alpha', scope: 'all' });
    // skill「alpha」是全等命中，排在只有前缀命中的会话组前面。
    expect(result.groups.map(group => group.id)).toEqual(['skill', 'session']);
    const sessionGroup = result.groups[1]!;
    expect(sessionGroup.total).toBe(7);
    expect(sessionGroup.rows.at(-1)).toMatchObject({ type: 'more', scope: 'session', count: 7 });
    expect(result.counts).toMatchObject({ all: 8, session: 7, skill: 1, agent: 0, setting: 0 });
  });

  it('a single scope returns every match of that kind and still reports cross-scope counts', () => {
    const result = searchPalette({ items, query: 'alpha', scope: 'session' });
    expect(result.groups.map(group => group.id)).toEqual(['session']);
    expect(result.rows.every(row => row.type === 'item')).toBe(true);
    expect(result.rows).toHaveLength(7);
    expect(result.counts.skill).toBe(1);
  });

  it('breaks score ties with the item boost (active / recent sessions first)', () => {
    const tied = [
      item({ key: 'session:old', kind: 'session', title: 'build', boost: 0.1 }),
      item({ key: 'session:new', kind: 'session', title: 'build', boost: 0.9 }),
    ];
    const result = searchPalette({ items: tied, query: 'build', scope: 'session' });
    expect(result.rows.map(row => row.type === 'item' && row.item.key)).toEqual(['session:new', 'session:old']);
  });

  it('cycles scopes within the available list', () => {
    expect(nextScope('all', 1)).toBe('session');
    expect(nextScope('all', -1)).toBe('setting');
    expect(nextScope('session', 1, ['all', 'session', 'setting'])).toBe('setting');
    expect(nextScope('skill', 1, ['all', 'session', 'setting'])).toBe('all');
  });
});

describe('command palette model: recent & hotkey', () => {
  function memoryStorage(initial: Record<string, string> = {}) {
    const data = new Map(Object.entries(initial));
    return {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => { data.set(key, value); },
    };
  }

  it('keeps the most recent keys first, deduped and capped', () => {
    const storage = memoryStorage();
    for (let i = 0; i < PALETTE_RECENT_LIMIT + 2; i++) pushRecentKey(storage, `page:${i}`);
    pushRecentKey(storage, 'page:3');
    const keys = readRecentKeys(storage);
    expect(keys[0]).toBe('page:3');
    expect(keys).toHaveLength(PALETTE_RECENT_LIMIT);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('treats corrupt storage as empty', () => {
    expect(readRecentKeys(memoryStorage({ [PALETTE_RECENT_STORAGE_KEY]: '{oops' }))).toEqual([]);
    expect(readRecentKeys(memoryStorage({ [PALETTE_RECENT_STORAGE_KEY]: '[1,"page:a"]' }))).toEqual(['page:a']);
  });

  it('opens with ⌘K on macOS and Ctrl+K elsewhere, never with Shift / Alt combos', () => {
    const key = (init: Partial<KeyboardEvent>) => ({ key: 'k', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...init });
    expect(isPaletteHotkey(key({ metaKey: true }), true)).toBe(true);
    expect(isPaletteHotkey(key({ ctrlKey: true }), true)).toBe(false);
    expect(isPaletteHotkey(key({ ctrlKey: true }), false)).toBe(true);
    expect(isPaletteHotkey(key({ metaKey: true }), false)).toBe(false);
    expect(isPaletteHotkey(key({ ctrlKey: true, shiftKey: true }), false)).toBe(false);
    expect(isPaletteHotkey(key({ ctrlKey: true, key: 'K' }), false)).toBe(true);
  });
});

describe('command palette sources', () => {
  const now = Date.UTC(2026, 9, 21, 12);

  it('suggests sessions waiting on the user first, then active by recency, then closed', () => {
    const rows = [
      { sessionId: 'closed', status: 'closed', lastMessageAt: now },
      { sessionId: 'idle-old', status: 'idle', lastMessageAt: now - 5_000 },
      { sessionId: 'working-new', status: 'working', lastMessageAt: now - 1_000 },
      { sessionId: 'waiting', status: 'idle', lastMessageAt: now - 9_000, agentAttention: { reason: 'needs approval', at: now - 9_000 } },
    ];
    expect(orderSessionsForPalette(rows).map(row => row.sessionId)).toEqual(['waiting', 'working-new', 'idle-old', 'closed']);
  });

  it('opens session details by default; active sessions offer the cockpit, closed ones the Feishu thread', () => {
    const [active, closed, closedNoLink] = buildSessionItems([
      { sessionId: 'a/1', status: 'working', title: '@bot fix login', lastMessageAt: now },
      { sessionId: 'c1', status: 'closed', title: 'old', lastMessageAt: now - 10, feishuThreadLink: 'https://applink.feishu.cn/x' },
      { sessionId: 'c2', status: 'closed', title: 'older', lastMessageAt: now - 20, feishuThreadLink: 'javascript:alert(1)' },
    ], now);
    expect(active!.title).toBe('fix login');
    expect(active!.primary.href).toBe('#/sessions?session=a%2F1');
    expect(active!.secondary).toMatchObject({ href: '#/agent-workbench/a%2F1' });
    expect(closed!.secondary).toMatchObject({ href: 'https://applink.feishu.cn/x', external: true });
    expect(closedNoLink!.secondary).toBeUndefined();
  });

  it('every indexed settings key is translated in both locales', () => {
    const zh = createDashboardTranslator('zh');
    const en = createDashboardTranslator('en');
    for (const entry of SETTINGS_SEARCH_INDEX) {
      for (const key of [entry.module, entry.section, ...entry.fields]) {
        expect(zh(key), key).not.toBe(key);
        expect(en(key), key).not.toBe(key);
      }
    }
    const items = buildSettingItems();
    expect(items.find(it => it.key === 'setting:settings-maintenance:settings.httpProxy')!.primary.href)
      .toBe('#/settings?section=settings-maintenance&field=settings.httpProxy');
  });

  it('every indexed settings section is a real block id on the settings page', () => {
    // 源码结构护栏(K4)：搜索索引的区块 id 要落到 settings-page.tsx 里 SettingsBlock 的 DOM id 上，
    // 深链才滚得过去；区块 JSX 是页面组件内部结构、import 不出来，只能读文本比对。
    const source = readFileSync(new URL('../src/dashboard/web/settings-page.tsx', import.meta.url), 'utf8');
    for (const entry of SETTINGS_SEARCH_INDEX) {
      expect(source, entry.id).toContain(`id="${entry.id}"`);
    }
  });
});

describe('clearHashQueryParam', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('drops one param in place without touching the rest of the hash', () => {
    const replaceState = vi.fn();
    vi.stubGlobal('location', { pathname: '/', search: '?x=1', hash: '#/settings?section=a&field=b' });
    vi.stubGlobal('history', { state: null, replaceState });
    clearHashQueryParam('section');
    expect(replaceState).toHaveBeenCalledWith(null, '', '/?x=1#/settings?field=b');
    replaceState.mockClear();
    clearHashQueryParam('missing');
    expect(replaceState).not.toHaveBeenCalled();
  });
});

// ── 面板交互 ─────────────────────────────────────────────────────────────────

describe('CommandPalette interaction', () => {
  const now = Date.now();
  let storageData: Map<string, string>;
  let fakeLocation: { hash: string; href: string };
  const mounted: TestRenderer.ReactTestRenderer[] = [];

  beforeEach(() => {
    storageData = new Map();
    fakeLocation = { hash: '#/', href: 'http://dash.local/#/' };
    vi.stubGlobal('location', fakeLocation);
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (key: string) => storageData.get(key) ?? null,
        setItem: (key: string, value: string) => { storageData.set(key, value); },
      },
      setTimeout: (fn: () => void) => { fn(); return 0; },
      open: vi.fn(),
      dispatchEvent: vi.fn(),
    });
    vi.stubGlobal('fetch', vi.fn(async (url: string) => ({
      ok: true,
      json: async () => (url === '/api/skills'
        ? { skills: [{ name: 'lark-calendar', description: 'Feishu calendar helper' }] }
        : { agents: [{ id: 'reviewer', name: 'Code Reviewer' }], links: {} }),
    })));
    ui.authed = true;
    ui.workbenchAuthed = true;
    store.replaceSnapshot([
      { sessionId: 's-work', status: 'working', title: 'Deploy staging api', lastMessageAt: now - 60_000 },
      { sessionId: 's-wait', status: 'idle', title: 'Review login PR', lastMessageAt: now - 120_000, agentAttention: { reason: 'approve', at: now - 120_000 } },
      { sessionId: 's-closed', status: 'closed', title: 'Old deploy notes', lastMessageAt: now - 86_400_000 },
    ], []);
  });

  afterEach(() => {
    act(() => { for (const r of mounted) r.unmount(); });
    mounted.length = 0;
    vi.unstubAllGlobals();
    ui.authed = true;
  });

  function mount(overrides: Partial<CommandPaletteProps> = {}) {
    const onClose = vi.fn();
    const context = {
      pages: [{ id: 'settings', href: '#/settings', label: '全局设置', labelKey: 'nav.settings' }],
      setLocale: vi.fn(),
      openCreateSession: vi.fn(),
      openCreateBot: vi.fn(),
    };
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(createElement(CommandPalette, { open: true, onClose, context, mac: true, ...overrides }));
    });
    mounted.push(renderer);
    const input = () => renderer.root.findByProps({ role: 'combobox' });
    const textOf = (node: TestRenderer.ReactTestInstance | string): string => (
      typeof node === 'string' ? node : node.children.map(textOf).join('')
    );
    const options = () => renderer.root.findAll(node => typeof node.type === 'string' && node.props.role === 'option');
    const activeTitle = () => {
      const active = options().find(node => node.props['aria-selected'] === true);
      return active ? textOf(active.findByProps({ className: 'cmdk-item-title' })) : null;
    };
    const tabs = () => renderer.root.findAll(node => typeof node.type === 'string' && node.props.role === 'tab');
    const selectedTab = () => textOf(tabs().find(node => node.props['aria-selected'] === true)!.children[0]!);
    const type = (value: string) => act(() => { input().props.onChange({ currentTarget: { value } }); });
    const press = (key: string, init: Record<string, unknown> = {}) => {
      const event = {
        key,
        keyCode: 0,
        shiftKey: false,
        metaKey: false,
        ctrlKey: false,
        altKey: false,
        nativeEvent: { isComposing: false },
        preventDefault: vi.fn(),
        ...init,
      };
      act(() => { input().props.onKeyDown(event); });
      return event;
    };
    return { renderer, onClose, context, input, options, activeTitle, tabs, selectedTab, type, press, textOf };
  }

  it('starts with the session waiting on you selected and walks the list with arrow keys (wrapping)', () => {
    const palette = mount();
    expect(palette.activeTitle()).toBe('Review login PR');
    palette.press('ArrowDown');
    expect(palette.activeTitle()).toBe('Deploy staging api');
    palette.press('ArrowUp');
    palette.press('ArrowUp');
    // 从第一条再往上回绕到最后一条（页面组的最后一项）。
    expect(palette.activeTitle()).toBe('全局设置');
  });

  it('typing filters and highlights; Enter opens session details, ⌘↵ the cockpit', () => {
    const palette = mount();
    palette.type('deploy');
    expect(palette.activeTitle()).toBe('Deploy staging api');
    const marks = palette.renderer.root.findAllByType('mark').map(node => palette.textOf(node));
    expect(marks).toContain('Deploy');
    palette.press('Enter');
    expect(palette.onClose).toHaveBeenCalledTimes(1);
    expect(fakeLocation.hash).toBe('#/sessions?session=s-work');

    const second = mount();
    second.type('deploy');
    second.press('Enter', { metaKey: true });
    expect(fakeLocation.hash).toBe('#/agent-workbench/s-work');
  });

  it('remembers what was opened and shows it under "recent" next time', () => {
    const palette = mount();
    palette.type('访问权限');
    palette.press('Enter');
    expect(fakeLocation.hash).toBe('#/settings?section=settings-access');
    const next = mount();
    expect(next.activeTitle()).toBe('访问权限');
  });

  it('Tab cycles categories, Backspace on an empty query goes back to "all"', () => {
    const palette = mount();
    expect(palette.selectedTab()).toBe('全部');
    palette.press('Tab');
    expect(palette.selectedTab()).toBe('会话');
    palette.press('Tab', { shiftKey: true });
    palette.press('Tab', { shiftKey: true });
    expect(palette.selectedTab()).toBe('设置');
    palette.press('Backspace');
    expect(palette.selectedTab()).toBe('全部');
  });

  it('fetches skills and agents when opened and makes them searchable', async () => {
    const palette = mount();
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    palette.type('calendar');
    expect(palette.activeTitle()).toBe('lark-calendar');
    palette.press('Enter');
    expect(fakeLocation.hash).toBe('#/skills?skill=lark-calendar');
  });

  it('hides the Skill / Agent categories from visitors without dashboard auth', () => {
    ui.authed = false;
    const palette = mount();
    expect(palette.tabs().map(tab => palette.textOf(tab.children[0]!))).toEqual(['全部', '会话', '设置']);
  });

  it('ignores Enter while an IME is composing and closes on Escape', () => {
    const palette = mount();
    palette.type('deploy');
    palette.press('Enter', { nativeEvent: { isComposing: true } });
    expect(palette.onClose).not.toHaveBeenCalled();
    expect(fakeLocation.hash).toBe('#/');
    palette.press('Escape');
    expect(palette.onClose).toHaveBeenCalledTimes(1);
  });

  it('"show all" switches to the category instead of navigating', () => {
    store.replaceSnapshot(Array.from({ length: 8 }, (_, i) => ({
      sessionId: `bulk-${i}`, status: 'working', title: `bulk job ${i}`, lastMessageAt: now - i * 1_000,
    })), []);
    const palette = mount();
    palette.type('bulk');
    const more = palette.options().find(node => palette.textOf(node).includes('8'))!;
    act(() => { more.props.onClick(); });
    expect(palette.selectedTab()).toBe('会话');
    expect(palette.options()).toHaveLength(8);
    expect(fakeLocation.hash).toBe('#/');
  });
});
