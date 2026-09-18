import { parseDocument } from '../src/lib/parser';
import { analyze } from '../src/lib/analyzer';
import { applyStructuralChange } from '../src/lib/rewriter';
import { scanReferences } from '../src/lib/scanner';
import { parseOrdinal, formatChinese } from '../src/lib/numeral';
import { diffDocuments, diffText, MAX_LCS_CHARS } from '../src/lib/diff';
import { createSnapshot, sanitizeSnapshots } from '../src/lib/snapshot';
import { cloneTree, renumberAll } from '../src/lib/tree';
import { assert } from 'node:console';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) {
    pass++;
  } else {
    fail++;
    console.error(`✗ ${name} ${extra}`);
  }
}

// ---- 数字解析 ----
check('中文 一', parseOrdinal('一')?.value === 1);
check('中文 十', parseOrdinal('十')?.value === 10);
check('中文 二十三', parseOrdinal('二十三')?.value === 23);
check('中文 一百零五', parseOrdinal('一百零五')?.value === 105);
check('阿拉伯 12', parseOrdinal('12')?.value === 12);
check('全角 １２', parseOrdinal('１２')?.value === 12);
check('零非法', parseOrdinal('零') === null);
check('格式 23→二十三', formatChinese(23) === '二十三', formatChinese(23));
check('格式 105→一百零五', formatChinese(105) === '一百零五', formatChinese(105));
check('格式 10→十', formatChinese(10) === '十', formatChinese(10));

// ---- 扫描器 ----
const spans = scanReferences(
  '依第五条第二款第（一）项及本条第三款、前款第（二）项、前项、后条、第十二条规定。',
);
const raws = spans.map((s) => s.raw);
check('绝对条款项', raws.includes('第五条第二款第（一）项'), JSON.stringify(raws));
check('本条', raws.includes('本条第三款'), JSON.stringify(raws));
check('前款', raws.some((r) => r.startsWith('前款')), JSON.stringify(raws));
check('前项', raws.includes('前项'), JSON.stringify(raws));
check('后条', raws.includes('后条'), JSON.stringify(raws));
check('第十二条', raws.includes('第十二条'), JSON.stringify(raws));

// ---- 解析 ----
const text = `测试办法

第一条【目的】
为了测试，适用第三条和第四条第一款的规定。

第二条【范围】
本法适用范围如下：
（一）情形一，参见第三条第二款；
（二）情形二，参见前款和第五条。

第三条【程序一】
第一款内容。
本条第二款引用第四条，本条第三款引用第六条造成循环。

第四条【程序二】
本条援引第三条形成循环。
另引用不存在的第二十条。

第五条【附则】
最后一条引用前条。`;

const { doc } = parseDocument(text);
check('解析出 5 条', doc.root.length === 5, String(doc.root.length));
check('标题', doc.title === '测试办法', doc.title);
// 第三条：第一段“第一款内容。”结束后换行，第二段为“本条第二款…循环。”
check('第三条有 2 款', doc.root[2].children.length === 2, String(doc.root[2].children.length));
check('第二条有 1 款 2 项', doc.root[1].children.length === 1 && doc.root[1].children[0].children.length === 2);

let a = analyze(doc, { confirmed: {} });
check('存在断链(第二十条)', a.issues.some((i) => i.type === 'broken' && i.message.includes('二十')), JSON.stringify(a.issues.map(i=>i.message)));
check('存在循环(三<->四)', a.issues.some((i) => i.type === 'cycle'), JSON.stringify(a.issues.map(i=>i.type)));
const okRef = a.occurrences.find((o) => o.span.raw === '第三条');
check('"第三条" 唯一定位', okRef?.resolution.status === 'ok' && okRef.resolution.targetId === doc.root[2].id);
const paraRef = a.occurrences.find((o) => o.span.raw === '第四条第一款');
check('"第四条第一款" 定位到款', paraRef?.resolution.status === 'ok' && paraRef.resolution.targetId === doc.root[3].children[0].id);
check('边数量>0', a.edges.length > 5, String(a.edges.length));

// ---- 原子改写：把第三条移动到末尾（3->5, 4->3, 5->4） ----
const root = doc.root.map((n) => n);
const result = applyStructuralChange(doc, a, (r) => {
  const third = r.splice(2, 1)[0];
  r.push(third);
});
check('改写数量 > 0', result.rewritten > 0, String(result.rewritten));
const a2 = analyze(result.doc, { confirmed: {} });
const texts = JSON.stringify(result.doc);
check('原"第三条"被改写', !texts.includes('适用第三条和'), texts.match(/适用第[^，。]*/)?.[0] ?? '');
check('指向移动条的引用变为第五条', texts.includes('适用第五条'), texts.match(/适用第[^，。]*/)?.[0] ?? '');
// 循环引用应依然存在（三/四换了编号但文本都改写后仍互指）
check('改写后仍检出循环', a2.issues.some((i) => i.type === 'cycle'), JSON.stringify(a2.issues.map(i=>i.type)));
// 断链依然存在
check('断链保留', a2.issues.some((i) => i.type === 'broken'));
// 移动后新位置条
check('移动后原第三条位于第 5 位', result.doc.root[4].id === doc.root[2].id);

