import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { findSourceTextReads, scanRepoTests } from './helpers/source-text-reads.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('测试卫生：读 src 源码文本做断言', () => {
  it('仓库里每个这样的用例都标注了源码结构护栏', () => {
    const unmarked = scanRepoTests(repoRoot).filter(read => !read.marked);
    const listing = unmarked.map(read => `  ${read.file}:${read.line}  ${read.title}`).join('\n');
    expect(unmarked.length, [
      `${unmarked.length} 个用例把 src/ 源码当字符串读进来做断言，却没有标注为结构护栏：`,
      listing,
      '',
      '这类断言钉的是实现文本：改名、重构就红，代码还在但走不到时照样绿。请改成行为测试：',
      '调用导出的函数/组件/CLI 入口；逻辑埋在 worker.ts / daemon.ts 闭包里时，先把它抽成可测的纯函数。',
      '确属结构约束（K1 import 边界与编译态限制 / K2 安全护栏 / K3 高危回归绊线 / K4 机器可校验的一致性），',
      '在 it(...) 或外层 describe(...) 上方加一行：// 源码结构护栏(Kx)：<为什么只能读源码、守的是什么不变量>',
      '只是把 src 下的 HTML/CSS 当夹具或交给浏览器、不断言其文本的，标注：// 非文本断言：<说明>',
      '规则见 CLAUDE.md「测试原则」。',
    ].join('\n')).toBe(0);
  });
});

// 扫描器出错时的表现是静默放行（什么都扫不到 ⟹ 上面永远绿），所以两个方向都要钉住。
describe('源码文本扫描器', () => {
  const scan = (source: string) => findSourceTextReads('probe.test.ts', source).map(r => ({ title: r.title, marked: r.marked }));

  it.each([
    ['模块级读入、用例里断言', `
      const worker = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8');
      it('t', () => { expect(worker).toContain('x'); });`],
    ['resolve 相对 cwd', `
      it('t', () => { expect(readFileSync(resolve('src/daemon.ts'), 'utf8')).toContain('x'); });`],
    ['经由仓库根变量与读取函数', `
      const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
      const read = (p: string) => readFileSync(join(repoRoot, 'src', p), 'utf8');
      it('t', () => { expect(read('cli.ts').indexOf('a')).toBeLessThan(1); });`],
    ['describe 内读入', `
      describe('d', () => {
        const src = readFileSync(join(process.cwd(), 'src/worker.ts'), 'utf8');
        it('t', () => { expect(src).toMatch(/x/); });
      });`],
  ])('识别：%s', (_label, source) => {
    expect(scan(source)).toEqual([{ title: 't', marked: false }]);
  });

  it.each([
    ['用 src 路径起子进程', `
      const CLI = join(__dirname, '..', 'src', 'cli.ts');
      it('t', () => { const out = spawnSync('bun', [CLI]); expect(readFileSync(out.file, 'utf8')).toContain('x'); });`],
    ['读临时目录里自建的 src', `
      it('t', () => { const tmp = mkdtempSync('x'); expect(readFileSync(join(tmp, 'src', 'a.ts'), 'utf8')).toBe(''); });`],
    ['同名局部变量遮蔽模块级源码文本', `
      const source = readFileSync('src/worker.ts', 'utf8');
      it('t', () => { const source = render(); expect(source).toContain('x'); });`],
    ['对象字面量里同名的属性键', `
      const style = () => readFileSync('src/dashboard/web/style.css', 'utf8');
      it('t', () => { const pop = { style: { setProperty } }; expect(open(pop)).toBe(1); });`],
    ['切出真实函数执行后断言结果', `
      const worker = readFileSync('src/worker.ts', 'utf8');
      const load = (name: string) => new Function(worker.slice(worker.indexOf(name)))();
      it('t', () => { expect(load('decide')(1)).toBe(2); });`],
    ['src 下的 JSON 数据文件当夹具', `
      it('t', () => { expect(plan(JSON.parse(readFileSync('src/setup/lark-scopes.json', 'utf8')))).toEqual([]); });`],
  ])('不误报：%s', (_label, source) => {
    expect(scan(source)).toEqual([]);
  });

  it('护栏标注写在用例或外层 describe 上方都有效', () => {
    expect(scan(`
      const w = readFileSync('src/worker.ts', 'utf8');
      // 源码结构护栏(K1)：编译态不能拼 __dirname 落盘
      it('a', () => { expect(w).not.toContain('__dirname'); });
      // 源码结构护栏（K2）：鉴权先于写入
      describe('d', () => { it('b', () => { expect(w.indexOf('auth')).toBeLessThan(w.indexOf('write')); }); });
      // 非文本断言：把真实 style.css 交给浏览器渲染
      it('c', () => { serve(readFileSync('src/dashboard/web/style.css')); });
      it('d', () => { expect(w).toContain('x'); });`)).toEqual([
      { title: 'a', marked: true },
      { title: 'b', marked: true },
      { title: 'c', marked: true },
      { title: 'd', marked: false },
    ]);
  });
});
