/* ============================================================
 * tests/visibility-judge.test.js —— 可见性判据门禁（V1）的契约 + **判别力**
 * 运行：node node_modules/vitest/vitest.mjs run tests/visibility-judge.test.js --pool=threads
 * ------------------------------------------------------------
 * 为什么这个文件存在（`G-19`）：
 *   `docs/RULES.md` §2 把 `V1` 与 `V2` **并列**为门禁，而 `V2` 有 `tests/smoke-state-check.test.js`
 *   （十多个用例），`V1` **一条单测都没有** ⇒ 九门禁里唯一没有判别力证明的那一条。
 *   一个没被单测钉住判定的门禁，等于"当初手验过一次、之后谁也不知道它还在不在守"✗ ——
 *   本工程实测过一次同类事故：某门禁**注入违规后 exit 0 没变红**（要求数字紧邻「断言」，
 *   而中文自然写法是「2 条视觉断言」）⇒ 它一直在空转。所以这里钉的不是"函数能跑"，
 *   而是**"什么该绿、什么该红"的边界**。
 *
 * ## 2026-10-20：本文件原先把两条**缺陷**钉成了"现状"，本批把门禁修好、用例同步翻过来
 *   （`G-19` 那一批的边界是"`scripts/**` 只读"，所以只能钉不能修；本批修了 ⇒ 用例必须改，
 *   否则它们会变成"保护缺陷"的用例）。
 *     · 缝 (a) **空豁免标记仍生效** —— `EXEMPT_RE` 的 `\s*` 能跨行 ⇒ 吞掉下一行代码当原因。
 *       修前：`verdict='exempt'`、`problems=0`、`ok=true`；修后：原因必须同行非空，
 *       空标记**不算豁免** ⇒ 只剩 rect ⇒ **判红**，且报文点名"豁免原因不能为空"（口径同 `V2`）。
 *     · 缝 (b) **`nonvisual` 档只报告** —— `ok` 表达式不含 `nonVisual`。
 *       修前：`problems=0`、`nonVisual=1`、`ok=true`；修后：不在封闭册
 *       `NONVISUAL_DEBT` 上的"名字宣称可见、体内既无真判据也无盲判据" ⇒ **判红**。
 *   取证与修前/修后读数：`.review/20261020-门禁A/`（`probe-v1-seams.js` → `probe-v1-seams.json`）。
 *
 * ## 本文件照 `scripts/visibility-judge-check.js` 的**真实行为**写，不按名字猜
 *   被测面 = 该文件 `module.exports` 出来的纯函数：
 *     · `analyze(files, debt, opts)` —— 吃 `[{rel, src}]`，吐清单（不打印、不退出）⇒ 可被单测 require；
 *     · `judgeAssertion` / `findAssertions` / `judgeView` / `stripComments` / `expandSnippets` 等细分件；
 *     · `loadSmokeFiles(dir)` —— 可指向任意目录（本文件用它吃 `%TEMP%` 夹具）。
 *   断言认的是**源码文本**（`name: '…'` 且后面紧跟 `run:`），判的是"**判据的来源**"：
 *     真判据（`elementFromPoint` / `scanRegion` / …）· 显式豁免（`判据-豁免: <原因>`）· 盲判据（rect / 类名 / 行内样式）。
 *
 * ## `V1` **判不了什么**（读代码得出，照抄它自己文件头「边界（诚实标注）」那一段的原文）
 *   · 「它查的是**判据的来源**（有没有真判据 / 有没有声明豁免），查不了**判据用得对不对**
 *     （`elementFromPoint` 也能传错坐标 ⇒ 它照样绿 ✗）—— 那一层只能靠读图与真机复核；」
 *   · 「它只扫**名字里出现可见性词**的断言。名字里不写这些词、实际却在判界面的断言，它抓不到。
 *     所以"**名字要说清凭什么判**"本身是配套纪律：名字是这门禁的输入 ✗。」」
 *   · 「它**不做重活**：纯文本扫描，不起 Electron、不起服务、不联网（本文件自己的判据都是字符串匹配）。」
 *   ⇒ 于是两个高价值的**边界用例**必须钉住（否则读者会以为 V1 能判它们）：
 *     ① **"元素在视口内、但被另一个元素盖住"** —— V1 **判得了这一类的"判据有没有"**（因为它认得
 *        `elementFromPoint` 这个 token），但**判不了"那次命中真的落在了被遮挡的判定上"**：
 *        下面用例 `边界①` 造了一条"调了 `elementFromPoint` 但永不比较结果"的断言 ⇒ 门禁**照样绿**。
 *        这就是它能力的天花板：**它不执行代码，只读文本**。
 *     ② **名字里没有可见性词的界面断言** —— 完全不在扫描面上（`边界②`）。
 *
 * ## 三条纪律（本工程踩过的坑，照 `tests/smoke-state-check.test.js` 的形状）
 *   ① **夹具一律 `%TEMP%`**（`tests/_tmp-cleanup.js` 的 `makeTmp`/`cleanupAll`：创建即登记、收尾只一处）；
 *      真实 `scripts/smoke/*.js` **只读**（有一条用例专门比 sha 证明没被改）。
 *   ② **判别力留在测试里**，而不是只写在交付说明里 —— 见最后一个 describe（改坏判据 ⇒ 必红）。
 *   ③ **红的方向要能分辨**：`ok=false` 有**两种**成因（有违规 / 触发数低于下限 / 扫不到东西），
 *      所以判红的用例一律断言 `problems` / `staleDebt` 的具体内容，而不是只看 `ok`。
 * ============================================================ */
