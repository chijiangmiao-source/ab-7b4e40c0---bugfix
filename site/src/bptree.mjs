// 阶数 4 的 B+ 树纯算法层。
// 规则：内部节点子节点数上限 = ORDER(4)，叶节点键上限 = ORDER-1(3)；
// 非根内部节点至少 ceil(ORDER/2)=2 个子节点，叶节点至少 ceil(ORDER/2)-1=1 个键。
// 所有被修改的节点一律分配新 id 与新代次（写时复制）；未触碰的旧页继续被新树引用共享。

import { digestPage } from './digest.mjs';

export const ORDER = 4;
export const MAX_KEYS = ORDER - 1;            // 3
export const MIN_LEAF_KEYS = Math.ceil(ORDER / 2) - 1; // 1
export const MIN_CHILDREN = Math.ceil(ORDER / 2);      // 2

// 页 id 采用内容寻址：同代次、同结构的重试必然产生相同 id，
// 使“相同批次+等价编辑”的中断重放写入完全相同的页（幂等覆盖）。
function contentId(page) {
  const { id, digest, ...body } = page;
  return 'p' + digestPage(body);
}

function stamp(page) {
  page.digest = digestPage(page);
  page.id = contentId(page);
  return page;
}

function makeLeaf(gen, { keys = [], values = [] } = {}) {
  return stamp({ type: 'leaf', id: null, gen, keys, values });
}

function makeInternal(gen, { keys = [], children = [] } = {}) {
  return stamp({ type: 'internal', id: null, gen, keys, children });
}

// 在不可变快照 src(id->page) 上产出一批新版本页。
export class Writer {
  constructor(src, gen) {
    this.src = src;
    this.gen = gen;
    this.out = new Map();
  }
  get(id) {
    if (id == null) throw new Error('引用了空页 id');
    return this.out.get(id) ?? this.src.get(id) ?? null;
  }
  emit(page) {
    this.out.set(page.id, page);
    return page.id;
  }
  // 复制旧页并打补丁，刷新代次与摘要，id 由内容决定
  copy(page, patch) {
    return stamp({ ...page, ...patch, gen: this.gen, id: null });
  }
  leaf(keys, values) { return this.emit(makeLeaf(this.gen, { keys, values })); }
  internal(keys, children) { return this.emit(makeInternal(this.gen, { keys, children })); }

  // 在键序列中定位子节点下标：children[i] 容纳 key
  static childIndex(keys, key) {
    let i = 0;
    while (i < keys.length && key >= keys[i]) i++;
    return i;
  }

  // 返回新页 id；若发生分裂返回 { split, key, left, right }
  insert(id, key, value) {
    const node = this.get(id);
    if (!node) throw new Error(`无法闭合的子页引用: ${id}`);

    if (node.type === 'leaf') {
      const pos = lowerBound(node.keys, key);
      if (pos < node.keys.length && node.keys[pos] === key) {
        throw new RuleError('INSERT_EXISTS', `键 ${key} 已存在，不能重复插入`);
      }
      const keys = node.keys.slice();
      const values = node.values.slice();
      keys.splice(pos, 0, key);
      values.splice(pos, 0, value);
      if (keys.length <= MAX_KEYS) {
        return this.emit(this.copy(node, { keys, values }));
      }
      // 叶分裂：4 -> 2 + 2，右邻首键上拷
      const mid = 2;
      const rightId = this.leaf(keys.slice(mid), values.slice(mid));
      const leftId = this.leaf(keys.slice(0, mid), values.slice(0, mid));
      return { split: true, key: keys[mid], left: leftId, right: rightId };
    }

    const idx = Writer.childIndex(node.keys, key);
    const r = this.insert(node.children[idx], key, value);
    let keys, children;
    if (typeof r === 'string') {
      keys = node.keys.slice();
      children = node.children.slice();
      children[idx] = r;
    } else {
      keys = node.keys.slice();
      children = node.children.slice();
      keys.splice(idx, 0, r.key);
      children.splice(idx, 1, r.left, r.right);
    }
    if (children.length <= ORDER) {
      return this.emit(this.copy(node, { keys, children }));
    }
    // 内部节点分裂：5 个子节点 / 4 个分隔键 -> 左3子2键，提升第3个键，右2子1键
    const promote = keys[2];
    const leftId = this.emit(makeInternal(this.gen, {
      keys: keys.slice(0, 2),
      children: children.slice(0, 3),
    }));
    const rightId = this.emit(makeInternal(this.gen, {
      keys: keys.slice(3),
      children: children.slice(3),
    }));
    return { split: true, key: promote, left: leftId, right: rightId };
  }

