// 深层索引专项验收：
//   14 个按十递增航点 + 末尾边界后两键的批次，在“意图持久化后”断电，
//   重开发布新根时必须同时满足：叶序审计通过 **且** 点查询路径正确；
//   既有键（如 70）必须可读可改，再次打开依然健康。
// 另覆盖：被缺陷版本持久化的“叶序正确、查询失效”坏根在重开后安全自愈，
// 待决新根查询路径失效时保留旧根（不让叶序审计掩盖查询视图失效），
// 以及根切换后断电（阶段三清理前）的深层恢复。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine, CRASH_POINTS } from '../site/src/engine.mjs';
import { MemoryStore } from '../site/src/store.mjs';
import { digestPage } from '../site/src/digest.mjs';

const TAIL_KEYS = [150, 160];

function initial14() {
  const entries = [];
  for (let k = 10; k <= 140; k += 10) entries.push([k, `w${k}`]);
  return entries;
}
const tailEdits = () => TAIL_KEYS.map((k) => ({ op: 'insert', key: k, value: `w${k}` }));

async function bootDeep(store = new MemoryStore()) {
  const engine = new Engine(store);
  await engine.open();
  await engine.initialize(initial14());
  return { store, engine };
}

// 沿点查询路径逐键核对：查询结果必须与叶序视图逐项一致（键、值、所在叶页）
function assertPointQueriesAgreeWithLeafOrder(engine) {
  const snap = engine.snapshot();
  assert.ok(snap.leafCount >= 6, '场景必须是多层深层索引');
  assert.ok(snap.ordered, '叶序严格有序');
  assert.ok(snap.allKeysOnce, '每键恰好一次');
  assert.ok(snap.queryOk, '点查询路径校验通过');
  assert.ok(snap.audit.pass, '叶序审计通过');
  for (const item of snap.leafSequence) {
    const hit = engine.lookup(item.key);
    assert.ok(hit, `键 ${item.key} 必须可经查询路径读取（不得只在叶序列里存在）`);
    assert.equal(hit.key, item.key);
    assert.equal(hit.value, item.value, `键 ${item.key} 的值经查询路径读取一致`);
    assert.equal(hit.pageId, item.pageId, `键 ${item.key} 必须路由到唯一正确的叶页`);
  }
  // 边界外的键必须查不到
  for (const k of [0, 5, 155, 1000]) assert.equal(engine.lookup(k), null);
  return snap;
}

test('深层索引：意图持久化后断电，重开发布的新根必须叶序审计与点查询同时正确，既有键可读可改', async () => {
  const { store, engine } = await bootDeep();
  const oldRoot = engine.state.rootId;

  // 14 键树尚浅于旧实现的触发阈值；末尾边界之后的两个键使根分裂为三层
  const ack = await engine.submitBatch(tailEdits(), 'batch-tail-deep', CRASH_POINTS.AFTER_INTENT);
  assert.equal(ack.status, 'interrupted');
  assert.equal(ack.stage, 'INTENT');
  assert.equal(engine.state.rootId, oldRoot, '断电瞬间仍是旧根');

  const e2 = new Engine(store);
  const report = await e2.open();
  assert.equal(report.conclusion, 'NEW_ROOT_PUBLISHED');
  assert.equal(e2.state.gen, 2);
  assert.deepEqual(e2.snapshot().leafSequence.map((x) => x.key),
    [...initial14().map(([k]) => k), ...TAIL_KEYS]);
  // 缺陷场景：70 仍在叶序列中，但旧实现点查询返回 null
  assertPointQueriesAgreeWithLeafOrder(e2);
  assert.equal(e2.lookup(70).value, 'w70');
  assert.equal(e2.lookup(150).value, 'w150');
  assert.equal(e2.lookup(160).value, 'w160');

  // 叶序列里“明明存在”的键必须允许更新，且更新后路由仍正确
  const upd = await e2.submitBatch([{ op: 'update', key: 70, value: 'w70-改' }], 'batch-upd-70');
  assert.equal(upd.status, 'committed');
  assert.equal(e2.lookup(70).value, 'w70-改');
  const snap = assertPointQueriesAgreeWithLeafOrder(e2);
  assert.equal(snap.audit.pass, true);
});