import { describe, it, expect, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTmp, cleanupAll } from './_tmp-cleanup.js';

const require = createRequire(import.meta.url);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const GATE_REL = 'scripts/visibility-judge-check.js';
const GATE_ABS = path.join(ROOT, GATE_REL);

/* ------------------------------------------------------------
 * 加载哪一份门禁：默认**真文件**；只有注入证明（§⑧）才临时指向一份**改坏的副本**。
 *
 * 为什么要留这个缝（而不是"当初手验过一次"）：验收要求"改坏副本 ⇒ 本文件的用例必须红；
 * 改回来必须绿"，能产生这个读数的只有**同一份用例**跑在两份门禁上。缝的三条防滥用：
 *   ① 只在 `MM_V1_GATE_COPY` **显式**设置时才走副本（正常 `npm test` 永远走真文件）；
 *   ② 副本必须落在 **`.review/`** 下（否则直接 throw）—— 防止有人把一份改过的门禁塞进
 *      `scripts/` 或 `tests/` 冒充"第二份实现"（本工程 S 组门禁治的就是这个）；
 *   ③ 副本路径不得等于真文件路径。
 * ------------------------------------------------------------ */
const GATE_COPY = process.env.MM_V1_GATE_COPY ? path.resolve(process.env.MM_V1_GATE_COPY) : null;
if (GATE_COPY) {
  const underReview = path.resolve(ROOT, '.review') + path.sep;
  if (GATE_COPY === GATE_ABS) throw new Error('MM_V1_GATE_COPY 指向真门禁本身 ⇒ 注入证明没有意义');
  if (GATE_COPY.toLowerCase().indexOf(underReview.toLowerCase()) !== 0) {
    throw new Error('MM_V1_GATE_COPY 只许指向 .review/ 下的副本（防止第二份门禁实现混进 scripts/ 或 tests/）：' + GATE_COPY);
  }
}
const gate = require(GATE_COPY || GATE_ABS);
const gateSrc = fs.readFileSync(GATE_COPY || GATE_ABS, 'utf8');
/** `V2`（`scripts/smoke-state-check.js`）—— 只为了钉"两条门禁的豁免口径一致"（见 ④ 的那条用例）。
 *  它**不**参与注入证明：口径一致是两条**实现**的关系，不是被测门禁的可变部分。 */
const v2Gate = require(path.resolve(ROOT, 'scripts', 'smoke-state-check.js'));

/** 读**真实仓库**的那几组用例只在真文件上跑：副本是改坏的、且它算 `ROOT` 的方式也不同
 *  （`ROOT = resolve(__dirname,'..')` ⇒ 副本在 `.review/` 下时指不到 `scripts/smoke`）。
 *  这不是"给自己留后门"：注入证明要看的是**判定逻辑**那几组，不是"真仓库当前干净"。 */
const describeOnRealGate = GATE_COPY ? describe.skip : describe;

afterAll(cleanupAll);

/* ============================================================
 * 夹具：在 `%TEMP%` 里造"冒烟域文件"（形状与真实断言一致：module.exports = [{ name, run }]）
 * @param {{name:string, body:string[]}[]} assertions
 * @returns {string} 目录绝对路径（已登记，收尾由 cleanupAll 统一删）
 * ============================================================ */
function fixtureDir(assertions) {
  const dir = makeTmp('mm-v1-fixture-');
  fs.writeFileSync(path.join(dir, '01-probe.js'), fixtureSrc(assertions), 'utf8');
  return dir;
}

function fixtureSrc(assertions) {
  const lines = ['module.exports = ['];
  assertions.forEach((a) => {
    lines.push('  {');
    lines.push("    name: '" + a.name + "',");
    lines.push('    run: async (ctx) => {');
    (a.body || []).forEach((b) => lines.push('      ' + b));
    lines.push('    }');
    lines.push('  },');
  });
  lines.push('];');
  return lines.join('\n') + '\n';
}

/** 跑一遍门禁（夹具目录 → 源码 → analyze）。`minTriggered` 只在单测里调小：小样例凑不满生产下限。
 *  欠账册一律传 `[]`（夹具的 rel 与真实文件不同名，册上的条目一条都碰不到 ⇒ 传空更干净）。 */
function judge(assertions, opts) {
  const dir = fixtureDir(assertions);
  return judgeDir(dir, opts);
}
function judgeDir(dir, opts) {
  return gate.analyze(gate.loadSmokeFiles(dir), [], Object.assign({ minTriggered: 1 }, opts || {}));
}

/** 真判据的两种口味：命中测试（抓遮挡）与真帧像素（抓裁切） */
const WITH_HIT_TEST = ["const hit = await ctx.exec('document.elementFromPoint(cx, cy).id');", 'return { ok: hit === "n1" };'];
const WITH_PIXELS = ["const px = await ctx.exec('scanRegion(8, 8, 40, 40).nonBg');", 'return { ok: px > 40 };'];
const BLIND_RECT = ["const r = await ctx.exec('document.querySelector(\".a\").getBoundingClientRect()');", 'return { ok: r.width > 8 };'];

/* ============================================================
 * ① 门禁自身：可被单测引入（零副作用）—— `testing-for-ai` B6
 * ============================================================ */
