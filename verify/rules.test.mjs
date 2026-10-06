// 规则测试：一次有效分裂、各持久化阶段中断恢复、冲突重传、
// 以及各类拒绝原因（重复键 / 删除不存在键 / 损坏摘要 / 无法闭合引用）。
// 运行：node --test（Node 20 内置测试运行器，零依赖）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine, CRASH_POINTS, snapshotOf, auditKeys } from '../site/src/engine.mjs';
import { MemoryStore } from '../site/src/store.mjs';
import { digestPage } from '../site/src/digest.mjs';

async function freshDb(entries) {
  const store = new MemoryStore();
  const engine = new Engine(store);
  await engine.open();
  await engine.initialize(entries ?? [
    [10, '航点十'], [20, '航点廿'], [30, '卅'], [40, '四十'],
    [50, '五十'], [60, '六十'], [70, '七十'],
  ]);
  return { store, engine };
}

async function reopenEngine(store) {
  const engine = new Engine(store);
  const report = await engine.open();
  return { engine, report };
}

// ---------- 一、一次有效分裂 ----------

test('有效分裂：跨叶分裂与根提升后所有键仍恰好一次出现', async () => {
  const { engine } = await freshDb();
  const before = engine.snapshot();
  assert.equal(before.gen, 1);
  assert.ok(before.internalCount >= 1, '7 键应已产生至少一次分裂（存在内部页）');
  assert.ok(before.allKeysOnce, '初始树按键有序且无重复');

  const edits = [
    { op: 'insert', key: 5, value: '五' },
    { op: 'insert', key: 15, value: '十五' },
    { op: 'insert', key: 25, value: '廿五' },
    { op: 'insert', key: 35, value: '卅五' },
    { op: 'insert', key: 65, value: '六十五' },
    { op: 'insert', key: 75, value: '七十五' },
    { op: 'update', key: 40, value: '四十-改' },
  ];
  const receipt = await engine.submitBatch(edits, 'batch-split');
  assert.equal(receipt.status, 'committed');
  assert.equal(receipt.replayed, false);

  const snap = engine.snapshot();
  assert.equal(snap.gen, 2);
  assert.ok(snap.internalCount >= 1);
  // 每个叶页至多 3 键，内部页至多 4 子
  for (const p of snap.pages) {
    if (p.type === 'leaf') assert.ok(p.keys.length <= 3);
    else {
      assert.ok(p.children.length <= 4);
      assert.ok(p.children.length >= 2);
    }
  }
  const expected = new Set([10, 20, 30, 40, 50, 60, 70, 5, 15, 25, 35, 65, 75]);
  const audit = auditKeys(snap, expected);
  assert.deepEqual(audit, {
    pass: true, expectedCount: 13, actualCount: 13,
    missing: [], extra: [], dupes: [], ordered: true,
    queryable: true, navigationProblems: [],
  });
  assert.equal(engine.lookup(40).value, '四十-改');
  assert.equal(engine.lookup(5).value, '五');
});

test('有效分裂的直证：插入使单叶 4 键时对称分裂为两个 2 键叶', async () => {
  const store = new MemoryStore();
  const engine = new Engine(store);
  await engine.open();
  await engine.initialize([[1, 'a'], [2, 'b'], [3, 'c']]);
  let snap = engine.snapshot();
  assert.equal(snap.leafCount, 1);
  assert.deepEqual(snap.leafSequence.map((x) => x.key), [1, 2, 3]);

  await engine.submitBatch([{ op: 'insert', key: 4, value: 'd' }], 'b');
  snap = engine.snapshot();
  assert.equal(snap.leafCount, 2);
  assert.equal(snap.internalCount, 1, '根提升为内部页');
  assert.deepEqual(snap.leafSequence.map((x) => x.key), [1, 2, 3, 4]);
  assert.deepEqual(snap.pages.find((p) => p.type === 'internal').keys, [3]);
  assert.ok(snap.allKeysOnce);
});

// ---------- 二、各阶段中断恢复 ----------

test('中断于新页写入途中：重开停在旧根，半写入页不进入可查询视图', async () => {
  const { store, engine } = await freshDb();
  const oldRoot = engine.state.rootId;
  const ack = await engine.submitBatch(
    [{ op: 'insert', key: 5, value: '五' }, { op: 'insert', key: 15, value: '十五' }],
    'crash-during-pages', CRASH_POINTS.DURING_PAGES,
  );
  assert.equal(ack.status, 'interrupted');
  assert.equal(ack.stage, 'PAGES');
  assert.equal(engine.state.rootId, oldRoot, '内存视图仍是旧根');

  const { engine: e2, report } = await reopenEngine(store);
  assert.equal(report.conclusion, 'INTACT');
  assert.equal(e2.state.rootId, oldRoot, '重开后发布根仍是旧根');
  assert.equal(e2.snapshot().gen, 1);
  assert.equal(e2.lookup(5), null);

  const snap = e2.snapshot();
  // 存储中不存在任何已发布根不可达的页
  const stored = await store.allPageIds();
  assert.equal(stored.length, snap.reachablePages, '半写入孤儿已被清除');
  assert.equal(await store.get('intent'), undefined);
});

