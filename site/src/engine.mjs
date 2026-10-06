// 三阶段写时复制批次引擎：
//   阶段1 PAGES  先持久化全部新页（带代次 gen 与摘要 digest，内容寻址幂等）
//   阶段2 INTENT 再留下批次意图（batchId / editDigest / 新根 / 页清单）
//   阶段3 COMMIT 原子切换根指针并固化回执；随后清理意图
// 崩溃重开时只看持久化证据：
//   意图缺失              -> 查询视图停在旧根，半写入页是不可达孤儿
//   意图存在且新树可闭合  -> 发布新根（根可完整遍历）
//   意图存在但页缺失/损坏 -> 保留旧根，剔除未竟意图与孤儿页，给出原因

import {
  applyEdits, buildTree, closure, orderedLeaves, navigationProblems,
  rebuildTreeFromLeaves, RuleError, Writer, ORDER,
} from './bptree.mjs';
import { fnv1a64, stableStringify, verifyDigest } from './digest.mjs';

export const CRASH_POINTS = Object.freeze({
  NONE: 'none',
  DURING_PAGES: 'during-pages',
  AFTER_PAGES: 'after-pages',
  AFTER_INTENT: 'after-intent',
  AFTER_ROOT: 'after-root', // 根已切换、回执已固化，尚未清理意图
});

const K_ROOT = 'root';
const K_INTENT = 'intent';
const K_RECEIPT = (id) => 'receipt:' + id;
const K_PAGE = (id) => 'page:' + id;

export const MAX_INITIAL = 24;
export const MAX_EDITS = 12;
export const MAX_TEXT = 200;
export const MAX_BATCH_ID = 64;

export function canonicalEdits(edits) {
  return edits.map((e) => {
    const op = String(e.op ?? '').toLowerCase();
    const out = { op, key: Number(e.key) };
    if (op === 'insert' || op === 'update') out.value = String(e.value ?? '');
    return out;
  });
}

export function editDigestOf(edits) {
  return fnv1a64(stableStringify(canonicalEdits(edits)));
}

// 顺序脚本作用在已提交键集合上的结果（applyEdits 全成功后才使用）
function keysAfter(keySet, edits) {
  const next = new Set(keySet);
  for (const e of edits) {
    if (e.op === 'insert') next.add(e.key);
    else if (e.op === 'delete') next.delete(e.key);
  }
  return next;
}

// 校验前也要给回执一个摘要：对无法归一化的输入退化为原始串摘要
function safeEditDigest(edits) {
  try {
    return editDigestOf(edits);
  } catch {
    return fnv1a64(stableStringify(edits ?? null));
  }
}

// 同步校验：抛 RuleError 即拒绝，拒绝绝不产生任何写入
function validateRequest({ batchId, edits }) {
  if (typeof batchId !== 'string' || !batchId.trim() || batchId.length > MAX_BATCH_ID) {
    throw new RuleError('BAD_BATCH_ID', `批次标识须为 1..${MAX_BATCH_ID} 个字符的非空文本`);
  }
  if (!Array.isArray(edits) || edits.length === 0 || edits.length > MAX_EDITS) {
    throw new RuleError('BAD_EDIT_COUNT', `每批至多 ${MAX_EDITS} 项插入/更新/删除，且不能为空`);
  }
  for (const e of edits) {
    const op = String(e.op ?? '').toLowerCase();
    if (!['insert', 'update', 'delete'].includes(op)) {
      throw new RuleError('UNKNOWN_OP', `未知操作类型: ${e.op}`);
    }
    const key = Number(e.key);
    if (!Number.isInteger(key)) throw new RuleError('BAD_KEY', `键必须为整数: ${e.key}`);
    // 注意：批次是顺序脚本，允许“先插入后更新/删除”同一键；
    // 真正的重复插入（键在执行点已存在）由树精确判为 INSERT_EXISTS。
    if (op === 'insert' || op === 'update') {
      const v = e.value ?? '';
      if (typeof v !== 'string') throw new RuleError('BAD_VALUE', `键 ${key} 的载荷必须是短文本`);
      if (v.length > MAX_TEXT) throw new RuleError('BAD_VALUE', `键 ${key} 的载荷超过 ${MAX_TEXT} 字`);
    }
  }
}