describe('V1 门禁自身：可被单测引入（零副作用）', () => {
  it('require 之后拿到判定用的纯函数，且源码末尾有 require.main 守卫', () => {
    expect(typeof gate.analyze).toBe('function');
    expect(typeof gate.judgeAssertion).toBe('function');
    expect(typeof gate.findAssertions).toBe('function');
    expect(typeof gate.loadSmokeFiles).toBe('function');
    expect(gateSrc).toMatch(/if \(require\.main === module\) main\(\);/);
  });

  it('analyze() 是纯函数：同一输入两次结果逐字节一致（不打印、不退出）', () => {
    const dir = fixtureDir([{ name: '圆钮可见', body: WITH_HIT_TEST }]);
    const a = judgeDir(dir);
    const b = judgeDir(dir);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.problems).toEqual([]);
  });

  it('"采不到真值 = 红"（`testing-for-ai` A5）：一个文件都没有 ⇒ scansOk=false ⇒ ok=false', () => {
    const empty = makeTmp('mm-v1-empty-');
    const r = gate.analyze(gate.loadSmokeFiles(empty), [], { minTriggered: 1 });
    expect(r.files).toBe(0);
    expect(r.scansOk).toBe(false);
    expect(r.ok).toBe(false);
  });
});

/* ============================================================
 * ② 正例：真用 elementFromPoint / 真量 rect 的可见性断言 ⇒ 绿
 * ============================================================ */
describe('V1 正例：给了"能看见像素或能命中元素"的判据 ⇒ 判绿', () => {
  it('★ `elementFromPoint` 命中自身（抓遮挡）⇒ verdict=ok，problems 为空', () => {
    const r = judge([{ name: '圆钮可见（elementFromPoint 命中圆心）', body: WITH_HIT_TEST }]);
    expect(r.problems).toEqual([]);
    expect(r.judged.length).toBe(1);
    expect(r.judged[0].verdict).toBe('ok');
    expect(r.judged[0].via).toContain('elementFromPoint');
    expect(r.ok).toBe(true);
  });

  it('★ 真帧像素判据（`scanRegion` 数像素，抓裁切）⇒ 同样判绿', () => {
    const r = judge([{ name: '关联条看得见（scanRegion 数非背景像素）', body: WITH_PIXELS }]);
    expect(r.judged.length).toBe(1);
    expect(r.judged[0].verdict).toBe('ok');
    expect(r.judged[0].via).toContain('scanRegion');
  });

  it('两类判据**同时**用也还是 ok（事故里被两种骗过，所以允许叠加）', () => {
    const r = judge([{ name: '面板内可见', body: WITH_HIT_TEST.concat(WITH_PIXELS) }]);
    expect(r.judged[0].verdict).toBe('ok');
    expect(r.judged[0].via).toEqual(['elementFromPoint', 'scanRegion']);
  });

  it('真判据写在**同文件的 JS 片段常量**里也算（域 34 的真实形状：断言体里只有 `BTN_JS`）', () => {
    const src = [
      "const BTN_JS = 'document.elementFromPoint(cx, cy).id';",
      'module.exports = [',
      '  {',
      "    name: '圆钮可见',",
      '    run: async (ctx) => {',
      '      const id = await ctx.exec(BTN_JS);',
      '      return { ok: id === "n1" };',
      '    }',
      '  }',
      '];'
    ].join('\n');
    const dir = makeTmp('mm-v1-snippet-');
    fs.writeFileSync(path.join(dir, '02-snippet.js'), src, 'utf8');
    const r = judgeDir(dir);
    expect(r.judged.length).toBe(1);
    expect(r.judged[0].verdict).toBe('ok');
  });
});

/* ============================================================
 * ③ 反例：只用 rect / 类名 / style.display 判"可见" ⇒ 判红
 *    —— 这正是 V1 存在的理由：这几样对**裁切与遮挡**是盲的
 *    （实测：被父元素 `overflow:hidden` 裁掉时 rect 读数与正常显示**完全相同**）
 * ============================================================ */