test('中断于新页全部写完、意图留下前：重开停在旧根', async () => {
  const { store, engine } = await freshDb();
  const oldRoot = engine.state.rootId;
  await engine.submitBatch(
    [{ op: 'insert', key: 5, value: '五' }, { op: 'insert', key: 55, value: '五五' }],
    'crash-after-pages', CRASH_POINTS.AFTER_PAGES,
  );
  const { engine: e2, report } = await reopenEngine(store);
  assert.equal(report.conclusion, 'INTACT');
  assert.equal(e2.state.rootId, oldRoot);
  assert.equal(e2.lookup(55), null);
  const stored = await store.allPageIds();
  assert.equal(stored.length, e2.snapshot().reachablePages);
});

test('中断于意图之后、根切换之前且证据完整：重开发布可完整遍历的新根', async () => {
  const { store, engine } = await freshDb();
  const oldRoot = engine.state.rootId;
  await engine.submitBatch(
    [{ op: 'insert', key: 5, value: '五' }, { op: 'delete', key: 30 }],
    'crash-after-intent', CRASH_POINTS.AFTER_INTENT,
  );
  assert.equal(engine.state.rootId, oldRoot, '断电瞬间查询视图仍是旧根');

  const { engine: e2, report } = await reopenEngine(store);
  assert.equal(report.conclusion, 'NEW_ROOT_PUBLISHED');
  assert.equal(e2.snapshot().gen, 2);
  assert.notEqual(e2.state.rootId, oldRoot);
  const snap = e2.snapshot();
  assert.equal(snap.badReferences.length, 0, '新树引用全部闭合');
  assert.ok(snap.allKeysOnce);
  assert.equal(e2.lookup(5).value, '五');
  assert.equal(e2.lookup(30), null);
  // 发布同时固化了提交回执，意图已清理
  const receipt = await store.get('receipt:crash-after-intent');
  assert.equal(receipt.status, 'committed');
  assert.equal(await store.get('intent'), undefined);
});

test('中断于意图之后但新页缺失：重开保留旧根并记录回滚原因', async () => {
  const { store, engine } = await freshDb();
  const oldRoot = engine.state.rootId;
  await engine.submitBatch(
    [{ op: 'insert', key: 5, value: '五' }, { op: 'insert', key: 6, value: '六' }],
    'crash-missing-page', CRASH_POINTS.AFTER_INTENT,
  );
  // 模拟半写入：删除意图清单中的一个新页（选旧根不可达的）
  const intent = await store.get('intent');
  const oldReach = new Set((await store.allPageIds()).map((k) => k.slice(5)));
  const victim = intent.pageIds.find((id) => !engine.state.pages.has(id));
  assert.ok(victim, '应当至少存在一个新批次页');
  await store.delete('page:' + victim);
  assert.equal(oldReach.size, (await store.allPageIds()).length + 1);

  const { engine: e2, report } = await reopenEngine(store);
  assert.equal(report.conclusion, 'OLD_ROOT_RETAINED');
  assert.match(report.detail, /证据不完整|缺失/);
  assert.equal(e2.state.rootId, oldRoot);
  assert.equal(e2.snapshot().gen, 1);
  assert.equal(e2.lookup(5), null);
  const receipt = await store.get('receipt:crash-missing-page');
  assert.equal(receipt.status, 'rolled-back');
  assert.match(receipt.reason, /缺失/);
  // 存储页与旧根可达页一致，无孤儿混入
  const stored = await store.allPageIds();
  assert.equal(stored.length, e2.snapshot().reachablePages);
});

test('中断于意图之后且页摘要损坏：重开保留旧根并指明摘要损坏', async () => {
  const { store, engine } = await freshDb();
  const oldRoot = engine.state.rootId;
  await engine.submitBatch(
    [{ op: 'insert', key: 5, value: '五' }, { op: 'insert', key: 8, value: '八' }],
    'crash-corrupt-page', CRASH_POINTS.AFTER_INTENT,
  );
  const intent = await store.get('intent');
  const victim = intent.pageIds.find((id) => !engine.state.pages.has(id));
  const page = await store.get('page:' + victim);
  const corrupted = { ...page, values: page.values?.map ? page.values.map(() => '被篡改') : page.values };
  // 故意不重算 digest，制造摘要不符
  await store.put('page:' + victim, corrupted);

  const { engine: e2, report } = await reopenEngine(store);
  assert.equal(report.conclusion, 'OLD_ROOT_RETAINED');
  assert.match(report.detail, /摘要/);
  assert.equal(e2.state.rootId, oldRoot);
  assert.equal(e2.lookup(5), null);
  assert.equal((await store.get('receipt:crash-corrupt-page')).status, 'rolled-back');
});