function validateInitial(entries) {
  if (entries.length > MAX_INITIAL) {
    throw new RuleError('BAD_ENTRY_COUNT', `初始航点至多 ${MAX_INITIAL} 个`);
  }
  const seen = new Set();
  for (const [key, value] of entries) {
    if (!Number.isInteger(key)) throw new RuleError('BAD_KEY', `键必须为整数: ${key}`);
    if (seen.has(key)) throw new RuleError('DUPLICATE_KEY', `初始键 ${key} 重复`);
    seen.add(key);
    if (typeof value !== 'string' || value.length > MAX_TEXT) {
      throw new RuleError('BAD_VALUE', `键 ${key} 的载荷须为不超过 ${MAX_TEXT} 字的文本`);
    }
  }
}
function MAX_TEXT_TEXT_HINT() { return MAX_TEXT; }

export class Engine {
  constructor(store, { now = () => new Date().toISOString() } = {}) {
    this.store = store;
    this.now = now;
    this.state = null; // { rootId, gen, pages:Map, receipt? }
  }

  // 打开并执行断电重开复核，返回恢复结论；引擎状态在 this.state / this.lastRecovery
  async open() {
    const report = await this.recover();
    return report;
  }

  async loadPages(rootId) {
    const src = new Map();
    const collect = async (id) => {
      if (id == null || src.has(id)) return;
      const p = await this.store.get(K_PAGE(id));
      if (!p) throw new RuleError('BROKEN_REFERENCE', `无法闭合的子页引用: ${id}`);
      src.set(id, p);
      if (p.type === 'internal') for (const c of p.children) await collect(c);
    };
    await collect(rootId);
    return src;
  }

  // 校验已发布树的引用闭合与摘要（recover 时已填充 corrupt/loadProblems）
  verifyPublished() {
    if (this.state?.corrupt?.length) {
      throw new RuleError('CORRUPT_DIGEST', this.state.corrupt.join('；'));
    }
    if (this.state?.loadProblems?.length) {
      throw new RuleError('BROKEN_REFERENCE', this.state.loadProblems.join('；'));
    }
  }

  async abandonIntent(payload, reason) {
    await this.store.delete(K_INTENT);
    await this.store.put(K_RECEIPT(payload.batchId), {
      batchId: payload.batchId, editDigest: payload.editDigest, status: 'rolled-back',
      gen: payload.gen, reason, createdAt: this.now(),
    });
  }

  async recover() {
    const rootRec = await this.store.get(K_ROOT);
    const intent = await this.store.get(K_INTENT);

    if (!rootRec) {
      // 全新库
      this.state = { rootId: null, gen: 0, pages: new Map(), keySet: new Set(), empty: true, corrupt: [] };
      if (intent) await this.abandonIntent(intent, '无已发布根却存在意图，丢弃');
      return this.recoveryReport('FRESH', '空库，尚无已发布根');
    }

    const pages = new Map();
    const loadProblems = [];
    try {
      const m = await this.loadPages(rootRec.rootId);
      for (const [id, p] of m) pages.set(id, p);
    } catch (e) {
      loadProblems.push(e.message);
    }
    const corrupt = [];
    for (const p of pages.values()) {
      if (!verifyDigest(p)) corrupt.push(`已发布页 ${p.id} 摘要不匹配`);
    }
    const keySet = new Set(rootRec.keys ?? []);
    this.state = { rootId: rootRec.rootId, gen: rootRec.gen, pages, keySet, corrupt, loadProblems };

    // 已发布根在引用闭合、摘要合法之外，还必须满足“点查询不变量”：
    // 叶序列严格有序、与已提交键集合一致，且分隔键都在有效分界内、每个叶中键都能被查询路径命中。
    // 否则会出现“叶序审计通过、点查询却读不到叶中既有键”的失效视图。
    const structureProblems = loadProblems.length || corrupt.length
      ? []
      : treeEvidenceProblems(pages, rootRec.rootId, keySet);

    let report;
    if (loadProblems.length || corrupt.length) {
      // 已发布根自身不可信：绝不自动改写，批次操作一律拒绝直到人工处理
      report = this.recoveryReport('PUBLISHED_ROOT_UNHEALTHY',
        `已发布根（代次 ${rootRec.gen}）健康检查失败：${[...loadProblems, ...corrupt].join('；')}。冻结于该根，不发布任何新树`);
      if (intent) await this.abandonIntent(intent, '已发布根不健康，未竟意图不予执行');
    } else if (structureProblems.length) {
      // 页都在、摘要都对、叶序也完整，但分隔键已使查询视图失效：
      // 以经鉴权的叶序列为唯一事实源安全收敛，重建祖先页后重新发布，
      // 绝不继续把它当作健康的已发布版本展示。
      report = await this.repairPublishedRoot(rootRec, pages, keySet, structureProblems, intent);
    } else if (!intent) {
      report = this.recoveryReport('INTACT', '未发现未完成批次，查询视图即已发布根');
      await this.gcUnreachable(pages); // 上次断电在新页阶段留下的半写入孤儿
    } else if (intent.rootId === rootRec.rootId || intent.gen === rootRec.gen) {
      // 根已切换后在清理前断电
      await this.store.delete(K_INTENT);
      await this.gcUnreachable(pages);
      report = this.recoveryReport('NEW_ROOT_PUBLISHED',
        `批次 ${intent.batchId} 的根指针已切换（代次 ${intent.gen}），仅补完清理；新树可完整遍历`);
    } else if (intent.gen < rootRec.gen) {
      // 意图落后于已发布根（如修复重发代次后、遗留意图删除前再次断电）：
      // 意图已过期，直接作废（不写终局回滚回执，以便审查员用原批次标识重新提交），保留可查询根
      await this.store.delete(K_INTENT);
      await this.gcUnreachable(pages);
      report = this.recoveryReport('INTACT',
        `已发布根（代次 ${rootRec.gen}）可查询；批次 ${intent.batchId} 的遗留意图代次已过期，已作废`);
    } else {
      report = await this.resolvePending(intent);
    }
    return report;
  }