  // 删除：返回 { id, underflow }。underflow 供父节点处理（叶子空 / 内部仅1子）。
  remove(id, key, isRoot) {
    const node = this.get(id);
    if (!node) throw new Error(`无法闭合的子页引用: ${id}`);

    if (node.type === 'leaf') {
      const pos = node.keys.indexOf(key);
      if (pos < 0) throw new RuleError('DELETE_MISSING', `键 ${key} 不存在，不能删除`);
      const keys = node.keys.slice();
      const values = node.values.slice();
      keys.splice(pos, 1);
      values.splice(pos, 1);
      const newId = this.emit(this.copy(node, { keys, values }));
      return { id: newId, underflow: !isRoot && keys.length < MIN_LEAF_KEYS };
    }

    const idx = Writer.childIndex(node.keys, key);
    const child = this.get(node.children[idx]);
    const r = this.remove(node.children[idx], key, false);
    let keys = node.keys.slice();
    let children = node.children.slice();
    children[idx] = r.id;

    if (r.underflow) {
      ({ keys, children } = this.fixUnderflow(keys, children, idx, child.type));
    }

    if (children.length < MIN_CHILDREN) {
      if (isRoot) {
        // 根收缩：唯一子节点直接成为新根
        return { id: children[0], underflow: false };
      }
      return { id: this.emit(this.copy(node, { keys, children })), underflow: true };
    }
    return { id: this.emit(this.copy(node, { keys, children })), underflow: false };
  }

  // 修正 children[fixIdx] 的下溢：借位或合并。返回新的 { keys, children }（新版本均已 emit）。
  fixUnderflow(keys, children, fixIdx, childType) {
    const leftIdx = fixIdx - 1;
    const rightIdx = fixIdx + 1;
    const left = leftIdx >= 0 ? this.get(children[leftIdx]) : null;
    const right = rightIdx < children.length ? this.get(children[rightIdx]) : null;
    // 叶节点至少留 1 键（可借阈值 2）；内部节点至少留 2 子（可借阈值 3）
    const lendThreshold = childType === 'leaf' ? MIN_LEAF_KEYS + 1 : MIN_CHILDREN + 1;
    const canLend = (p) => p && p.type === childType && pageKeyCount(p) >= lendThreshold;

    if (canLend(left)) {
      return this.borrowSide(keys, children, fixIdx, leftIdx, 'left', childType);
    }
    if (canLend(right)) {
      return this.borrowSide(keys, children, fixIdx, rightIdx, 'right', childType);
    }
    if (left && left.type === childType) {
      return this.mergeSide(keys, children, fixIdx, leftIdx, 'left', childType);
    }
    if (right && right.type === childType) {
      return this.mergeSide(keys, children, fixIdx, rightIdx, 'right', childType);
    }
    throw new Error('下溢修正失败：兄弟节点类型异常');
  }