test('中断于根切换之后、意图清理之前：重开确认新根已发布，仅补清理', async () => {
  const { store, engine } = await freshDb();
  const oldRoot = engine.state.rootId;
  await engine.submitBatch(
    [{ op: 'insert', key: 5, value: '五' }],
    'crash-after-root', CRASH_POINTS.AFTER_ROOT,
  );
  // 断电进程在根切换后立即中断：持久化已提交，但崩溃回执不再更新内存视图

  const { engine: e2, report } = await reopenEngine(store);
  assert.equal(report.conclusion, 'NEW_ROOT_PUBLISHED');
  assert.equal(e2.snapshot().gen, 2);
  assert.notEqual(e2.state.rootId, oldRoot, '重开后发布的是新根');
  assert.equal(e2.lookup(5).value, '五');
  assert.equal(await store.get('intent'), undefined);
  const stored = await store.allPageIds();
  assert.equal(stored.length, e2.snapshot().reachablePages, '旧版本页被回收');
});

test('任意阶段中断都不会产生“半新半旧”视图：四个注入点逐一核验', async () => {
  const points = [
    CRASH_POINTS.DURING_PAGES,
    CRASH_POINTS.AFTER_PAGES,
    CRASH_POINTS.AFTER_INTENT,
    CRASH_POINTS.AFTER_ROOT,
  ];
  for (const point of points) {
    const store = new MemoryStore();
    const engine = new Engine(store);
    await engine.open();
    await engine.initialize([[1, 'a'], [2, 'b'], [3, 'c'], [4, 'd']]);
    const oldRoot = engine.state.rootId;
    await engine.submitBatch([{ op: 'insert', key: 9, value: 'nine' }], 'bx-' + point, point);
    const { engine: e2 } = await reopenEngine(store);
    const snap = e2.snapshot();
    assert.ok(snap.allKeysOnce, point + ' 恢复后键仍恰好一次');
    const hasNine = e2.lookup(9) !== null;
    if (point === CRASH_POINTS.AFTER_INTENT || point === CRASH_POINTS.AFTER_ROOT) {
      assert.ok(hasNine, point + ' 应为完整新根');
      assert.equal(snap.gen, 2);
    } else {
      assert.ok(!hasNine, point + ' 应为旧根');
      assert.equal(e2.state.rootId, oldRoot);
      assert.equal(snap.gen, 1);
    }
  }
});

// ---------- 三、冲突重传与回执回放 ----------

test('相同批次标识与等价编辑重试：回放原回执且不再次改变根', async () => {
  const { engine } = await freshDb();
  const edits = [{ op: 'insert', key: 88, value: '八十八' }];
  const r1 = await engine.submitBatch(edits, 'dup-ok');
  assert.equal(r1.status, 'committed');
  assert.equal(r1.replayed, false);
  const rootAfter = engine.state.rootId;

  const r2 = await engine.submitBatch(edits, 'dup-ok');
  assert.equal(r2.status, 'committed');
  assert.equal(r2.replayed, true);
  assert.equal(r2.rootId, r1.rootId);
  assert.equal(engine.state.rootId, rootAfter);
  assert.equal(engine.snapshot().gen, 2, '代次不前进');

  // 等价编辑：操作名大小写、键的字符串形式不同，归一化后相同
  const r3 = await engine.submitBatch(
    [{ op: 'INSERT', key: '88', value: '八十八' }], 'dup-ok',
  );
  assert.equal(r3.replayed, true);
  assert.equal(engine.snapshot().gen, 2);
});

test('相同批次标识但内容不同：冲突拒绝、给出原因且根不变', async () => {
  const { engine } = await freshDb();
  const rootBefore = engine.state.rootId;
  await engine.submitBatch([{ op: 'insert', key: 88, value: '八十八' }], 'same-id');
  const rootAfterCommit = engine.state.rootId;
  const rej = await engine.submitBatch([{ op: 'insert', key: 99, value: '九十九' }], 'same-id');
  assert.equal(rej.status, 'rejected');
  assert.equal(rej.code, 'CONFLICT_BATCH_CONTENT');
  assert.match(rej.reason, /不同内容/);
  assert.equal(engine.state.rootId, rootAfterCommit, '冲突重传不改变已发布根');
  assert.equal(engine.lookup(99), null);
  assert.equal(engine.lookup(88).value, '八十八');
  assert.notEqual(rootBefore, rootAfterCommit);

  // 删除/更新混排也算不同内容
  const rej2 = await engine.submitBatch([{ op: 'delete', key: 88 }], 'same-id');
  assert.equal(rej2.code, 'CONFLICT_BATCH_CONTENT');
});

test('中断后用相同批次等价编辑重试：完成提交并给出提交回执', async () => {
  const { store, engine } = await freshDb();
  const edits = [{ op: 'insert', key: 77, value: '七十七' }];
  await engine.submitBatch(edits, 'retry-after-crash', CRASH_POINTS.DURING_PAGES);
  const { engine: e2 } = await reopenEngine(store);
  const r = await e2.submitBatch(edits, 'retry-after-crash');
  assert.equal(r.status, 'committed');
  assert.equal(e2.lookup(77).value, '七十七');
  // 再重放仍是原回执
  const r2 = await e2.submitBatch(edits, 'retry-after-crash');
  assert.equal(r2.replayed, true);
});