  // 已持久化的已发布根“叶序完好但查询视图失效”时的安全收敛：
  // 叶页全部通过摘要校验、按中序严格排列，故以叶序列为事实源重建全部内部页，
  // 新根代次 +1，与根指针原子发布；不触碰任何叶页（键与载荷原样保留）。
  async repairPublishedRoot(rootRec, pages, keySet, problems, intent) {
    const leaves = orderedLeaves(pages, rootRec.rootId);
    // 修复根代次严格高于旧根与任何在途意图代次：即便修复中在“切根后、删意图前”
    // 再次断电，重开也不会把在途意图误判成已提交批次（gen 不相等）。
    const gen = Math.max(rootRec.gen, intent?.gen ?? 0) + 1;
    const w = new Writer(pages, gen);
    const rebuiltRoot = rebuildTreeFromLeaves(w, leaves);
    const reachable = closure(w, rebuiltRoot);
    const newPages = new Map();
    for (const id of reachable) newPages.set(id, w.out.get(id) ?? pages.get(id));

    // 修复树必须自证：引用闭合、摘要合法、叶序与键集合一致、点查询不变量全部通过
    const recheck = treeEvidenceProblems(newPages, rebuiltRoot, keySet);
    if (recheck.length) {
      // 自愈失败（理论上不应发生）：冻结原根，绝不当作健康版本展示，任何批次拒绝写入
      this.state = {
        rootId: rootRec.rootId, gen: rootRec.gen, pages, keySet,
        corrupt: [], loadProblems: [`点查询视图失效且自愈失败：${recheck.join('；')}`],
      };
      if (intent) await this.abandonIntent(intent, '已发布根不健康，未竟意图不予执行');
      return this.recoveryReport('PUBLISHED_ROOT_UNHEALTHY',
        `已发布根（代次 ${rootRec.gen}）点查询视图失效且按叶序列重建后仍未通过核验：${recheck.join('；')}。已冻结原根，不发布任何新树`);
    }

    const leafKeys = [];
    for (const leaf of orderedLeaves(newPages, rebuiltRoot)) leafKeys.push(...leaf.keys);
    const writes = [];
    for (const p of newPages.values()) {
      if (w.out.has(p.id)) writes.push([K_PAGE(p.id), p]);
    }
    writes.push([K_ROOT, { _id: K_ROOT, rootId: rebuiltRoot, gen, keys: leafKeys.sort((a, b) => a - b) }]);
    writes.push([`repair:${rootRec.gen}`, {
      _id: `repair:${rootRec.gen}`, fromRootId: rootRec.rootId, rootId: rebuiltRoot,
      gen, fromGen: rootRec.gen, reason: problems.join('；'), repairedAt: this.now(),
    }]);
    await this.store.putMany(writes);
    if (intent) {
      // 该意图针对失效根算出，随修复一并作废；不写终局回执，审查员可用同一批次标识重新提交
      await this.store.delete(K_INTENT);
    }
    this.state = {
      rootId: rebuiltRoot, gen, pages: newPages,
      keySet: new Set(leafKeys), corrupt: [], loadProblems: [],
    };
    await this.gcUnreachable(newPages, rebuiltRoot);
    const intentNote = intent ? `；未竟批次 ${intent.batchId} 的意图已作废，可用原批次标识重新提交` : '';
    return this.recoveryReport('REPAIRED_ROOT_PUBLISHED',
      `已发布根（代次 ${rootRec.gen}）页摘要与引用均完好，但点查询视图失效（${problems.join('；')}）。` +
      `已按叶序列重建内部页并发布代次 ${gen} 可查询根，叶页键值原样保留${intentNote}`);
  }