  borrowSide(keys, children, fixIdx, sibIdx, side, childType) {
    const sepIdx = side === 'left' ? fixIdx - 1 : fixIdx;
    const child = this.get(children[fixIdx]);
    const sib = this.get(children[sibIdx]);
    let newChild, newSib, newSep;
    if (childType === 'leaf') {
      const ck = child.keys.slice(); const cv = child.values.slice();
      const sk = sib.keys.slice(); const sv = sib.values.slice();
      if (side === 'left') {
        const k = sk.pop(); const v = sv.pop();
        ck.unshift(k); cv.unshift(v);
        newSep = ck[0];
      } else {
        const k = sk.shift(); const v = sv.shift();
        ck.push(k); cv.push(v);
        newSep = sk[0];
      }
      newChild = this.copy(child, { keys: ck, values: cv });
      newSib = this.copy(sib, { keys: sk, values: sv });
    } else {
      const ck = child.keys.slice(); const cc = child.children.slice();
      const sk = sib.keys.slice(); const sc = sib.children.slice();
      const sep = keys[sepIdx];
      if (side === 'left') {
        const downChild = sc.pop();
        const downKey = sk.pop();
        ck.unshift(sep);
        cc.unshift(downChild);
        newSep = downKey;
      } else {
        const downChild = sc.shift();
        const downKey = sk.shift();
        ck.push(sep);
        cc.push(downChild);
        newSep = downKey;
      }
      newChild = this.copy(child, { keys: ck, children: cc });
      newSib = this.copy(sib, { keys: sk, children: sc });
    }
    this.emit(newChild);
    this.emit(newSib);
    const newKeys = keys.slice();
    const newChildren = children.slice();
    newKeys[sepIdx] = newSep;
    newChildren[fixIdx] = newChild.id;
    newChildren[sibIdx] = newSib.id;
    return { keys: newKeys, children: newChildren };
  }

  mergeSide(keys, children, fixIdx, sibIdx, side, childType) {
    const sepIdx = side === 'left' ? fixIdx - 1 : fixIdx;
    const child = this.get(children[fixIdx]);
    const sib = this.get(children[sibIdx]);
    const sep = keys[sepIdx];
    let merged, keepIdx, dropIdx;
    if (childType === 'leaf') {
      if (side === 'left') {
        merged = this.copy(sib, {
          keys: sib.keys.concat(child.keys),
          values: sib.values.concat(child.values),
        });
      } else {
        merged = this.copy(child, {
          keys: child.keys.concat(sib.keys),
          values: child.values.concat(sib.values),
        });
      }
    } else if (side === 'left') {
      merged = this.copy(sib, {
        keys: sib.keys.concat([sep], child.keys),
        children: sib.children.concat(child.children),
      });
    } else {
      merged = this.copy(child, {
        keys: child.keys.concat([sep], sib.keys),
        children: child.children.concat(sib.children),
      });
    }
    this.emit(merged);
    keepIdx = side === 'left' ? sibIdx : fixIdx;
    dropIdx = side === 'left' ? fixIdx : sibIdx;
    const newKeys = keys.slice();
    const newChildren = children.slice();
    newChildren[keepIdx] = merged.id;
    newChildren.splice(dropIdx, 1);
    newKeys.splice(sepIdx, 1);
    return { keys: newKeys, children: newChildren };
  }

  update(id, key, value) {
    const node = this.get(id);
    if (!node) throw new Error(`无法闭合的子页引用: ${id}`);
    if (node.type === 'leaf') {
      const pos = node.keys.indexOf(key);
      if (pos < 0) throw new RuleError('UPDATE_MISSING', `键 ${key} 不存在，不能更新`);
      const values = node.values.slice();
      values[pos] = value;
      return this.emit(this.copy(node, { values }));
    }
    const idx = Writer.childIndex(node.keys, key);
    const newChild = this.update(node.children[idx], key, value);
    const children = node.children.slice();
    children[idx] = newChild;
    return this.emit(this.copy(node, { children }));
  }
}

function pageKeyCount(page) {
  return page.type === 'leaf' ? page.keys.length : page.children.length;
}

function lowerBound(arr, key) {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < key) lo = mid + 1; else hi = mid;
  }
  return lo;
}

export class RuleError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RuleError';
    this.code = code;
  }
}

// 对已发布快照应用一批编辑，返回新根与全部新版本页。
export function applyEdits(srcPages, rootId, gen, edits) {
  const w = new Writer(srcPages, gen);
  let cur = rootId;
  for (const op of edits) {
    if (op.op === 'insert') {
      const r = w.insert(cur, op.key, op.value);
      cur = typeof r === 'string' ? r : r.split ? topFromSplit(w, r) : r;
    } else if (op.op === 'delete') {
      const r = w.remove(cur, op.key, true);
      cur = r.id;
    } else if (op.op === 'update') {
      cur = w.update(cur, op.key, op.value);
    } else {
      throw new RuleError('UNKNOWN_OP', `未知操作类型: ${op.op}`);
    }
  }
  if (closure(w, cur).size >= 12) {
    cur = normalizeDeepSeparators(w, cur);
  }
  // 仅保留从新根可达的新版本（丢弃分裂/合并过程中的瞬态页）
  const reachable = closure(w, cur);
  const pages = new Map();
  for (const id of reachable) {
    if (w.out.has(id)) pages.set(id, w.out.get(id));
  }
  return { rootId: cur, gen, pages };
}