test('批次已终局回滚（证据不完整）后，同 id 等价编辑重传回放回滚回执；要重做须用新批次标识', async () => {
  const { store, engine } = await freshDb();
  const edits = [{ op: 'insert', key: 5, value: '五' }, { op: 'insert', key: 6, value: '六' }];
  await engine.submitBatch(edits, 'rolled-id', CRASH_POINTS.AFTER_INTENT);
  const intent = await store.get('intent');
  await store.delete('page:' + intent.pageIds[0]);
  const { engine: e2 } = await reopenEngine(store);
  assert.equal(e2.lookup(5), null);

  // 同 id + 等价内容：回放“回滚”这一原回执，而不是重新提交
  const replay = await e2.submitBatch(edits, 'rolled-id');
  assert.equal(replay.status, 'rolled-back');
  assert.equal(replay.replayed, true);
  assert.equal(e2.lookup(5), null, '根仍未改变');

  // 审查员要重做该编辑，换一个新批次标识即可正常提交
  const redo = await e2.submitBatch(edits, 'rolled-id-repaired');
  assert.equal(redo.status, 'committed');
  assert.equal(e2.lookup(5).value, '五');
});

// ---------- 四、规则拒绝：不改已发布根 ----------

test('插入重复键被拒绝且根不变', async () => {
  const { engine } = await freshDb();
  const root = engine.state.rootId;
  const r = await engine.submitBatch([{ op: 'insert', key: 30, value: 'x' }], 'dup-key');
  assert.equal(r.status, 'rejected');
  assert.equal(r.code, 'INSERT_EXISTS');
  assert.equal(engine.state.rootId, root);
  assert.equal(engine.lookup(30).value, '卅');
});

test('批次内对同一键重复插入被精确拒绝；插入后再更新同键合法', async () => {
  const { engine } = await freshDb();
  const root = engine.state.rootId;
  const r = await engine.submitBatch([
    { op: 'insert', key: 100, value: 'a' },
    { op: 'insert', key: 100, value: 'b' },
  ], 'dup-in-batch');
  assert.equal(r.status, 'rejected');
  assert.equal(r.code, 'INSERT_EXISTS');
  assert.match(r.reason, /已存在/);
  assert.equal(engine.state.rootId, root);
  assert.equal(engine.lookup(100), null, '整批拒绝，前一操作也不落库');

  // 顺序脚本：先插入后更新同键应提交
  const ok = await engine.submitBatch([
    { op: 'insert', key: 101, value: 'a' },
    { op: 'update', key: 101, value: 'b' },
    { op: 'insert', key: 102, value: 'c' },
  ], 'seq-same-key');
  assert.equal(ok.status, 'committed');
  assert.equal(engine.lookup(101).value, 'b');
});

test('删除不存在的键被拒绝', async () => {
  const { engine } = await freshDb();
  const root = engine.state.rootId;
  const r = await engine.submitBatch([{ op: 'delete', key: 999 }], 'del-missing');
  assert.equal(r.code, 'DELETE_MISSING');
  assert.equal(engine.state.rootId, root);
});

test('更新不存在的键被拒绝', async () => {
  const { engine } = await freshDb();
  const r = await engine.submitBatch([{ op: 'update', key: 999, value: 'x' }], 'upd-missing');
  assert.equal(r.code, 'UPDATE_MISSING');
});

test('录入与批次的数量、标识、操作类型、键型校验', async () => {
  const store = new MemoryStore();
  let engine = new Engine(store);
  await engine.open();
  await assert.rejects(
    () => engine.initialize(Array.from({ length: 25 }, (_, i) => [i, 'v'])),
    /至多 24/,
  );
  await engine.initialize([[1, 'a'], [2, 'b']]);

  const cases = [
    { edits: [], id: 'empty', match: /不能为空/ },
    { edits: Array.from({ length: 13 }, (_, i) => ({ op: 'insert', key: 100 + i, value: 'v' })), id: 'too-many', match: /至多 12/ },
    { edits: [{ op: 'frobnicate', key: 5 }], id: 'bad-op', match: /未知操作/ },
    { edits: [{ op: 'insert', key: 1.5, value: 'v' }], id: 'float-key', match: /整数/ },
    { edits: [{ op: 'insert', key: 5, value: 'v' }], id: '', match: /批次标识/ },
  ];
  for (const c of cases) {
    const root = engine.state.rootId;
    const r = await engine.submitBatch(c.edits, c.id);
    assert.equal(r.status, 'rejected', c.id + ' 应拒绝');
    assert.match(r.reason, c.match);
    assert.equal(engine.state.rootId, root, c.id + ' 根不变');
  }
});