  // 意图存在但根尚未切换：凭证据决定发布新根或退回旧根
  async resolvePending(intent) {
    const problems = [];
    const newPages = new Map(this.state.pages);
    for (const id of intent.pageIds) {
      const p = await this.store.get(K_PAGE(id));
      if (!p) { problems.push(`新页 ${id} 缺失（半写入）`); continue; }
      if (!verifyDigest(p)) { problems.push(`新页 ${id} 摘要损坏`); continue; }
      newPages.set(id, p);
    }
    let closureOk = true;
    if (problems.length === 0) {
      const w = { get: (id) => newPages.get(id) ?? null, out: new Map() };
      try {
        closure(w, intent.rootId);
      } catch (e) {
        closureOk = false;
        problems.push(e.message);
      }
    }

    // 引用闭合之后，还须验证点查询视图本身：叶序严格有序且与意图键集合一致、
    // 每个分隔键等于右子树最小叶键——避免“叶序审计通过却查不到叶中既有键”。
    if (problems.length === 0 && closureOk) {
      for (const msg of treeEvidenceProblems(newPages, intent.rootId, new Set(intent.keys ?? []))) {
        problems.push(msg);
      }
    }

    if (problems.length === 0 && closureOk) {
      // 证据完整：根指针（含键集合）与提交回执原子发布
      const receipt = await this.store.get(K_RECEIPT(intent.batchId));
      const writes = [[K_ROOT, {
        _id: K_ROOT, rootId: intent.rootId, gen: intent.gen,
        keys: [...(intent.keys ?? [])].sort((a, b) => a - b),
      }]];
      if (!receipt || receipt.gen !== intent.gen) {
        writes.push([K_RECEIPT(intent.batchId), committedReceipt(intent, this.now())]);
      }
      await this.store.putMany(writes);
      await this.store.delete(K_INTENT);
      this.state = {
        rootId: intent.rootId, gen: intent.gen, pages: newPages,
        keySet: new Set(intent.keys ?? []), corrupt: [], loadProblems: [],
      };
      await this.gcUnreachable(newPages, intent.rootId);
      return this.recoveryReport('NEW_ROOT_PUBLISHED',
        `批次 ${intent.batchId} 的新页与意图均完整，发布代次 ${intent.gen} 新根，新树可从根完整遍历，旧版本页已不可查询`);
    }

    // 证据不足：退回旧根，清理该批次孤儿页与未竟意图（根指针从未改变）
    await this.store.delete(K_INTENT);
    await this.gcUnreachable(this.state.pages);
    await this.store.put(K_RECEIPT(intent.batchId), {
      batchId: intent.batchId, editDigest: intent.editDigest, status: 'rolled-back',
      gen: intent.gen, reason: problems.join('；'), createdAt: this.now(),
    });
    return this.recoveryReport('OLD_ROOT_RETAINED',
      `批次 ${intent.batchId} 持久化证据不完整或点查询核验失败（${problems.join('；')}），保留代次 ${this.state.gen} 旧根，半写入页不进入查询视图`);
  }

  recoveryReport(conclusion, detail) {
    const report = { conclusion, detail, at: this.now(), gen: this.state?.gen ?? 0 };
    this.lastRecovery = report;
    return report;
  }