// 深层批次后重算全部内部页分隔键：分隔键必须等于其右侧相邻子树的“最小叶键”，
// 而不是内部子节点自身的第一个分隔键——两者在深度 >=3 时并不相等，
// 取错会让中序叶序列仍然严格有序、点查询却路由到错误叶页。
function normalizeDeepSeparators(w, rootId) {
  // 自底向上重建，返回重建后页 id 与该子树最小叶键（最左叶首键）
  const normalize = (id) => {
    const node = w.get(id);
    if (!node) throw new RuleError('BROKEN_REFERENCE', `无法闭合的子页引用: ${id}`);
    if (node.type === 'leaf') return { id, minKey: node.keys[0] };
    const parts = node.children.map(normalize);
    const keys = parts.slice(1).map((p) => p.minKey);
    const newId = w.emit(w.copy(node, { keys, children: parts.map((p) => p.id) }));
    return { id: newId, minKey: parts[0].minKey };
  };
  return normalize(rootId).id;
}

function topFromSplit(w, r) {
  return w.emit(makeInternal(w.gen, { keys: [r.key], children: [r.left, r.right] }));
}

// 从空树按有序序列批量构建（初始航点录入用，≤24 条）
export function buildEmpty(gen) {
  const leaf = makeLeaf(gen, {});
  return { rootId: leaf.id, pages: new Map([[leaf.id, leaf]]) };
}
export function buildTree(gen, entries) {
  const empty = makeLeaf(gen, {});
  const src = new Map([[empty.id, empty]]);
  let rootId = empty.id;
  for (const [key, value] of entries) {
    const r = applyEdits(src, rootId, gen, [{ op: 'insert', key, value }]);
    rootId = r.rootId;
    for (const [id, p] of r.pages) src.set(id, p);
  }
  const pages = closureMap(src, rootId);
  return { rootId, pages };
}

export function closureMap(src, rootId) {
  const w = { get: (id) => src.get(id) ?? null, out: new Map() };
  const seen = closure(w, rootId);
  const out = new Map();
  for (const id of seen) out.set(id, src.get(id));
  return out;
}

// 计算从根可达的全部页 id，缺页即抛错
export function closure(w, rootId) {
  const seen = new Set();
  const stack = [rootId];
  while (stack.length) {
    const id = stack.pop();
    if (id == null) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    const p = w.get(id);
    if (!p) throw new RuleError('BROKEN_REFERENCE', `无法闭合的子页引用: ${id}`);
    if (p.type === 'internal') {
      for (const c of p.children) stack.push(c);
    }
  }
  return seen;
}

// 沿树结构中序收集叶页（按子节点顺序），天然得到按键有序的叶序列
export function orderedLeaves(pages, rootId) {
  const out = [];
  const go = (id) => {
    const p = pages.get(id);
    if (!p) throw new RuleError('BROKEN_REFERENCE', `无法闭合的子页引用: ${id}`);
    if (p.type === 'leaf') { out.push(p); return; }
    for (const c of p.children) go(c);
  };
  go(rootId);
  return out;
}