test('深层索引：发布后再次打开（刷新页面）仍收敛为可查询状态，读取与更新都不再失效', async () => {
  const { store, engine: e0 } = await bootDeep();
  await e0.submitBatch(tailEdits(), 'batch-tail-deep', CRASH_POINTS.AFTER_INTENT);

  // 第一次重开：发布新根
  const e1 = new Engine(store);
  const r1 = await e1.open();
  assert.equal(r1.conclusion, 'NEW_ROOT_PUBLISHED');
  assert.equal(e1.lookup(70).value, 'w70');

  // 第二次重开（模拟用户刷新页面）：INTACT，现象不得复发
  const e2 = new Engine(store);
  const r2 = await e2.open();
  assert.equal(r2.conclusion, 'INTACT');
  assertPointQueriesAgreeWithLeafOrder(e2);
  const upd = await e2.submitBatch([{ op: 'update', key: 140, value: 'w140-改' }], 'batch-upd-140');
  assert.equal(upd.status, 'committed');
  assert.equal(e2.lookup(140).value, 'w140-改');

  // 第三次重开：更新已持久化，全部键仍可经查询路径读取
  const e3 = new Engine(store);
  const r3 = await e3.open();
  assert.equal(r3.conclusion, 'INTACT');
  assert.equal(e3.lookup(140).value, 'w140-改');
  assert.equal(e3.lookup(70).value, 'w70');
  assertPointQueriesAgreeWithLeafOrder(e3);
});

test('深层索引：根切换后断电（阶段三清理前）重开，新根点查询同样正确', async () => {
  const { store, engine: e0 } = await bootDeep();
  await e0.submitBatch(tailEdits(), 'batch-after-root', CRASH_POINTS.AFTER_ROOT);

  const e1 = new Engine(store);
  const r1 = await e1.open();
  assert.equal(r1.conclusion, 'NEW_ROOT_PUBLISHED');
  assertPointQueriesAgreeWithLeafOrder(e1);
  assert.equal(e1.lookup(160).value, 'w160');
});

// 重写一个内部页：替换正文后按内容寻址重算 digest/id
function reStamp(page, patch) {
  const next = { ...page, ...patch };
  delete next.id;
  delete next.digest;
  next.digest = digestPage(next);
  next.id = 'p' + next.digest;
  return next;
}

test('已被缺陷版本持久化的坏根（叶序正确但点查询失效）：重开安全自愈为可查询根，再开保持健康', async () => {
  // 先让修复版引擎产出正确的深层已提交树（其叶页与缺陷版完全一致，仅根分隔键不同）
  const store = new MemoryStore();
  const e0 = new Engine(store);
  await e0.open();
  await e0.initialize(initial14());
  const good = await e0.submitBatch(tailEdits(), 'batch-tail-deep');
  assert.equal(good.status, 'committed');

  // 把持久化根改写成缺陷版形态：正确根分隔键 [70,130] -> 缺陷版 [90,150]，
  // 中间子树（首叶 [70,80]）不变。摘要重算为合法、引用闭合、叶序列仍严格有序——
  // 只有点查询路径失效（90 > 右邻子树首键 70）。
  const rootRec = await store.get('root');
  const goodRoot = await store.get('page:' + rootRec.rootId);
  const brokenRoot = reStamp(goodRoot, { keys: [90, 150] });
  await store.put('page:' + brokenRoot.id, brokenRoot);
  await store.put('root', { ...rootRec, rootId: brokenRoot.id });

  // 新版本重开：不得继续显示为健康的已发布版本，必须自愈为可查询根
  const e1 = new Engine(store);
  const r1 = await e1.open();
  assert.equal(r1.conclusion, 'PUBLISHED_ROOT_REPAIRED');
  assert.equal(e1.lookup(70).value, 'w70', '既有键必须可读');
  assertPointQueriesAgreeWithLeafOrder(e1);
  const upd = await e1.submitBatch([{ op: 'update', key: 70, value: 'w70-自愈改' }], 'batch-after-repair');
  assert.equal(upd.status, 'committed');
  assert.equal(e1.lookup(70).value, 'w70-自愈改');
  assert.equal(e1.lookup(160).value, 'w160');

  // 同批次标识等价重传仍回放原回执，不再改根
  const replay = await e1.submitBatch(tailEdits(), 'batch-tail-deep');
  assert.equal(replay.replayed, true);
  assert.equal(e1.snapshot().gen, 3, '重传不推进代次');

  // 再次打开：已持久化收敛，普通 INTACT 且全部可查
  const e2 = new Engine(store);
  const r2 = await e2.open();
  assert.equal(r2.conclusion, 'INTACT');
  assert.equal(e2.lookup(70).value, 'w70-自愈改');
  assertPointQueriesAgreeWithLeafOrder(e2);
});