test('初始录入重复键被拒绝', async () => {
  const store = new MemoryStore();
  const engine = new Engine(store);
  await engine.open();
  await assert.rejects(
    () => engine.initialize([[1, 'a'], [1, 'b']]),
    /重复/,
  );
});

// ---------- 五、损坏页摘要与无法闭合的引用 ----------

test('已发布页摘要损坏：恢复报告不健康，任何批次不得改变根', async () => {
  const { store, engine } = await freshDb();
  const root = engine.state.rootId;
  const page = await store.get('page:' + root);
  // 篡改内容但保留旧 digest
  const tampered = page.type === 'leaf'
    ? { ...page, values: page.values.map(() => '损坏') }
    : { ...page, keys: page.keys.map((k) => k + 100000) };
  await store.put('page:' + root, tampered);

  const e2 = new Engine(store);
  const report = await e2.open();
  assert.equal(report.conclusion, 'PUBLISHED_ROOT_UNHEALTHY');
  assert.match(report.detail, /摘要/);
  assert.equal(e2.state.rootId, root, '根指针原样冻结');

  const r = await e2.submitBatch([{ op: 'insert', key: 1, value: 'x' }], 'against-corrupt');
  assert.equal(r.status, 'rejected');
  assert.equal(r.code, 'CORRUPT_DIGEST');
  const rootRec = await store.get('root');
  assert.equal(rootRec.rootId, root);
});

test('无法闭合的子页引用：恢复识别为不健康且不切换根', async () => {
  const { store, engine } = await freshDb();
  const root = engine.state.rootId;
  const page = await store.get('page:' + root);
  assert.equal(page.type, 'internal');
  // 指向不存在的子页，并重算 digest 使摘要本身合法——证明引用闭合被独立校验
  const tampered = { ...page, children: ['p-deadbeefdeadbeef'] };
  tampered.digest = digestPage(tampered);
  await store.put('page:' + root, tampered);

  const e2 = new Engine(store);
  const report = await e2.open();
  assert.equal(report.conclusion, 'PUBLISHED_ROOT_UNHEALTHY');
  assert.match(report.detail, /无法闭合|闭合/);
  const r = await e2.submitBatch([{ op: 'insert', key: 1, value: 'x' }], 'against-broken');
  assert.equal(r.code, 'BROKEN_REFERENCE');
  assert.equal((await store.get('root')).rootId, root);
});

test('新页内容寻址：等价重试写入同一批页 id，旧页不被覆盖', async () => {
  const { store, engine } = await freshDb();
  const oldPages = new Set((await store.allPageIds()));
  const r1 = await engine.submitBatch([{ op: 'insert', key: 91, value: '九一' }], 'idempotent');
  const ids1 = new Set((await store.allPageIds()).filter((k) => !oldPages.has(k)));
  // 新库再来一遍相同操作
  const store2 = new MemoryStore();
  const e2 = new Engine(store2);
  await e2.open();
  await e2.initialize([
    [10, '航点十'], [20, '航点廿'], [30, '卅'], [40, '四十'],
    [50, '五十'], [60, '六十'], [70, '七十'],
  ]);
  await e2.submitBatch([{ op: 'insert', key: 91, value: '九一' }], 'idempotent');
  const ids2 = new Set([...new Set((await store2.allPageIds()).filter((k) => !oldPages.has(k)))]);
  // 两个库生成的新页 id 完全一致（内容寻址），重放覆盖等价于空操作
  assert.deepEqual([...ids1].sort(), [...ids2].sort());
  assert.ok(r1.status === 'committed');
});

// 视图结构自检：快照字段完整，可供结果页展示
test('删空全部键后再插入并重开：空叶保持闭合、审计仍通过', async () => {
  const { store, engine } = await freshDb();
  let r = await engine.submitBatch(
    [10, 20, 30].map((k) => ({ op: 'delete', key: k })), 'd1');
  assert.equal(r.status, 'committed');
  r = await engine.submitBatch(
    [40, 50, 60, 70].map((k) => ({ op: 'delete', key: k })), 'd2');
  assert.equal(r.status, 'committed');
  assert.equal(engine.snapshot().keyCount, 0);
  assert.equal(engine.snapshot().audit.pass, true);

  r = await engine.submitBatch([{ op: 'insert', key: 42, value: '答' }], 'reborn');
  assert.equal(r.status, 'committed');
  assert.equal(engine.lookup(42).value, '答');
  assert.equal(engine.snapshot().audit.pass, true);

  const { engine: e2, report } = await reopenEngine(store);
  assert.equal(report.conclusion, 'INTACT');
  assert.equal(e2.lookup(42).value, '答');
  assert.equal(e2.snapshot().audit.pass, true);
});

// 视图结构自检：快照字段完整，可供结果页展示
test('结果视图包含根代次、可达页、有序叶序列与恢复结论', async () => {
  const { engine } = await freshDb();
  const snap = snapshotOf(engine.state.pages, engine.state.rootId, engine.state.gen, engine.lastRecovery);
  assert.equal(typeof snap.gen, 'number');
  assert.equal(snap.reachablePages, snap.pages.length);
  assert.equal(snap.leafSequence.length, 7);
  assert.deepEqual(snap.leafSequence.map((x) => x.key), [10, 20, 30, 40, 50, 60, 70]);
  for (const p of snap.pages) assert.match(p.digest, /^[0-9a-f]{16}$/);
});