describe('V1 反例：名字声称可见、判据却是盲的 ⇒ 判红并点名盲判据', () => {
  const cases = [
    ['几何 rect', BLIND_RECT, 'getBoundingClientRect'],
    ['类名', ["const on = await ctx.exec('el.classList.contains(\"active\")');", 'return { ok: on };'], 'classList.contains'],
    ['行内样式', ["const d = await ctx.exec('el.style.display');", 'return { ok: d !== \"none\" };'], 'style.display'],
    ['计算样式', ["const v = await ctx.exec('getComputedStyle(el).opacity');", 'return { ok: Number(v) > 0 };'], 'getComputedStyle']
  ];

  cases.forEach(([kind, body, token]) => {
    it('★ 只用' + kind + ' ⇒ problems 里点名 `' + token + '`（判红）', () => {
      const r = judge([{ name: '圆钮可见', body: body }]);
      expect(r.problems.length).toBe(1);
      expect(r.problems[0].name).toBe('圆钮可见');
      expect(r.problems[0].blind.join(' ')).toContain(token);
      // 判红的方向要能分辨：这里红的是**违规**，不是"触发数不够"
      expect(r.floorOk).toBe(true);
      expect(r.ok).toBe(false);
    });
  });

  it('★ 名字里写着 `elementFromPoint`、代码里只有 rect ⇒ **仍判红**（名字里的字面量不算判据）', () => {
    // 这是本门禁**第一版空转**的那条真实事故：域 37 的断言名字里就写着 elementFromPoint，
    // 于是抹掉代码里的判据后门禁照样绿 ✗。修法在 `judgeView()`：抹掉 `name:` 那个字符串。
    const r = judge([{ name: '圆钮完整落在面板内（elementFromPoint 命中 + 真帧像素）', body: BLIND_RECT }]);
    expect(r.problems.length).toBe(1);
    expect(r.problems[0].name).toContain('elementFromPoint');
  });

  it('★ 判据只写在**注释**里 ⇒ 仍判红（判据要是**代码**）', () => {
    const body = [
      '// 这里本该用 document.elementFromPoint(cx, cy) 判命中，先记一笔 TODO',
      "const r = await ctx.exec('el.getBoundingClientRect()');",
      'return { ok: r.width > 8 };'
    ];
    const r = judge([{ name: '圆钮可见', body: body }]);
    expect(r.problems.length).toBe(1);
    expect(r.problems[0].blind.join(' ')).toContain('getBoundingClientRect');
  });

  it('反例清单要给**修法**（报文能被人照着修，不然它只会被无视）', () => {
    expect(gateSrc).toMatch(/加真判据：对元素中心做 `document\.elementFromPoint`/);
    expect(gateSrc).toMatch(/判据-豁免: <原因>/);
  });
});

/* ============================================================
 * ④ 豁免与边界：V1 允许"确实只需 rect"的少数情形，但豁免要带原因
 * ============================================================ */