test('自愈只在叶数据与原子提交键集合一致时发生：不一致则冻结为不健康，任何批次不得改根', async () => {
  const store = new MemoryStore();
  const e0 = new Engine(store);
  await e0.open();
  await e0.initialize(initial14());
  await e0.submitBatch(tailEdits(), 'batch-tail-deep');
  const rootRec = await store.get('root');
  const goodRoot = await store.get('page:' + rootRec.rootId);
  const brokenRoot = reStamp(goodRoot, { keys: [90, 150] });
  await store.put('page:' + brokenRoot.id, brokenRoot);
  // 键集合与叶数据不符：不能判定权威数据，必须拒绝猜测重建
  await store.put('root', { ...rootRec, rootId: brokenRoot.id, keys: [10, 20] });

  const e1 = new Engine(store);
  const r1 = await e1.open();
  assert.equal(r1.conclusion, 'PUBLISHED_ROOT_UNHEALTHY');
  const rej = await e1.submitBatch([{ op: 'insert', key: 1, value: 'x' }], 'b-freeze');
  assert.equal(rej.status, 'rejected');
  assert.equal(rej.code, 'BROKEN_ROUTING');
  assert.equal((await store.get('root')).rootId, brokenRoot.id, '坏根原样冻结');
});

test('待决意图的新根若查询路径失效：重开保留旧根并记录原因，绝不发布“叶序健康”的不可查新根', async () => {
  const { store, engine } = await bootDeep();
  const oldRoot = engine.state.rootId;
  await engine.submitBatch(tailEdits(), 'batch-bad-newroot', CRASH_POINTS.AFTER_INTENT);
  const intent = await store.get('intent');
  // 篡改意图所指新根的分隔键（摘要重算为合法、引用仍闭合、叶序仍严格有序）
  const newRoot = await store.get('page:' + intent.rootId);
  const bad = reStamp(newRoot, { keys: newRoot.keys.map((k, i) => k + 1000 * (i + 1)) });
  await store.put('page:' + bad.id, bad);
  await store.put('intent', { ...intent, rootId: bad.id, pageIds: [...intent.pageIds, bad.id] });

  const e2 = new Engine(store);
  const report = await e2.open();
  assert.equal(report.conclusion, 'OLD_ROOT_RETAINED');
  assert.match(report.detail, /查询路径|错路/);
  assert.equal(e2.state.rootId, oldRoot);
  assert.equal(e2.snapshot().gen, 1);
  assert.equal(e2.lookup(150), null);
  assert.equal(e2.lookup(70).value, 'w70', '旧根既有键照常可查');
  const receipt = await store.get('receipt:batch-bad-newroot');
  assert.equal(receipt.status, 'rolled-back');
});