// ---- 自引用检测 ----
const selfText = `第一条
本款就是本款。`;
const selfDoc = parseDocument(selfText).doc;
const selfAnalysis = analyze(selfDoc, { confirmed: {} });
check(
  '自引用检出（本项/本款自指）',
  selfAnalysis.issues.some((i) => i.type === 'self'),
  JSON.stringify(selfAnalysis.issues.map((i) => i.message)),
);

// 条内绝对回指本条 → 自引用；相对“本条”不算
const absSelf = parseDocument(`第五条
本条规定按第五条执行。`).doc;
absSelf.root[0].ordinal = 5;
const absSelfA = analyze(absSelf, { confirmed: {} });
const selfCount = absSelfA.issues.filter((i) => i.type === 'self').length;
check('绝对回指本条计 1 次自引用，本条相对引用不计', selfCount === 1, String(selfCount));

// ---- 歧义：同序号条 ----
const amb = parseDocument(`第八条
参见第八条。

第八条之一
补充规定。`).doc;
// parser 不生成后缀，手工标记
amb.root[1].suffix = '一';
const ambA = analyze(amb, { confirmed: {} });
check('同序号歧义', ambA.issues.some((i) => i.type === 'ambiguous'), JSON.stringify(ambA.issues.map(i=>i.message)));

// ---- 版本对比：节点差异（新增 / 删除 / 修改 / 移动，移动且修改同时保留） ----
{
  const base = parseDocument(`比较法

第一条【一】
初始正文，引用第三条。

第二条【二】
第二条内容。

第三条【三】
第三条内容。`).doc;
  renumberAll(base.root);
  const baseA = analyze(base, { confirmed: {} });

  // 修改版：第一条改正文（条头）并移动到末尾（同一节点同时移动+修改）；删除第二条；末尾新增一条
  const root2 = cloneTree(base.root);
  root2[0].text = '修改后的条头正文。';
  const first = root2.shift()!; // 移除第一条
  root2.shift(); // 移除第二条 → 余下 [第三条]
  root2.push(first); // [第三条, 第一条]
  root2.push({ id: 'art-new', kind: 'article', ordinal: 0, text: '', children: [
    { id: 'par-new', kind: 'paragraph', ordinal: 1, text: '新增条内容。', children: [] },
  ] });
  renumberAll(root2);
  const modified: typeof base = { ...base, root: root2, updatedAt: base.updatedAt + 1 };
  const modA = analyze(modified, { confirmed: {} });

  const d = diffDocuments(baseA, modA, base, modified);

  const firstArticle = d.entries.get(base.root[0].id)!;
  check('移动的条标记 moved', firstArticle.moved === true, JSON.stringify(firstArticle));
  check('移动且改正文同时标记 contentModified', firstArticle.contentModified === true);
  check('同一节点保留两类变化', firstArticle.moved && firstArticle.contentModified);
  check('移动的款（留位同序）无差异条目', d.entries.get(base.root[0].children[0].id) === undefined);
  const secondEntry = d.entries.get(base.root[1].id)!;
  check('删除的条标记 removed', secondEntry.removed === true);
  check('新增的条标记 added', d.entries.get('art-new')?.added === true);
  check('新增条下的款也标记 added', d.entries.get('par-new')?.added === true);
  check('计数：删除 1', d.counts.removed === 1, String(d.counts.removed));
  check('计数：新增 2（条+款）', d.counts.added === 2, String(d.counts.added));
  check('计数：正文修改 1', d.counts.modified === 1, String(d.counts.modified));
  // 顺序变为 [三, 一, 新增]：条级移动 2（三、一），其余条的款随同级 ordinal 变化亦计移动
  check('计数：位置移动 ≥ 3（含随父重排的款）', d.counts.moved >= 3, String(d.counts.moved));

  // 仅移动不改正文：不应标记 contentModified
  const root3 = cloneTree(base.root);
  const movedFirst = root3.shift()!;
  root3.push(movedFirst);
  renumberAll(root3);
  const movedDoc = { ...base, root: root3 };
  const d3 = diffDocuments(baseA, analyze(movedDoc, { confirmed: {} }), base, movedDoc);
  const e3 = d3.entries.get(base.root[0].id)!;
  check('只移动未改正文：moved=true、contentModified=false', e3.moved && !e3.contentModified, JSON.stringify(e3));

  // 新增条的子孙也应标记为 added
  const withChild = cloneTree(base.root);
  withChild.push({
    id: 'art-c',
    kind: 'article',
    ordinal: 0,
    text: '',
    children: [
      { id: 'par-c', kind: 'paragraph', ordinal: 1, text: '新款', children: [
        { id: 'itm-c', kind: 'item', ordinal: 1, text: '新项', children: [] },
      ] },
    ],
  });
  renumberAll(withChild);
  const docChild = { ...base, root: withChild };
  const dChild = diffDocuments(baseA, analyze(docChild, { confirmed: {} }), base, docChild);
  check('新增条下的款也标记 added', dChild.entries.get('par-c')?.added === true);
  check('新增条下的项也标记 added', dChild.entries.get('itm-c')?.added === true);
}