  async initialize(entriesInput) {
    const entries = entriesInput.map(([k, v]) => [Number(k), String(v ?? '')]);
    validateInitial(entries);
    if (this.state && this.state.rootId != null) {
      throw new RuleError('ALREADY_INITIALIZED', '索引已初始化，不能重复录入初始航点');
    }
    const gen = 1;
    const { rootId, pages: pageMap } = buildTree(gen, entries);
    const keys = entries.map(([k]) => k);
    // 先全部新页，最后切根——与批次同一套写时复制纪律
    for (const p of pageMap.values()) await this.store.put(K_PAGE(p.id), p);
    await this.store.put(K_ROOT, { _id: K_ROOT, rootId, gen, keys });
    this.state = { rootId, gen, pages: pageMap, keySet: new Set(keys), corrupt: [], loadProblems: [] };
    return this.snapshot();
  }

  // 清理指定根不可达的存储页（半写入孤儿 / 旧版本页），返回回收页数
  async gcUnreachable(keepPages, rootId = this.state.rootId) {
    const w = { get: (id) => keepPages.get(id) ?? null, out: new Map() };
    const keep = closure(w, rootId);
    const stored = await this.store.allPageIds();
    let removed = 0;
    for (const pk of stored) {
      const id = pk.slice(5);
      if (!keep.has(id)) {
        await this.store.delete(pk);
        removed++;
      }
    }
    return removed;
  }

  // 提交（或重试）一个批次。crashAt 用于复核演练断电中断。
  // 所有规则违反一律以 rejected 回执返回且不写任何页，绝不抛异常给调用方。
  async submitBatch(rawEdits, batchId, crashAt = CRASH_POINTS.NONE) {
    const editDigest = safeEditDigest(rawEdits);
    try {
      validateRequest({ batchId, edits: rawEdits });
    } catch (e) {
      if (e instanceof RuleError) return rejectReceipt(batchId, editDigest, e.code, e.message);
      throw e;
    }
    const edits = canonicalEdits(rawEdits);

    // 同批次重传：等价编辑 -> 回放原回执；内容不同 -> 冲突拒绝
    const prior = await this.store.get(K_RECEIPT(batchId));
    if (prior) {
      if (prior.editDigest !== editDigest) {
        return rejectReceipt(batchId, editDigest, 'CONFLICT_BATCH_CONTENT',
          `批次标识 ${batchId} 已用于不同内容的编辑（原摘要 ${prior.editDigest}），拒绝改写历史`);
      }
      return { ...prior, replayed: true };
    }

    // 已发布树损坏保护：任何批次都不得改变不可信根
    try {
      this.verifyPublished();
    } catch (e) {
      return rejectReceipt(batchId, editDigest, e.code, e.message);
    }

    const intent = await this.store.get(K_INTENT);
    if (intent && intent.batchId === batchId) {
      // 上次中断在同批次且尚无回执：等价编辑继续/完成它（走正常三阶段，内容寻址幂等覆盖）
    } else if (intent) {
      return rejectReceipt(batchId, editDigest, 'OTHER_BATCH_PENDING',
        `尚有批次 ${intent.batchId} 未完成恢复判定，请先重开复核`);
    }

    const gen = this.state.gen + 1;
    let result;
    try {
      result = applyEdits(this.state.pages, this.state.rootId, gen, edits);
    } catch (e) {
      if (e instanceof RuleError) return rejectReceipt(batchId, editDigest, e.code, e.message);
      throw e;
    }
    // applyEdits 成功即代表全部编辑有效；计算提交后的已发布键集合（与根同事务落盘）
    const nextKeys = [...keysAfter(this.state.keySet ?? new Set(), edits)].sort((a, b) => a - b);

    const newPages = [...result.pages.values()];
    const intentRec = {
      batchId, editDigest, gen, rootId: result.rootId, keys: nextKeys,
      pageIds: newPages.map((p) => p.id), createdAt: this.now(),
    };

    // 阶段 1：逐页持久化（崩溃可留下部分半写入页）
    for (let i = 0; i < newPages.length; i++) {
      await this.store.put(K_PAGE(newPages[i].id), newPages[i]);
      if (crashAt === CRASH_POINTS.DURING_PAGES && i === 0) {
        return crashAck(batchId, editDigest, gen, 'PAGES',
          `断电于新页写入途中：${i + 1}/${newPages.length} 页已落盘，无意图、根未切换`);
      }
    }
    if (crashAt === CRASH_POINTS.AFTER_PAGES) {
      return crashAck(batchId, editDigest, gen, 'PAGES',
        `断电于新页全部写入后、意图留下前：${newPages.length} 页成为旧根不可达的孤儿候选`);
    }

    // 阶段 2：留下批次意图
    await this.store.put(K_INTENT, intentRec);
    if (crashAt === CRASH_POINTS.AFTER_INTENT) {
      return crashAck(batchId, editDigest, gen, 'INTENT',
        '断电于意图持久化后、根切换前：重开时凭页与意图证据决定发布或退回');
    }

    // 阶段 3：根指针（含键集合）与提交回执在同一事务原子固化（要么都生效要么都不生效）
    await this.store.putMany([
      [K_ROOT, { _id: K_ROOT, rootId: result.rootId, gen, keys: nextKeys }],
      [K_RECEIPT(batchId), committedReceipt(intentRec, this.now())],
    ]);
    if (crashAt === CRASH_POINTS.AFTER_ROOT) {
      return crashAck(batchId, editDigest, gen, 'COMMIT',
        '断电于根切换后、意图清理前：新根已经是可查询视图，重开仅补清理');
    }
    await this.store.delete(K_INTENT);
    // 回收旧版本页：新根不可达的页一律清除，任何时刻可查询视图只含当前根
    const combined = this.allPagesAfter(result);
    await this.gcUnreachable(combined, result.rootId);

    this.state = { rootId: result.rootId, gen, pages: combined, keySet: new Set(nextKeys), corrupt: [], loadProblems: [] };
    return { ...committedReceipt(intentRec, this.now()), replayed: false };
  }