describe('V1 豁免与三档口径（判红 / 只报告 / 跳过）', () => {
  it('★ `判据-豁免: <原因>` ⇒ verdict=exempt，不判红，且原因原样可见', () => {
    const body = ['// 判据-豁免: 这一条只判"元素在文档流里且没被折叠"，遮挡由域 37 的命中测试覆盖'].concat(BLIND_RECT);
    const r = judge([{ name: '圆钮可见', body: body }]);
    expect(r.problems).toEqual([]);
    expect(r.judged.length).toBe(1);
    expect(r.judged[0].verdict).toBe('exempt');
    expect(r.judged[0].exempt).toContain('遮挡由域 37');
    expect(r.ok).toBe(true);
  });

  /* ⚠️ 这一条钉的是**修后的行为**。2026-10-20 修复前的现状是（如实留档，不要再写回去）：
   *   `EXEMPT_RE = /判据-豁免\s*[:：]\s*(\S[^\n]*)/` 里那两处 `\s*` **能跨行** ⇒
   *   `// 判据-豁免:` 后面什么都不写时，正则把**下一行代码**当"原因"捕获，
   *   verdict 直接变 'exempt'、`problems` 为空 ⇒ 一条只有 rect 的可见性断言被放行（`exit 0`）。
   *   实测读数（`.review/20261020-门禁A/probe-v1-seams.json`）：
   *     · 修前 → `{verdict:'exempt', reasonCaptured:"const r = await ctx.exec('…getBoundingClientRect()…');", problems:0, ok:true}`
   *     · 修后 → `{verdict:null, reasonCaptured:null, problems:1, ok:false}`
   *   对照 `V2`（`scripts/smoke-state-check.js` 的 `findExemptions`）：它按**行**喂正则 ⇒ `\s*` 跨不过去
   *   ⇒ 冒号后必须同行非空白才算豁免。本批把 V1 收成同一口径（原因不能为空）。 */
  it('★ 写空的豁免标记**不再生效**（口径同 V2）：`判据-豁免:` 后无字 ⇒ 不算豁免 ⇒ 判红', () => {
    const body = ['// 判据-豁免: '].concat(BLIND_RECT);
    const r = judge([{ name: '圆钮可见', body: body }]);
    expect(r.judged.length).toBe(0);                    // 没被放行（修前这里会是 1，verdict='exempt'）
    expect(r.problems.length).toBe(1);                  // ⇒ 判红
    expect(r.problems[0].verdict).toBe('blind');
    expect(r.problems[0].emptyMark).toBe(true);         // 报文有据可依：明说"原因不能为空"
    expect(r.problems[0].blind.join(' ')).toContain('getBoundingClientRect');
    expect(r.ok).toBe(false);
  });

  it('边界：**有真判据** + 写空的豁免标记 ⇒ 仍算合规，但空标记必须被点名（不许静默留着）', () => {
    // 这一档不是漏洞（断言本来就有真判据），但也**不许悄悄留着**：一个没有原因的豁免标记
    // 要么是谎言、要么是残留 ⇒ 进 `emptyMarks`，`main()` 逐条点名它的判定档。
    const r = judge([{ name: '圆钮可见', body: ['// 判据-豁免: '].concat(WITH_HIT_TEST) }]);
    expect(r.problems).toEqual([]);
    expect(r.judged[0].verdict).toBe('ok');
    expect(r.emptyMarks.length).toBe(1);
    expect(r.emptyMarks[0].verdict).toBe('ok');
    expect(r.ok).toBe(true);
  });

  it('豁免口径是**机械一致**的：`EXEMPT_RE` / `EMPTY_EXEMPT_RE` 里没有能跨行的 `\\s*`', () => {
    // 修前的病就是"两处 `\s*` 能跨行"。这条用例把它钉成字符串级别的事实：
    // 以后谁要放宽成 `\s*`，这里立刻红，而不是等某个人去读正则。
    expect(String(gate.EXEMPT_RE)).not.toContain('\\s');
    expect(String(gate.EMPTY_EXEMPT_RE)).not.toContain('\\s');
    expect(gate.EMPTY_EXEMPT_RE.test('// 判据-豁免: ')).toBe(true);        // 空 ⇒ 认得出是"空标记"
    expect(gate.EMPTY_EXEMPT_RE.test('// 判据-豁免: 只需 rect')).toBe(false); // 有原因 ⇒ 不是空标记
  });

  it('★ 与 `V2` **同口径**：同一个"空原因"写法，两条门禁都不认它是豁免', () => {
    // 两条门禁的豁免标记形状相同（`判据-豁免:` vs `收尾-豁免:`），口径也必须相同 ——
    // 否则"在 V2 下会被判红的写法，在 V1 下能过关"，读者无从知道该信哪一条。
    const v1 = gate.judgeAssertion('// 判据-豁免: \n' + BLIND_RECT.join('\n'), '');
    expect(v1.exempt).toBeNull();
    expect(v1.emptyMark).toBe(true);
    const v2 = v2Gate.findExemptions('// 收尾-豁免: \n' + 'app.addNode("x");\n');
    expect(v2).toEqual([]);
    // 反面：两条都**认**"有原因"的那一行（口径一致不是"两边都变严到什么都不认"）
    expect(gate.judgeAssertion('// 判据-豁免: 只需几何\n' + BLIND_RECT.join('\n'), '').exempt).toBe('只需几何');
    expect(v2Gate.findExemptions('// 收尾-豁免: 由后面的域兜底\n')).toHaveLength(1);
  });

  /* ⚠️ 下面这三条钉的是**缝 (b) 修后的口径**（2026-10-20）。修前的现状（如实留档）：
   *   `analyze()` 的 `ok` 表达式里**没有** `nonVisual`，而 `'nonvisual'` 分支只
   *   `nonVisual.push(row)` 就 `continue` ⇒ 名字宣称可见、体内**连盲判据都没有**的断言
   *   只报告、不判红 ⇒ 把 rect 删干净就能把守卫**静默关掉**。 */
  it('★ 名字含词、体内**既无真判据也无盲判据** ⇒ 判红（修前：只报告，不判红）', () => {
    const r = judge([{ name: '这条变更可见', body: ['const x = await ctx.exec("el.dataset.label");', 'return { ok: !!x };'] }]);
    expect(r.nonVisual.length).toBe(0);          // 不在封闭册上 ⇒ 不进"只报告"那一档
    expect(r.problems.length).toBe(1);
    expect(r.problems[0].verdict).toBe('nonvisual');
    expect(r.problems[0].blind).toEqual([]);     // 连盲判据都没有 —— 比"用了盲判据"更可疑
    expect(r.ok).toBe(false);
  });

  it('在封闭册 `NONVISUAL_DEBT` 上的那一条 ⇒ 进 `nonVisual`（计数可见）而不判红', () => {
    // 册子只为"名字里的可见是数据/文案语义"服务；它不改变上面那条：**不在册的一律判红**。
    const reg = [{ rel: 'scripts/smoke/01-probe.js', name: '这条变更可见', why: '单测夹具：数据语义', todo: '单测夹具：改名销账' }];
    const r = judge([{ name: '这条变更可见', body: ['const x = await ctx.exec("el.dataset.label");', 'return { ok: !!x };'] }],
      { nonVisualDebt: reg });
    expect(r.problems).toEqual([]);
    expect(r.nonVisual.length).toBe(1);
    expect(r.nonVisual[0].verdict).toBe('nonvisual');
    expect(r.nonVisual[0].why).toContain('单测夹具');
    expect(r.nonVisual[0].fix).toContain('销账');     // `todo` 必须可执行（不能只写"历史原因"）
    expect(r.staleDebt).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('★ 册上有、但那条已经不是"无判据"了 ⇒ 判红并点名册名（欠账只减不增，修好忘销账要红）', () => {
    const reg = [{ rel: 'scripts/smoke/01-probe.js', name: '这条变更可见', why: '单测夹具', todo: '单测夹具' }];
    const r = judge([{ name: '圆钮可见', body: WITH_HIT_TEST }], { nonVisualDebt: reg });  // 名字换了 ⇒ 册上那条悬挂
    expect(r.problems).toEqual([]);
    expect(r.staleDebt.length).toBe(1);
    expect(r.staleDebt[0].book).toBe('NONVISUAL_DEBT');
    expect(r.ok).toBe(false);
  });

  it('生产册 `NONVISUAL_DEBT` 的每条都写了 `why` + `todo`（没有"历史原因"这种空话）', () => {
    expect(gate.NONVISUAL_DEBT.length).toBeGreaterThan(0);
    gate.NONVISUAL_DEBT.forEach((d) => {
      expect(typeof d.rel).toBe('string');
      expect(d.rel.startsWith('scripts/smoke/')).toBe(true);
      expect(typeof d.name).toBe('string');
      expect(d.why.length).toBeGreaterThan(20);
      expect(d.todo.length).toBeGreaterThan(10);
    });
  });

  it('触发数下限：声称可见性的断言少于下限 ⇒ 判红（删掉名字里的词不能让它闭嘴）', () => {
    const r = judge([{ name: '圆钮可见', body: WITH_HIT_TEST }], { minTriggered: 6 });
    expect(r.floorOk).toBe(false);
    expect(r.ok).toBe(false);
    expect(r.problems).toEqual([]);       // 红的原因是"输入被绕过"，不是"有违规"
  });

  it('下限在生产路径**不可由被检查方决定**：`MIN_TRIGGERED` 是常量，`opts` 只供单测', () => {
    expect(gate.MIN_TRIGGERED).toBe(Math.max(1, gate.MIN_TRIGGERED));
    expect(gateSrc).toMatch(/opts\.minTriggered\s*:\s*MIN_TRIGGERED/);
    expect(gateSrc).toMatch(/只给单测改/);
  });
});

/* ============================================================
 * ⑤ ★ 能力边界（`testing-for-ai` B8「边界写进文档」+ H3「判据自身也要做对照实验」）
 *
 *  下面三条**断言的是"门禁判不了"这件事本身**。它们看起来像在"给门禁放水"，
 *  实际是唯一能把"边界"从散文变成可执行事实的办法：
 *    · 若哪天有人给 `analyze()` 加了语义分析（真的去比较命中结果），`边界①` 会红
 *      ⇒ 那正好提醒他"文件头的边界声明现在过期了，同批改掉"。
 *    · 若哪天 `边界②` 变红（名字里没词的断言被扫到了），说明扫描面扩大了 —— 也要改文档。
 * ============================================================ */
describe('V1 能力边界：它判不了什么（用例守着"判不了"这件事）', () => {
  it('边界①：调了 `elementFromPoint` 却**从不比较结果** ⇒ 照样绿（它只读文本，不执行代码）', () => {
    // ⚠️ 这条断言在**语义上**是坏的：元素在视口内但被另一个元素盖住时，它什么也判不出来
    //    （elementFromPoint 的返回值被丢掉了）。V1 抓不到它 —— 因为 V1 的判据是字符串匹配。
    const body = [
      "await ctx.exec('document.elementFromPoint(cx, cy)');",   // 调了，但结果扔掉
      "const r = await ctx.exec('el.getBoundingClientRect()');",  // 真正拿来做判定的仍是 rect
      'return { ok: r.width > 8 };'
    ];
    const r = judge([{ name: '圆钮可见（不被遮挡）', body: body }]);
    expect(r.problems).toEqual([]);          // ← 判不了
    expect(r.judged[0].verdict).toBe('ok');  // ← 它以为这条是合规的
  });

  it('边界②：名字里**没有**可见性词的界面断言 ⇒ 完全不在扫描面上（名字是这门禁的输入）', () => {
    const r = judge([
      { name: '圆钮可点', body: BLIND_RECT },        // 名字不含触发词 ⇒ 不扫
      { name: '圆钮可见', body: WITH_HIT_TEST }
    ]);
    expect(r.assertions).toBe(2);      // 看到 2 条断言
    expect(r.triggered).toBe(1);       // 只审 1 条
    expect(r.problems).toEqual([]);
  });

  it('边界③：⚠️「元素在视口内但被另一个元素盖住」—— V1 **能认出该用哪种判据**，但**判不了用得对不对**', () => {
    // 这条把上面两条边界合成一句话的可执行版本：
    //   · 用 rect 判"没被遮挡" ⇒ **必红**（门禁知道 rect 对遮挡是盲的）✓
    //   · 用 elementFromPoint 判"没被遮挡" ⇒ **绿**，但无论命中结果是自身还是别的元素都绿 ✗
    //     （命中的比较写在哪里、怎么比较，V1 看不见 —— 那是读图与真机复核的活）
    const blind = judge([{ name: '圆钮不被遮挡', body: BLIND_RECT }]);
    expect(blind.problems.length).toBe(1);

    const correct = judge([{ name: '圆钮不被遮挡', body: ["const id = await ctx.exec('document.elementFromPoint(cx, cy).id');", 'return { ok: id === "n1" };'] }]);
    const alsoGreenIfWrong = judge([{ name: '圆钮不被遮挡', body: ["await ctx.exec('document.elementFromPoint(cx, cy)');", 'return { ok: true };'] }]);
    expect(correct.problems).toEqual([]);
    expect(alsoGreenIfWrong.problems).toEqual([]);   // ⇐ 同样绿：这就是能力天花板
  });

  it('边界④：本门禁**不做重活** —— 纯文本扫描（源码里没有起 Electron / 起服务 / 联网的调用）', () => {
    expect(gateSrc).not.toMatch(/require\('electron'\)/);
    expect(gateSrc).not.toMatch(/require\('http'\)|require\('https'\)|require\('net'\)/);
    expect(gateSrc).not.toMatch(/spawnSync|child_process/);
  });
});

/* ============================================================
 * ⑥ 欠账册的封闭性（`DEBT`：在册算欠账 · 不在册一律判红 · 修好忘销账 ⇒ 判红）
 * ============================================================ */
describe('V1 既有欠账册：封闭、只减不增、修好忘销账要红', () => {
  const entry = (rel, name) => ({ rel: rel, name: name, why: '单测夹具：当初只能这么判', fix: '单测夹具：迁到命中测试' });
  const blindSrc = fixtureSrc([{ name: '圆钮可见', body: BLIND_RECT }]);

  it('在册的违规 ⇒ 进 `debts` 而不是 `problems`（欠账计数可见、不判红）', () => {
    const r = gate.analyze([{ rel: 'scripts/smoke/99-probe.js', src: blindSrc }],
      [entry('scripts/smoke/99-probe.js', '圆钮可见')], { minTriggered: 1 });
    expect(r.problems).toEqual([]);
    expect(r.debts.length).toBe(1);
    expect(r.debts[0].why).toContain('当初只能这么判');
    expect(r.ok).toBe(true);
  });

  it('不在册的同类违规 ⇒ 判红（新代码不许再写盲判据）', () => {
    const r = gate.analyze([{ rel: 'scripts/smoke/99-probe.js', src: blindSrc }], [], { minTriggered: 1 });
    expect(r.problems.length).toBe(1);
    expect(r.ok).toBe(false);
  });

  it('★ 修好忘销账 ⇒ **判红**（册上那条已经不是违规了，逼人销账）', () => {
    const fixedSrc = fixtureSrc([{ name: '圆钮可见', body: WITH_HIT_TEST }]);
    const r = gate.analyze([{ rel: 'scripts/smoke/99-probe.js', src: fixedSrc }],
      [entry('scripts/smoke/99-probe.js', '圆钮可见')], { minTriggered: 1 });
    expect(r.problems).toEqual([]);
    expect(r.staleDebt.length).toBe(1);
    expect(r.staleDebt[0].name).toBe('圆钮可见');
    expect(r.ok).toBe(false);
  });

  it('生产欠账册当前是**空**的（七条已迁完）；机制本身仍在（空数组不等于删掉判定）', () => {
    expect(Array.isArray(gate.DEBT)).toBe(true);
    expect(gate.DEBT.length).toBe(0);
    expect(gateSrc).toMatch(/const DEBT = \[/);
  });
});

/* ============================================================
 * ⑦ 对**真实仓库**跑一次：当前应该是干净的
 * ============================================================ */
describeOnRealGate('V1 对真实仓库的读数：应当是干净的（exit 0 的那一半）', () => {
  /* ⚠️ 读真仓库必须**懒执行**（放在 `it()` 里）：`describe.skip` 仍会执行一次收集回调，
   *    而副本的 `ROOT` 指不到 `scripts/smoke` ⇒ 在收集期读盘会 ENOENT 并让整个文件收集失败
   *    （实测踩到：注入证明那次报的是 "scandir …\.review\…\scripts\smoke"，而不是"用例红了"）。 */
  const realRead = () => gate.analyze(gate.loadSmokeFiles());

  it('真实仓库：0 新违规 / 0 悬挂欠账 / 触发数不低于下限', () => {
    const r = realRead();
    expect(r.scansOk).toBe(true);
    expect(r.problems.map((p) => p.rel + ':' + p.name)).toEqual([]);
    expect(r.staleDebt).toEqual([]);
    expect(r.floorOk).toBe(true);
    expect(r.ok).toBe(true);
  });

  it('读数可见：文件数 / 断言数 / 触发数 / 有真判据条数都是正整数（不是"扫了个空还自称通过"）', () => {
    const r = realRead();
    expect(r.files).toBeGreaterThan(0);
    expect(r.assertions).toBeGreaterThan(0);
    expect(r.triggered).toBeGreaterThanOrEqual(gate.MIN_TRIGGERED);
    expect(r.judged.filter((x) => x.verdict === 'ok').length).toBeGreaterThan(0);
  });

  it('门禁自带的 `--selftest`（内存内注入 ⇒ 必红 ⇒ 撤销 ⇒ 复绿）当前通过', () => {
    const s = gate.selftest();
    expect(s.steps.map((x) => x.name + ' ⇒ ' + x.ok)).toEqual(s.steps.map((x) => x.name + ' ⇒ true'));
    expect(s.ok).toBe(true);
  });
});

/* ============================================================
 * ⑧ ★ 判别力证明的可重复版本（`testing-for-ai` B4）
 *    目标：把 `scripts/visibility-judge-check.js` 的**判据**在**副本**里改坏
 *    （删掉 `elementFromPoint` 这一类真判据的识别）⇒ 上面的反例用例必须红；
 *    真文件**一个字节都没被改**（前后 sha 比对）。
 *    这里只做"内存里改坏"：改的是**加载进内存的字符串**，不落盘 ⇒
 *    与"在副本文件里做"等价，且天然不可能污染真文件（落盘版见 .review 的注入记录）。
 * ============================================================ */
describe('V1 判别力：判据被改坏 ⇒ 反例/正例必须跟着翻', () => {
  const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

  it('★ 抹掉全部真判据的字面量（`zeroRealJudges`）⇒ 原本合规的正例**必红**', () => {
    const before = sha(GATE_ABS);
    // ⚠️ 夹具必须长成**真实仓库的形状**：合规断言通常是「真判据 + 若干几何判据」混写。
    //    抹掉真判据后**还留着盲判据**才会判红 —— 只留真判据的那种会掉进 'nonvisual'（见下一条边界）。
    const src = fixtureSrc([{ name: '圆钮完整落在面板内', body: WITH_HIT_TEST.concat(BLIND_RECT) }]);
    expect(gate.analyze([{ rel: 'scripts/smoke/99-probe.js', src: src }], [], { minTriggered: 1 }).problems).toEqual([]);

    const broken = gate.zeroRealJudges(src);
    expect(broken).not.toBe(src);                    // 注入确实改到了东西（否则这条判据是空的）
    const r = gate.analyze([{ rel: 'scripts/smoke/99-probe.js', src: broken }], [], { minTriggered: 1 });
    expect(r.problems.length).toBe(1);               // ← 必红
    expect(r.problems[0].name).toBe('圆钮完整落在面板内');
    expect(r.problems[0].blind.join(' ')).toContain('getBoundingClientRect');
    expect(sha(GATE_ABS)).toBe(before);              // 磁盘上的门禁一个字节没动
  });

  it('★ 缝 (b) 已收口：抹掉真判据**且体内无盲判据** ⇒ 判红（修前只降级为"只报告"）', () => {
    // 2026-10-20 修复前的现状（如实留档）：这条会 `problems=[]`、`nonVisual=1`、`ok=true` ——
    //   即"把一条合规断言里的 rect 删干净、名字保留可见"就能让守卫**静默闭嘴**。
    // 修后：它进了 `problems`（verdict='nonvisual'）⇒ 判红。`analyze()` 里那条
    //   "只 push 不判红"的分支原文也一并钉住**已消失**（否则等于缝又长回来了）。
    const src = fixtureSrc([{ name: '圆钮可见', body: WITH_HIT_TEST }]);
    const r = gate.analyze([{ rel: 'scripts/smoke/99-probe.js', src: gate.zeroRealJudges(src) }], [], { minTriggered: 1 });
    expect(r.problems.length).toBe(1);
    expect(r.problems[0].verdict).toBe('nonvisual');
    expect(r.ok).toBe(false);
    expect(gateSrc).not.toContain("verdict === 'nonvisual') { nonVisual.push(row); continue; }");
  });

  it('★ 把"真判据清单"换成只剩命中测试（模拟"删掉像素判据那一步"）⇒ 只用像素的断言必红', () => {
    // 事故复现：门禁上线时仓库里只有一条合规断言，且 6 条**同时**用了两类判据 ——
    // 只抹 `elementFromPoint` 时它仍靠 `scanRegion` 合规 ⇒ 门禁**照样绿**（注入选错了对象）。
    // 这条用例把那个教训钉成事实：**判据清单少一类，对应的正例就必须塌**。
    const realJudges = gate.REAL_JUDGES;
    expect(realJudges.map((j) => j.token)).toContain('elementFromPoint');
    expect(realJudges.map((j) => j.token)).toContain('scanRegion');
    const onlyHitTest = realJudges.filter((j) => j.token === 'elementFromPoint');
    const src = fixtureSrc([{ name: '关联条看得见', body: WITH_PIXELS }]);
    // 用"只留命中测试"的清单重算（与 `analyze` 同一套判据语义：黑名单 = 其余一律不认）
    const code = gate.judgeView(src);
    const recognised = onlyHitTest.filter((j) => code.indexOf(j.token) >= 0);
    const actuallyUsed = realJudges.filter((j) => code.indexOf(j.token) >= 0);
    expect(actuallyUsed.length).toBe(1);             // 真清单认得出 scanRegion
    expect(recognised.length).toBe(0);               // 被砍掉那一类后就认不出了 ⇒ 判据清单是判定的唯一来源
  });

  it('★ 删掉"抹名字"那一步（`judgeView` 的 `name:` 处理）⇒ 名字里的字面量会被当成判据（空转复现）', () => {
    // `judgeView` = 去注释 + 把 `name: '…'` 抹成 `name: ''`。少了第二步，
    // 一条"名字里写着 elementFromPoint、代码里只有 rect"的断言就会被判成合规 ——
    // 这正是历史上那次**门禁空转**的机制，所以这里用两个视图对比证明它必须存在。
    const src = fixtureSrc([{ name: '圆钮完整落在面板内（elementFromPoint 命中）', body: BLIND_RECT }]);
    const withMask = gate.expandSnippets(gate.judgeView(src), gate.judgeView(src));
    const withoutMask = gate.expandSnippets(gate.stripComments(src), gate.stripComments(src));
    expect(withMask.indexOf('elementFromPoint')).toBeLessThan(0);      // 抹掉后：认不出（⇒ 判红 ✓）
    expect(withoutMask.indexOf('elementFromPoint')).toBeGreaterThan(0); // 没抹：名字里的字就"成了判据" ✗
    expect(gate.findAssertions(src).length).toBe(1);                   // 断言本身认得出来（不是夹具写坏了）
  });
});

/* ============================================================
 * ⑨ 真实 `scripts/smoke/*.js` **只读**（本文件一个字节都不许写它）
 * ============================================================ */
describeOnRealGate('V1 单测不碰真文件', () => {
  it('扫过的真实冒烟域文件 sha 在本文件运行前后一致', () => {
    const files = fs.readdirSync(path.join(ROOT, 'scripts', 'smoke')).filter((f) => /^\d+-.+\.js$/.test(f)).sort();
    const before = files.map((f) => crypto.createHash('sha256')
      .update(fs.readFileSync(path.join(ROOT, 'scripts', 'smoke', f))).digest('hex'));
    gate.analyze(gate.loadSmokeFiles());
    const after = files.map((f) => crypto.createHash('sha256')
      .update(fs.readFileSync(path.join(ROOT, 'scripts', 'smoke', f))).digest('hex'));
    expect(after).toEqual(before);
    expect(files.length).toBeGreaterThan(0);
  });
});