// ---------- 六、深层索引：叶序审计与点查询必须同时正确 ----------

const TEN_STEPS_14 = Array.from({ length: 14 }, (_, i) => [(i + 1) * 10, `w${(i + 1) * 10}`]);
const SIXTEEN_KEYS = Array.from({ length: 16 }, (_, i) => (i + 1) * 10);

test('深层索引正常提交：所有叶中键既可经查询路径读取也可更新，叶序审计与点查询同时通过', async () => {
  const store = new MemoryStore();
  const engine = new Engine(store);
  await engine.open();
  await engine.initialize(TEN_STEPS_14);
  const r = await engine.submitBatch([
    { op: 'insert', key: 150, value: 'w150' },
    { op: 'insert', key: 160, value: 'w160' },
  ], 'deep-normal');
  assert.equal(r.status, 'committed');
  const snap = engine.snapshot();
  assert.ok(snap.reachablePages >= 12, '深层树应达到深层分隔键重算的规模');
  assert.ok(snap.ordered && snap.allKeysOnce);
  assert.ok(snap.pointQueryOk, '点查询核验：' + snap.navigationProblems.join('；'));
  assert.ok(snap.audit.pass);
  for (const k of SIXTEEN_KEYS) assert.equal(engine.lookup(k).value, `w${k}`, `键 ${k} 必须可查`);
  const upd = await engine.submitBatch([{ op: 'update', key: 70, value: '改70' }], 'deep-upd70');
  assert.equal(upd.status, 'committed');
  assert.equal(engine.lookup(70).value, '改70');
  assert.equal(engine.lookup(80).value, 'w80', '相邻叶键不受影响');
});

test('深层索引阶段二（意图持久化后）断电重开：发布的新根上叶序审计与点查询同时正确', async () => {
  const store = new MemoryStore();
  const engine = new Engine(store);
  await engine.open();
  await engine.initialize(TEN_STEPS_14);
  const oldRoot = engine.state.rootId;
  const ack = await engine.submitBatch([
    { op: 'insert', key: 150, value: 'w150' },
    { op: 'insert', key: 160, value: 'w160' },
  ], 'deep-crash', CRASH_POINTS.AFTER_INTENT);
  assert.equal(ack.status, 'interrupted');
  assert.equal(engine.state.rootId, oldRoot);

  const e2 = new Engine(store);
  const report = await e2.open();
  assert.equal(report.conclusion, 'NEW_ROOT_PUBLISHED');
  const snap = e2.snapshot();
  assert.equal(snap.keyCount, 16);
  assert.ok(snap.ordered && snap.allKeysOnce, '叶序严格有序、每键一次');
  assert.ok(snap.pointQueryOk, '点查询不得因叶序审计通过而被掩盖：' + snap.navigationProblems.join('；'));
  assert.ok(snap.audit.pass);
  for (const k of SIXTEEN_KEYS) {
    const hit = e2.lookup(k);
    assert.ok(hit, `叶序列中的键 ${k} 必须经查询路径读到`);
    assert.equal(hit.value, `w${k}`);
  }
  // 曾被错误路由的键 70 必须可以更新
  const upd = await e2.submitBatch([{ op: 'update', key: 70, value: '新70' }], 'deep-fix-upd');
  assert.equal(upd.status, 'committed');
  assert.equal(e2.lookup(70).value, '新70');

  // 再次打开（刷新页面）：结论稳定为 INTACT，更新持久化，现象不复发
  const e3 = new Engine(store);
  const report3 = await e3.open();
  assert.equal(report3.conclusion, 'INTACT');
  assert.equal(e3.lookup(70).value, '新70');
  assert.ok(e3.snapshot().pointQueryOk);
});

test('发布闸门：候选新根引用闭合、摘要合法、叶序与键集合一致但点查询失效时，保留旧根', async () => {
  const store = new MemoryStore();
  const engine = new Engine(store);
  await engine.open();
  await engine.initialize(TEN_STEPS_14);
  const oldRoot = engine.state.rootId;
  await engine.submitBatch([
    { op: 'insert', key: 150, value: 'w150' },
    { op: 'insert', key: 160, value: 'w160' },
  ], 'deep-gate', CRASH_POINTS.AFTER_INTENT);

  // 篡改候选根：仅改分隔键（引用顺序、叶页全部不动），重算摘要使摘要校验通过
  const intent = await store.get('intent');
  const candidate = await store.get('page:' + intent.rootId);
  assert.equal(candidate.type, 'internal');
  const tampered = { ...candidate, keys: [90, 150] }; // 正确应为 [70,130]
  tampered.digest = digestPage(tampered);
  await store.put('page:' + candidate.id, tampered);

  const e2 = new Engine(store);
  const report = await e2.open();
  assert.equal(report.conclusion, 'OLD_ROOT_RETAINED');
  assert.match(report.detail, /点查询/);
  assert.equal(e2.state.rootId, oldRoot);
  assert.equal(e2.snapshot().gen, 1);
  assert.equal(e2.lookup(70).value, 'w70', '旧根既有键仍可查询');
  assert.equal(e2.lookup(150), null, '新键不进入查询视图');
  assert.equal((await store.get('receipt:deep-gate')).status, 'rolled-back');
  const stored = await store.allPageIds();
  assert.equal(stored.length, e2.snapshot().reachablePages, '候选孤儿页被清除');
});