  allPagesAfter(result) {
    const all = new Map(this.state.pages);
    for (const [id, p] of result.pages) all.set(id, p);
    const w = { get: (id) => all.get(id) ?? null, out: new Map() };
    const keep = closure(w, result.rootId);
    for (const id of [...all.keys()]) if (!keep.has(id)) all.delete(id);
    return all;
  }

  lookup(key) {
    let id = this.state.rootId;
    while (id) {
      const p = this.state.pages.get(id);
      if (!p) throw new RuleError('BROKEN_REFERENCE', `查询遇无法闭合的引用: ${id}`);
      if (p.type === 'leaf') {
        const i = p.keys.indexOf(key);
        return i < 0 ? null : { key, value: p.values[i], pageId: id };
      }
      let i = 0;
      while (i < p.keys.length && key >= p.keys[i]) i++;
      id = p.children[i];
    }
    return null;
  }

  snapshot() {
    const snap = snapshotOf(this.state.pages, this.state.rootId, this.state.gen, this.lastRecovery);
    if (this.state.keySet) snap.audit = auditKeys(snap, this.state.keySet);
    return snap;
  }
}

function committedReceipt(intent, at) {
  return {
    batchId: intent.batchId, editDigest: intent.editDigest, status: 'committed',
    gen: intent.gen, rootId: intent.rootId, committedAt: at,
  };
}

function rejectReceipt(batchId, editDigest, code, reason) {
  return { batchId, editDigest, status: 'rejected', code, reason, replayed: false };
}

function crashAck(batchId, editDigest, gen, stage, note) {
  return { batchId, editDigest, status: 'interrupted', gen, stage, note, replayed: false };
}

// ---- 只读视图：根代次、可达页、有序叶序列、键恰好一次校验 ----

