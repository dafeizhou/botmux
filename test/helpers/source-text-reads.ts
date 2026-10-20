/**
 * 找出「把仓库 src/ 源码当字符串读进来再断言」的测试用例。
 *
 * 这类用例钉的是实现文本：一改名或重构就红，代码还在但已经走不到时却照样绿。
 * 治理后只允许真正的结构护栏保留这种写法，而且用例（或外层 describe）上方必须有一行
 * `// 源码结构护栏(K1|K2|K3|K4)：<原因>` 注释（见 GUARD_MARKER）。规则说明见 CLAUDE.md「测试原则」。
 *
 * 判定是语法层面的：某个 it/test 回调体（包括它引用的模块级变量和函数）里出现了
 * readFileSync/readFile 调用，而且参数是落在仓库根下的 `src/` 路径。用 src 路径去
 * spawn、import 或执行代码不算；在临时目录里自建 `src/` 再读也不算。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

export interface SourceTextRead {
  file: string;
  line: number;
  title: string;
  /** 用例或外层 describe 上方带有护栏标记注释。 */
  marked: boolean;
}

/**
 * 两种标注：`源码结构护栏(Kx)：…` 表示确属结构约束、只能读源码；
 * `非文本断言：…` 表示读的是 src 下的资源（HTML/CSS 等）拿去当夹具或交给浏览器，不对其文本做断言。
 */
