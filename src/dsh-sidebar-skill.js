/* ============================================================
 * src/dsh-sidebar-skill.js — 侧栏 AI 指针 skill 的内容生成（纯函数）
 * ------------------------------------------------------------
 * 内嵌 DSH 实例的笔记编辑能力注入（v0.16.1「边聊边编辑」）：
 * 应用首次孵化内嵌实例时，把本函数生成的 SKILL.md 写入
 * `dsh-home/skills/ai-mind-map/`——DSH 的 skill 发现机制扫描该目录
 * （dsh-skill-filesystem 源码核实），侧栏 AI 的 skill 列表即出现本工程。
 *
 * 设计要点：
 *   · **指针型**：内容只写"真源在哪、先读什么、怎么调 CLI"，不复制工程文档
 *     （避免双副本漂移）；真源路径变化时由调用方重写（幂等）。
 *   · **边界写死在内容里**：只做笔记内容编辑、写完 validate 一次、
 *     绝不跑 verify、不改应用代码 —— 这是"编辑笔记 vs 功能迭代"分流的
 *     动作现场载体（RULES M3）。
 * ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('path'));
  } else {
    root.MMDshSidebarSkill = factory(null);
  }
})(typeof self !== 'undefined' ? self : this, function (path) {
  'use strict';

  const SKILL_DIR_NAME = 'ai-mind-map';

  /**
   * 生成指针 skill 的 SKILL.md 内容。
   * @param {string} projectRoot 工程根绝对路径（侧栏 AI 的会话 cwd）
   * @returns {{ dirName: string, fileName: string, content: string }}
   */
  function buildSidebarSkillContent(projectRoot) {
    const cliPath = path
      ? path.join(projectRoot, 'cli', 'mm-cli.js')
      : projectRoot.replace(/[\\/]+$/, '') + '/cli/mm-cli.js';
    const content = [
      '---',
      'name: "ai-mind-map"',
      'description: "在 AI MindMap 里实时维护思维导图笔记：增删改节点/详情/标签、建链接、检索与审计。'
        + '只做笔记内容编辑（轻量：写完跑一次 validate 即可，绝不跑全量测试）。'
        + '触发：用户在对话里要求新增/修改/查找/整理笔记内容、把一段话整理进导图。"',
      '---',
      '',
      '# AI MindMap 笔记编辑',
      '',
      '本 skill 由 AI MindMap 应用注入，**真源与全部文档在**：`' + projectRoot + '`',
      '',
      '开始操作前先读真源的 `SKILL.md`（导航）与 `docs/AI-GUIDE.md`（操作规范），',
      '所有读写都通过真源里的 CLI：',
      '',
      '```',
      'node "' + cliPath + '" read comnet --json --brief   # 读（当前 cwd 就是工程根时可省绝对路径）',
      'node cli/mm-cli.js ui-state --json                # 写前协调：界面有没有未保存编辑',
      'node cli/mm-cli.js add <项目> <父id> --topic 标题 --detail-md "Markdown 详情"',
      'node cli/mm-cli.js edit <项目> <id> --detail-md "…" --tags a,b',
      'node cli/mm-cli.js search <项目> 关键词 --json',
      'node cli/mm-cli.js validate <项目>',
      'node cli/mm-cli.js sidebar-only on               # 关掉左边思维导图页（**真卸载这一页**，要恢复：off）',
      '```',
      '',
      '## 边界（务必遵守）',
      '',
      '- **只做笔记内容**（add/edit/move/remove/link/search/assoc…）。写完跑一次',
      '  `node cli/mm-cli.js validate <项目>` 即可 —— **不要跑 `npm run verify`**，',
      '  那是给"改应用代码"用的全量回归，与笔记编辑无关。',
      '- **写前协调**：批量编辑前先跑 `node cli/mm-cli.js ui-state --json`。',
      '  返回 `dirty: true` = 主界面有未保存编辑 —— 先请用户保存（或确认丢弃），',
      '  再动笔；否则用户一保存就会把你刚写的内容覆盖掉（白做工）。',
      '  `uiRunning: false` / `stale: true` = 界面没在跑或已退出，可以安全写入。',
      '  （信号来自 `projects/<项目>/.ui-state.json`，由主进程在脏标记变化时写入。）',
      '- **不要改应用代码**（renderer/ main*.js src/ vendor/…）：那属于功能迭代，',
      '  是用户在开发会话里做的事，不是侧栏对话的事。',
      '- **`sidebar-only on` 会真的把导图页从内存里卸掉**（不是隐藏）：界面有未保存编辑时',
      '  主进程会**拒绝**这条命令（报错里带原因）—— 那是在保人的改动，不是命令坏了。',
      '  重开用 `sidebar-only off`（会重新加载导图页，比原来慢一点）。',
      '- 编辑落盘后，界面会自动感知磁盘变化并刷新导图（文件监听已内置），无需额外操作。',
      ''
    ].join('\n');
    return { dirName: SKILL_DIR_NAME, fileName: 'SKILL.md', content };
  }

  return { SKILL_DIR_NAME, buildSidebarSkillContent };
});