export function snapshotOf(pages, rootId, gen, recovery = null) {
  const pageList = [];
  const leafOrder = [];
  let reachable = 0;
  let internalCount = 0;
  let leafCount = 0;
  let badRefs = [];

  if (rootId) {
    const seen = new Set();
    const walk = (id, depth) => {
      if (seen.has(id)) return;
      seen.add(id);
      const p = pages.get(id);
      if (!p) { badRefs.push(id); return; }
      reachable++;
      if (p.type === 'internal') {
        internalCount++;
        pageList.push({ id: p.id, type: 'internal', gen: p.gen, depth, keys: [...p.keys], children: [...p.children], digest: p.digest });
        for (const c of p.children) walk(c, depth + 1);
      } else {
        leafCount++;
        pageList.push({ id: p.id, type: 'leaf', gen: p.gen, depth, keys: [...p.keys], values: [...p.values], digest: p.digest });
      }
    };
    walk(rootId, 0);
    // 按键有序的叶序列：沿树结构按子节点顺序中序遍历（B 树序即键序）
    if (badRefs.length === 0) {
      for (const p of orderedLeaves(pages, rootId)) {
        for (let i = 0; i < p.keys.length; i++) {
          leafOrder.push({ key: p.keys[i], value: p.values[i], pageId: p.id });
        }
      }
    }
  }

  const keys = leafOrder.map((x) => x.key);
  const sorted = keys.every((k, i) => i === 0 || keys[i - 1] < k);
  const unique = new Set(keys).size === keys.length;
  // 叶序审计之外独立核验点查询路径（引用闭合时才做）：
  // 叶序再整齐，分隔键错了查询视图仍然失效，二者必须分别成立。
  const navErrors = badRefs.length === 0 && rootId
    ? navigationProblems(pages, rootId)
    : [];
  return {
    order: ORDER,
    rootId,
    gen,
    reachablePages: reachable,
    internalCount,
    leafCount,
    pages: pageList.sort((a, b) => (a.depth - b.depth) || a.id.localeCompare(b.id)),
    leafSequence: leafOrder,
    keyCount: keys.length,
    ordered: sorted,
    allKeysOnce: sorted && unique,
    pointQueryOk: navErrors.length === 0,
    navigationProblems: navErrors,
    badReferences: badRefs,
    recovery,
  };
}

// 对照期望键集合核验“分裂后所有键仍恰好一次”
export function auditKeys(snapshot, expectedKeys) {
  const got = snapshot.leafSequence.map((x) => x.key);
  const exp = [...expectedKeys].sort((a, b) => a - b);
  const missing = exp.filter((k) => !got.includes(k));
  const extra = got.filter((k) => !expectedKeys.has(k));
  const dupes = got.filter((k, i) => got.indexOf(k) !== i);
  const navErrors = snapshot.navigationProblems ?? [];
  return {
    pass: snapshot.allKeysOnce && missing.length === 0 && extra.length === 0
      && dupes.length === 0 && navErrors.length === 0,
    expectedCount: expectedKeys.size,
    actualCount: got.length,
    missing, extra, dupes,
    ordered: snapshot.ordered,
    queryable: navErrors.length === 0,
    navigationProblems: navErrors,
  };
}

// 发布 / 自愈前的结构证据核验（调用方已保证引用闭合、摘要合法）：
// 叶序严格有序、与已提交键集合逐一对应、且点查询不变量成立。
// 任一项失败都不得把候选根当作可查询版本发布。
export function treeEvidenceProblems(pages, rootId, expectedKeys) {
  const problems = [];
  let leaves;
  try {
    leaves = orderedLeaves(pages, rootId);
  } catch (e) {
    return [e.message];
  }
  const got = [];
  for (const leaf of leaves) {
    for (let i = 1; i < leaf.keys.length; i++) {
      if (leaf.keys[i - 1] >= leaf.keys[i]) {
        problems.push(`叶页 ${leaf.id} 内键未严格递增：${leaf.keys[i - 1]} 后出现 ${leaf.keys[i]}`);
      }
    }
    got.push(...leaf.keys);
  }
  for (let i = 1; i < got.length; i++) {
    if (got[i - 1] >= got[i]) {
      problems.push(`叶序列在 ${got[i - 1]} 与 ${got[i]} 之间未严格递增`);
      break;
    }
  }
  const dupes = got.filter((k, i) => got.indexOf(k) !== i);
  if (dupes.length) problems.push(`叶序列存在重复键：${[...new Set(dupes)].join('、')}`);
  const exp = expectedKeys instanceof Set ? expectedKeys : new Set(expectedKeys ?? []);
  const missing = [...exp].filter((k) => !got.includes(k));
  const extra = [...new Set(got.filter((k) => !exp.has(k)))];
  if (missing.length) problems.push(`相对已提交键集合丢失键：${missing.join('、')}`);
  if (extra.length) problems.push(`叶序列出现已提交集合之外的键：${extra.join('、')}`);
  // 叶序/键集合都通过后再验证点查询路径，避免错误叠加导致噪声
  if (!problems.length) {
    for (const msg of navigationProblems(pages, rootId)) problems.push(msg);
  }
  return problems;
}

export { RuleError, ORDER };