export const GUARD_MARKER = /源码结构护栏\s*[（(]\s*K[1-4]|非文本断言\s*[：:]/;

const READ_CALLEE = /(^|\.)(readFileSync|readFile)$/;
const TEST_CALLEE = /^(it|test)(\.(each|skip|only|concurrent|fails|skipIf|runIf|todo))?$/;
const SUITE_CALLEE = /^describe(\.(each|skip|only|concurrent|skipIf|runIf))?$/;
/** 字面量里出现 `src/...`、`../src/...`，或者作为 join 的一段单独出现 `'src'`。 */
const SRC_SEGMENT = /^(\.\.?\/)*src(\/|$)|(^|\/)\.\.\/src(\/|$)/;
/**
 * 把切出来的源码当代码执行（new Function / vm / transpileModule / eval）的写法。
 * 这类用例断言的是执行结果而不是文本，不算文本断言；不过它们依赖函数名和自由变量名，
 * 能导出被测函数时仍应直接 import。
 */
const EXECUTES = /\bnew\s+Function\b|(^|[^\w.])Function\(|\btranspileModule\b|\brunIn(New|This)Context\b|\bnew\s+(vm\.)?Script\b|(^|[^\w.])eval\(/;
/** 能把路径锚定到仓库根的写法。 */
const REPO_ANCHOR = /__dirname|import\.meta\.(url|dirname)|process\.cwd\(\)/;

function calleeName(call: ts.CallExpression): string {
  let expr: ts.Expression = call.expression;
  // it.each([...])('title', fn)：外层调用的 callee 本身又是一次调用。
  while (ts.isCallExpression(expr)) expr = expr.expression;
  return expr.getText();
}

function stringPieces(node: ts.Node): string[] {
  const out: string[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isStringLiteralLike(n)) out.push(n.text);
    else if (ts.isTemplateExpression(n)) {
      out.push(n.head.text);
      for (const span of n.templateSpans) out.push(span.literal.text);
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return out;
}

function mentions(node: ts.Node, names: ReadonlySet<string>): boolean {
  if (names.size === 0) return false;
  let hit = false;
  const visit = (n: ts.Node) => {
    if (hit) return;
    if (ts.isIdentifier(n) && names.has(n.text)) {
      const p = n.parent;
      const isDeclName = (ts.isVariableDeclaration(p) || ts.isFunctionDeclaration(p) || ts.isParameter(p)) && p.name === n;
      // `obj.style`、`{ style: … }`、`style() {}` 里的 style 是属性名，不是对变量的引用。
      const isPropName = (ts.isPropertyAccessExpression(p) || ts.isPropertyAssignment(p) || ts.isMethodDeclaration(p)
        || ts.isPropertySignature(p) || ts.isPropertyDeclaration(p)) && p.name === n
        || (ts.isBindingElement(p) && p.propertyName === n);
      if (!isDeclName && !isPropName) { hit = true; return; }
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return hit;
}

const PATH_CALLEE = /(^|\.)(join|resolve|dirname|fileURLToPath|normalize)\w*$/i;
function isPathExpression(node: ts.Node): boolean {
  if (ts.isStringLiteralLike(node) || ts.isTemplateExpression(node)) return true;
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node)) return isPathExpression(node.expression);
  if (ts.isNewExpression(node)) return node.expression.getText() === 'URL';
  if (ts.isCallExpression(node)) return PATH_CALLEE.test(node.expression.getText());
  if (ts.isPropertyAccessExpression(node)) return /^import\.meta\.(dirname|url)$/.test(node.getText());
  if (ts.isIdentifier(node)) return node.text === '__dirname';
  return false;
}

function hasMarker(text: string, stmt: ts.Node): boolean {
  const ranges = ts.getLeadingCommentRanges(text, stmt.getFullStart()) ?? [];
  return ranges.some(r => GUARD_MARKER.test(text.slice(r.pos, r.end)));
}

export function findSourceTextReads(file: string, text: string): SourceTextRead[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

  // 模块级（不在用例回调内）的声明：变量初始化式与函数体。
  const decls: Array<[string, ts.Node, 'var' | 'fn']> = [];
  const collect = (n: ts.Node, inTest: boolean) => {
    if (ts.isCallExpression(n) && TEST_CALLEE.test(calleeName(n))) inTest = true;
    if (!inTest) {
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) decls.push([n.name.text, n.initializer, 'var']);
      if (ts.isFunctionDeclaration(n) && n.name && n.body) decls.push([n.name.text, n.body, 'fn']);
    }
    ts.forEachChild(n, c => collect(c, inTest));
  };
  collect(sf, false);

  // 仓库根锚点变量（repoRoot = join(__dirname, '..') 之类）与指向 src 的路径变量。
  const anchors = new Set<string>();
  const srcPaths = new Set<string>();
  // 读出来的源码文本，或者返回源码文本的函数。
  const sourceText = new Set<string>();

  const isRepoSrcPath = (expr: ts.Node): boolean => {
    const pieces = stringPieces(expr);
    // src 下的 JSON 是数据文件（例如 lark-scopes.json），读来当夹具不算钉实现文本。
    if (pieces.some(p => /\.json$/.test(p))) return false;
    const hasSrc = pieces.some(p => SRC_SEGMENT.test(p) || p === 'src');
    if (hasSrc) {
      const raw = expr.getText();
      // 纯相对字面量（'src/x.ts'、'../src/x.ts'）按 cwd / 测试文件解析，都落在仓库里。
      // resolve('src/x.ts') / join('src', 'x.ts') 也一样：第一段就是 src，没有别的基准目录。
      const firstArg = ts.isCallExpression(expr) && /(^|\.)(resolve|join)\w*$/i.test(expr.expression.getText()) ? expr.arguments[0] : undefined;
      const bareRelative = ts.isStringLiteralLike(expr)
        || (ts.isNewExpression(expr) && /^new URL\(\s*['"`]/.test(raw))
        || (firstArg !== undefined && ts.isStringLiteralLike(firstArg) && (SRC_SEGMENT.test(firstArg.text) || firstArg.text === 'src'));
      if (bareRelative || REPO_ANCHOR.test(raw) || mentions(expr, anchors)) return true;
    }
    return mentions(expr, srcPaths);
  };

  const readsSource = (node: ts.Node): boolean => {
    if (EXECUTES.test(node.getText())) return false;
    // 回调体里同名的局部声明会遮蔽模块级变量，不能算作引用了源码文本。
    const shadowed = new Set<string>();
    const declare = (n: ts.Node) => {
      if ((ts.isVariableDeclaration(n) || ts.isParameter(n)) && ts.isIdentifier(n.name)) shadowed.add(n.name.text);
      ts.forEachChild(n, declare);
    };
    if (node !== sf) ts.forEachChild(node, declare);
    const visible = new Set([...sourceText].filter(name => !shadowed.has(name)));
    let hit = false;
    const visit = (n: ts.Node) => {
      if (hit) return;
      if (ts.isCallExpression(n) && READ_CALLEE.test(n.expression.getText()) && n.arguments[0] && isRepoSrcPath(n.arguments[0])) {
        hit = true;
        return;
      }
      ts.forEachChild(n, visit);
    };
    visit(node);
    return hit || mentions(node, visible);
  };

  // 迭代到不动点：锚点 → 路径 → 文本，彼此可以层层引用。
  for (let round = 0; round < 5; round++) {
    let changed = false;
    for (const [name, init, kind] of decls) {
      const raw = init.getText();
      // 只有「路径表达式」形状的变量才可能是锚点或 src 路径；函数体、spawn 调用等一律不算。
      if (kind === 'var' && isPathExpression(init) && !/readFileSync|readFile\b/.test(raw)) {
        const hasSrc = stringPieces(init).some(p => SRC_SEGMENT.test(p) || p === 'src');
        if (!hasSrc && !anchors.has(name) && !srcPaths.has(name) && (REPO_ANCHOR.test(raw) || mentions(init, anchors))) {
          anchors.add(name); changed = true;
        }
        if (!srcPaths.has(name) && isRepoSrcPath(init)) { srcPaths.add(name); changed = true; }
      }
      if (!sourceText.has(name) && readsSource(init)) { sourceText.add(name); changed = true; }
    }
    if (!changed) break;
  }

  const out: SourceTextRead[] = [];
  const visitTests = (n: ts.Node, suiteMarked: boolean) => {
    if (ts.isExpressionStatement(n) && ts.isCallExpression(n.expression)) {
      const call = n.expression;
      const name = calleeName(call);
      if (SUITE_CALLEE.test(name)) {
        const marked = suiteMarked || hasMarker(text, n);
        ts.forEachChild(call, c => visitTests(c, marked));
        return;
      }
      if (TEST_CALLEE.test(name)) {
        const body = call.arguments.find(a => ts.isArrowFunction(a) || ts.isFunctionExpression(a));
        if (body && readsSource(body)) {
          const titleArg = call.arguments[0];
          out.push({
            file,
            line: sf.getLineAndCharacterOfPosition(n.getStart()).line + 1,
            title: titleArg && ts.isStringLiteralLike(titleArg) ? titleArg.text : (titleArg?.getText() ?? ''),
            marked: suiteMarked || hasMarker(text, n),
          });
        }
        return;
      }
    }
    ts.forEachChild(n, c => visitTests(c, suiteMarked));
  };
  visitTests(sf, false);
  return out;
}

/** 仓库里 unit 项目会跑到的测试文件（与 vitest.config.ts 的 unit include/exclude 一致）。 */
export function scanRepoTests(repoRoot: string): SourceTextRead[] {
  const out: SourceTextRead[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules' && relative(repoRoot, abs) !== join('test', 'e2e-browser')) walk(abs);
      } else if (/\.(test|spec)\.ts$/.test(entry.name) && !entry.name.endsWith('.e2e.ts')) {
        const text = readFileSync(abs, 'utf8');
        // 便宜的预筛：不读文件的测试不用解析。
        if (text.includes('readFile')) out.push(...findSourceTextReads(relative(repoRoot, abs), text));
      }
    }
  };
  walk(join(repoRoot, 'test'));
  return out;
}