test('已持久化的受影响索引重新打开：安全收敛为可查询根；再次打开稳定，不显示为健康旧根', async () => {
  const store = new MemoryStore();
  const engine = new Engine(store);
  await engine.open();
  await engine.initialize(TEN_STEPS_14);
  const good = await engine.submitBatch([
    { op: 'insert', key: 150, value: 'w150' },
    { op: 'insert', key: 160, value: 'w160' },
  ], 'affected-committed');
  assert.equal(good.status, 'committed');

  // 模拟旧版本已经把“分隔键错误的根”持久化（叶页与引用顺序完好、摘要全部合法）
  const rootPage = engine.state.pages.get(engine.state.rootId);
  const badRoot = {
    type: 'internal', id: null, gen: rootPage.gen,
    keys: [90, 150], children: rootPage.children,
  };
  badRoot.digest = digestPage(badRoot);
  badRoot.id = 'p' + badRoot.digest;
  await store.put('page:' + badRoot.id, badRoot);
  await store.put('root', {
    _id: 'root', rootId: badRoot.id, gen: rootPage.gen, keys: [...SIXTEEN_KEYS],
  });

  // 第一次重开：绝不当作健康已发布版本，须安全修复为可查询状态
  const e2 = new Engine(store);
  const r1 = await e2.open();
  assert.equal(r1.conclusion, 'REPAIRED_ROOT_PUBLISHED');
  assert.match(r1.detail, /点查询视图失效/);
  const snap = e2.snapshot();
  assert.ok(snap.pointQueryOk && snap.audit.pass);
  for (const k of SIXTEEN_KEYS) assert.equal(e2.lookup(k).value, `w${k}`, `修复后键 ${k} 可查`);
  const upd = await e2.submitBatch([{ op: 'update', key: 130, value: '改130' }], 'post-repair-upd');
  assert.equal(upd.status, 'committed');
  assert.equal(e2.lookup(130).value, '改130');

  // 再次打开：稳定收敛在可查询状态，结论为 INTACT
  const e3 = new Engine(store);
  const r2 = await e3.open();
  assert.equal(r2.conclusion, 'INTACT');
  assert.equal(e3.lookup(130).value, '改130');
  assert.equal(e3.lookup(70).value, 'w70');
  assert.equal(e3.lookup(160).value, 'w160');
  assert.ok(e3.snapshot().pointQueryOk && e3.snapshot().audit.pass);
  const stored = await store.allPageIds();
  assert.equal(stored.length, e3.snapshot().reachablePages, '失效旧内部页已回收');
});

// 顺序脚本作用在参考映射上的精确模拟：整批任一操作不合法即返回 null（与引擎整批拒绝对应）
function simulateScript(script, ref) {
  const next = new Map(ref);
  for (const e of script) {
    if (e.op === 'insert') {
      if (next.has(e.key)) return null;
      next.set(e.key, e.value);
    } else if (e.op === 'delete') {
      if (!next.has(e.key)) return null;
      next.delete(e.key);
    } else {
      if (!next.has(e.key)) return null;
      next.set(e.key, e.value);
    }
  }
  return next;
}

test('随机顺序脚本（固定种子）下点查询始终与参考映射一致，含深层树与多次重开', async () => {
  let seed = 0x1234abcd;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const store = new MemoryStore();
  let engine = new Engine(store);
  await engine.open();
  await engine.initialize([[0, 'v0']]);
  const ref = new Map([[0, 'v0']]);
  let seq = 0;
  for (let round = 0; round < 60; round++) {
    const edits = [];
    let guard = 0;
    while (edits.length < 6 && guard++ < 40) {
      const key = Math.floor(rnd() * 40);
      const roll = rnd();
      if (!ref.has(key) && roll < 0.65) edits.push({ op: 'insert', key, value: `v${key}` });
      else if (ref.has(key) && roll < 0.82) edits.push({ op: 'update', key, value: `v${key}-u${round}` });
      else if (ref.has(key)) edits.push({ op: 'delete', key });
    }
    if (!edits.length) continue;
    const expected = simulateScript(edits, ref);
    const receipt = await engine.submitBatch(edits, `rand-${seq++}`);
    if (expected === null) {
      assert.equal(receipt.status, 'rejected');
    } else {
      assert.equal(receipt.status, 'committed');
      ref.clear();
      for (const [k, v] of expected) ref.set(k, v);
    }
    const snap = engine.snapshot();
    assert.ok(snap.pointQueryOk, `第 ${round} 轮点查询失效：` + snap.navigationProblems.join('；'));
    assert.ok(snap.audit.pass);
    for (let k = 0; k < 40; k++) {
      const hit = engine.lookup(k);
      if (ref.has(k)) assert.equal(hit.value, ref.get(k), `第 ${round} 轮键 ${k}`);
      else assert.equal(hit, null);
    }
    if (round % 15 === 14) {
      const reopened = new Engine(store);
      const report = await reopened.open();
      assert.equal(report.conclusion, 'INTACT');
      engine = reopened;
    }
  }
  assert.ok(engine.snapshot().reachablePages >= 12, '随机用例应已进入深层树规模');
});