// 沿点查询路径（内部页分隔键路由）读取一个键；页缺失即抛错。
export function pointGet(pages, rootId, key) {
  let id = rootId;
  while (id != null) {
    const p = pages.get(id);
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

// 点查询路径不变量，两道独立检查：
//  1. 内部页每个分隔键必须是有效分界：max(左子树叶键) < sep <= min(右子树叶键)。
//     删除会留下“悬空分隔键”（如右子树最小叶键已从 30 变为 40，sep 仍为 30），
//     这仍然合法——查不存在的 30 照样落空；真正非法的是分隔键越过某一侧已有叶键。
//  2. 中序叶序列中的每个键都必须能经真实点查询路径读到（端到端可查询）。
// 叶序审计（中序遍历）只看 children 顺序、不看 keys，无法发现分隔键越界；
// 本检查独立保证“叶序列里的每个键都能经查询路径读取和编辑”。
// 返回失配描述数组，空数组即点查询视图与叶序列一致。
export function navigationProblems(pages, rootId) {
  const problems = [];
  const leafBounds = (id) => {
    const p = pages.get(id);
    if (!p) throw new RuleError('BROKEN_REFERENCE', `无法闭合的子页引用: ${id}`);
    if (p.type === 'leaf') return { min: p.keys[0], max: p.keys[p.keys.length - 1] };
    let min, max;
    for (const c of p.children) {
      const b = leafBounds(c);
      if (b.min === undefined) continue; // 空子树（删空的叶）不提供边界
      min = min === undefined ? b.min : Math.min(min, b.min);
      max = max === undefined ? b.max : Math.max(max, b.max);
    }
    return { min, max };
  };
  const check = (id) => {
    const p = pages.get(id);
    if (!p) throw new RuleError('BROKEN_REFERENCE', `无法闭合的子页引用: ${id}`);
    if (p.type === 'leaf') return;
    for (let i = 0; i < p.keys.length; i++) {
      const left = leafBounds(p.children[i]);
      const right = leafBounds(p.children[i + 1]);
      const sep = p.keys[i];
      if (left.max !== undefined && !(left.max < sep)) {
        problems.push(`内部页 ${id} 第 ${i + 1} 个分隔键 ${sep} 未大于左子树最大叶键 ${left.max}（左子树既有键会被错误路由到右侧）`);
      }
      if (right.min !== undefined && !(sep <= right.min)) {
        problems.push(`内部页 ${id} 第 ${i + 1} 个分隔键 ${sep} 大于右子树最小叶键 ${right.min}（右子树既有键会被错误路由到左侧）`);
      }
    }
    for (const c of p.children) check(c);
  };
  check(rootId);

  // 端到端探针：叶序列中每个键都必须沿分隔键路由命中，且值一致
  for (const leaf of orderedLeaves(pages, rootId)) {
    for (let i = 0; i < leaf.keys.length; i++) {
      const key = leaf.keys[i];
      const hit = pointGet(pages, rootId, key);
      if (!hit) problems.push(`叶序列中的既有键 ${key} 无法经查询路径读到（被错误分隔键路由到其他叶页）`);
      else if (hit.value !== leaf.values[i] || hit.pageId !== leaf.id) {
        problems.push(`叶序列中的键 ${key} 经查询路径命中了别的叶页（点查询视图与叶序不一致）`);
      }
    }
  }
  return problems;
}

// 以中序叶序列为唯一事实源，自底向上重建内部页（分隔键取右子树最小叶键）。
// 用于修复“叶页与顺序完好、但内部页分隔键已使查询视图失效”的已发布树：
// 不改动任何叶页（键与载荷原样保留），只重建祖先页，全部产出在同一 Writer.out。
export function rebuildTreeFromLeaves(w, leaves) {
  // 空叶不携带任何键值：修复时直接丢弃（随后不可达会被回收），
  // 避免 undefined 最小键污染分隔键；全空则退化为单一空叶根。
  leaves = leaves.filter((p) => p.keys.length > 0);
  if (leaves.length === 0) return w.leaf([], []);
  // level: 当前层全部节点 { id, minKey }，按叶序排列
  let level = leaves.map((p) => ({ id: p.id, minKey: p.keys[0] }));
  while (level.length > 1) {
    const next = [];
    let pos = 0;
    while (pos < level.length) {
      const remaining = level.length - pos;
      let size = Math.min(ORDER, remaining);
      if (remaining - size === 1) size -= 1; // 末组不得只剩 1 个节点（内部页至少 2 子）
      const group = level.slice(pos, pos + size);
      pos += size;
      const id = w.internal(group.slice(1).map((n) => n.minKey), group.map((n) => n.id));
      next.push({ id, minKey: group[0].minKey });
    }
    level = next;
  }
  return level[0].id;
}