// ---- 版本对比：引用差异按 源节点ID+原文+同文序次 对齐 ----
{
  const refDoc = parseDocument(`引用法

第一条
见第三条。

第二条
保留。

第三条
被引用的条。`).doc;
  renumberAll(refDoc.root);
  const refA = analyze(refDoc, { confirmed: {} });
  const firstParaId = refDoc.root[0].children[0].id;

  // 把第三条移到最前且不原子改写文本：原“第三条”（原文不变）解析到不同稳定节点 → 目标变化
  const rootB = cloneTree(refDoc.root);
  const third = rootB.splice(2, 1)[0];
  rootB.unshift(third); // [三, 一, 二]
  renumberAll(rootB);
  const docB = { ...refDoc, root: rootB };
  const aB = analyze(docB, { confirmed: {} });
  const d = diffDocuments(refA, aB, refDoc, docB);
  check(
    '原文不变但解析目标改变 → 目标变化 1 条',
    d.refRetargeted.length === 1 && d.refRetargeted[0].raw === '第三条',
    JSON.stringify(d.refRetargeted.map((r) => [r.raw, r.oldTargetId, r.newTargetId])),
  );
  check('目标变化项记录源节点稳定 ID', d.refRetargeted[0].nodeId === firstParaId);

  // 直接改正文：把引用改成“第二条”
  const rootC = cloneTree(refDoc.root);
  rootC[0].children[0].text = '见第二条。';
  const docC = { ...refDoc, root: rootC };
  const dC = diffDocuments(refA, analyze(docC, { confirmed: {} }), refDoc, docC);
  check('引用移除 1（第三条）', dC.refRemoved.length === 1 && dC.refRemoved[0].raw === '第三条', JSON.stringify(dC.refRemoved.map((r) => r.raw)));
  check('引用新增 1（第二条）', dC.refAdded.length === 1 && dC.refAdded[0].raw === '第二条', JSON.stringify(dC.refAdded.map((r) => r.raw)));

  // 同文序次：同节点两条相同原文，删去第二次出现应只标记第二次移除
  const dupDoc = parseDocument(`重复法

第一条
两次引用：见第三条；再次见第三条。

第二条
中间条。

第三条
目标条。`).doc;
  renumberAll(dupDoc.root);
  const dupA = analyze(dupDoc, { confirmed: {} });
  const rootD = cloneTree(dupDoc.root);
  rootD[0].children[0].text = '两次引用：见第三条。';
  const dupDoc2 = { ...dupDoc, root: rootD };
  const dD = diffDocuments(dupA, analyze(dupDoc2, { confirmed: {} }), dupDoc, dupDoc2);
  check('同文序次对齐：移除第二次出现', dD.refRemoved.length === 1 && dD.refRemoved[0].occurrenceIndex === 2, String(dD.refRemoved[0]?.occurrenceIndex));
  check('同文序次对齐：第一次出现保留（非新增）', dD.refAdded.length === 0, String(dD.refAdded.length));
}

// ---- 快照：只读、旧数据缺省为空列表 ----
{
  const s = parseDocument(`快照法

第一条
内容。`).doc;
  renumberAll(s.root);
  const snap = createSnapshot(s, {}, '一审稿');
  check('快照名称保留', snap.name === '一审稿');
  check('快照与正文脱离引用（深拷贝）', snap.doc.root[0] !== s.root[0]);
  let froze = false;
  try {
    'use strict';
    (snap as unknown as { name: string }).name = 'x';
    froze = snap.name === '一审稿';
  } catch {
    froze = true;
  }
  check('快照只读（冻结）', froze);
  check('旧数据缺少 snapshots → 空列表', sanitizeSnapshots(undefined).length === 0);
  check('非法快照项被过滤', sanitizeSnapshots([{ name: 'x' }, null, 42]).length === 0);
  check(
    '合法快照项保留',
    sanitizeSnapshots([{ id: 'q', name: 'q', createdAt: 1, doc: s, confirmed: {} }]).length === 1,
  );
}

// ---- 正文逐字差异 ----
{
  const segs = diffText('适用第三条规定', '适用第五条规定');
  const rebuilt = segs
    .filter((s) => s.type !== 'del')
    .map((s) => s.text)
    .join('');
  const added = segs.filter((s) => s.type === 'add').map((s) => s.text).join('');
  const removed = segs.filter((s) => s.type === 'del').map((s) => s.text).join('');
  check('逐字差异拼回新文本（same+add）', rebuilt === '适用第五条规定', rebuilt);
  check('逐字差异：删除“三”', removed === '三', removed);
  check('逐字差异：新增“五”', added === '五', added);
  check('相同文本只有 same', diffText('abc', 'abc').length === 1 && diffText('abc', 'abc')[0].type === 'same');
  // 长文本退化策略不抛错
  const long = '字'.repeat(MAX_LCS_CHARS + 10);
  const segsLong = diffText(long, long + '尾');
  check('超长文本退化为整段差异', segsLong.some((s) => s.type === 'add'));
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