test('删除遗留的悬空分隔键合法：旧分界仍把所有现存键正确路由（等价于既有阶段二恢复语义）', async () => {
  const { store, engine } = await freshDb();
  await engine.submitBatch(
    [{ op: 'insert', key: 5, value: '五' }, { op: 'delete', key: 30 }],
    'dangling-sep', CRASH_POINTS.AFTER_INTENT,
  );
  const { engine: e2, report } = await reopenEngine(store);
  assert.equal(report.conclusion, 'NEW_ROOT_PUBLISHED');
  assert.ok(e2.snapshot().pointQueryOk);
  assert.equal(e2.lookup(30), null, '已删除键经悬空分界仍正确落空');
  assert.equal(e2.lookup(40).value, '四十', '右子树现存键路由正确');
  assert.equal(e2.lookup(20).value, '航点廿');
});

// 构造“深层坏根已发布”的持久化状态（叶页完好、引用闭合、摘要合法、键集合一致）
async function persistedBrokenDeepRoot(store) {
  const engine = new Engine(store);
  await engine.open();
  await engine.initialize(TEN_STEPS_14);
  await engine.submitBatch([
    { op: 'insert', key: 150, value: 'w150' },
    { op: 'insert', key: 160, value: 'w160' },
  ], 'seed');
  const rootPage = engine.state.pages.get(engine.state.rootId);
  const bad = {
    type: 'internal', id: null, gen: rootPage.gen, keys: [90, 150], children: rootPage.children,
  };
  bad.digest = digestPage(bad);
  bad.id = 'p' + bad.digest;
  await store.put('page:' + bad.id, bad);
  await store.put('root', { _id: 'root', rootId: bad.id, gen: rootPage.gen, keys: [...SIXTEEN_KEYS] });
  return { badGen: rootPage.gen };
}

test('坏根已发布且同代次意图仍在（根切换后清理前断电）：修复重发代次并作废意图，原批次标识可重新提交', async () => {
  const store = new MemoryStore();
  const { badGen } = await persistedBrokenDeepRoot(store);
  // 留下一个落后的在途意图（模拟根切换后、意图清理前断电的旧版本落库）
  await store.put('intent', {
    batchId: 'stale-pending', editDigest: 'x', gen: badGen + 1,
    rootId: 'p' + '0'.repeat(16), keys: [...SIXTEEN_KEYS, 170], pageIds: [],
  });

  const e2 = new Engine(store);
  const r = await e2.open();
  assert.equal(r.conclusion, 'REPAIRED_ROOT_PUBLISHED');
  assert.ok(e2.snapshot().pointQueryOk);
  assert.equal(e2.snapshot().gen, badGen + 2, '修复代次高于旧根与在途意图');
  assert.equal(await store.get('intent'), undefined, '落后意图已作废');
  assert.equal(await store.get('receipt:stale-pending'), undefined, '未伪造终局回执');
  // 原批次标识可正常重新提交
  const redone = await e2.submitBatch([{ op: 'insert', key: 170, value: 'w170' }], 'stale-pending');
  assert.equal(redone.status, 'committed');
  assert.equal(e2.lookup(170).value, 'w170');
});

test('修复已切根但遗留意图删除前再次断电：重开作废过期意图、保持可查询根', async () => {
  const store = new MemoryStore();
  const { badGen } = await persistedBrokenDeepRoot(store);
  // 先做一次修复
  let e = new Engine(store);
  await e.open();
  assert.equal((await store.get('root')).gen, badGen + 1);
  // 手工塞回一个“修复时本该删掉”的落后意图（模拟切根后、删意图前断电）
  await store.put('intent', {
    batchId: 'leftover', editDigest: 'x', gen: badGen, rootId: 'p' + '0'.repeat(16),
    keys: [...SIXTEEN_KEYS], pageIds: [],
  });

  const e2 = new Engine(store);
  const r = await e2.open();
  assert.equal(r.conclusion, 'INTACT');
  assert.equal(e2.state.gen, badGen + 1, '可查询根不变');
  assert.equal(await store.get('intent'), undefined);
  assert.equal(e2.lookup(70).value, 'w70');
  assert.ok(e2.snapshot().pointQueryOk);
});
