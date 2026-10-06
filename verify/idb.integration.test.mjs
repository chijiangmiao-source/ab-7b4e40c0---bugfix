// 浏览器适配层（IDBStore）端到端集成测试：
// 通过 IndexedDB 垫片跑“初始化 → 分裂批次 → 各阶段中断 → 重开恢复”全链路，
// 证明浏览器使用的真实存储适配（而非仅内存实现）与三阶段协议协作正确。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeIndexedDB } from './fake-idb.mjs';
import { IDBStore } from '../site/src/store.mjs';
import { Engine, CRASH_POINTS } from '../site/src/engine.mjs';

const DB = 'track-idb-test';

// node:test 同文件用例并发运行，垫片按库名隔离；全局只安装一次。
installFakeIndexedDB();

test('IDB 适配层：完整生命周期与分裂审计', async () => {
  const store = await IDBStore.open(DB);
  const engine = new Engine(store);
  const boot = await engine.open();
  assert.equal(boot.conclusion, 'FRESH');

  await engine.initialize([[1, '甲'], [2, '乙'], [3, '丙']]);
  await engine.submitBatch([{ op: 'insert', key: 4, value: '丁' }], 'split');
  const snap = engine.snapshot();
  assert.equal(snap.gen, 2);
  assert.equal(snap.leafCount, 2);
  assert.equal(snap.audit.pass, true);
  assert.deepEqual(snap.leafSequence.map((x) => x.key), [1, 2, 3, 4]);
  await store.close();
});

test('IDB 适配层：after-intent 断电后以全新进程视角重开，发布新根', async () => {
  let store = await IDBStore.open(DB + "-crash");
  let engine = new Engine(store);
  await engine.open();
  await engine.initialize([[10, 'a'], [20, 'b'], [30, 'c'], [40, 'd'], [50, 'e']]);
  await engine.submitBatch([
    { op: 'insert', key: 5, value: '五' },
    { op: 'delete', key: 30 },
    { op: 'update', key: 20, value: '廿' },
  ], 'b1', CRASH_POINTS.AFTER_INTENT);
  await store.close();

  // 全新连接 = 重开（不重置垫片数据）
  const store2 = await IDBStore.open(DB + '-crash');
  const e2 = new Engine(store2);
  const report = await e2.open();
  assert.equal(report.conclusion, 'NEW_ROOT_PUBLISHED');
  const snap = e2.snapshot();
  assert.equal(snap.audit.pass, true);
  assert.deepEqual(snap.leafSequence.map((x) => x.key), [5, 10, 20, 40, 50]);
  assert.equal(e2.lookup(20).value, '廿');

  // 同批次等价重传回放原回执
  const replay = await e2.submitBatch([
    { op: 'insert', key: 5, value: '五' },
    { op: 'delete', key: 30 },
    { op: 'update', key: 20, value: '廿' },
  ], 'b1');
  assert.equal(replay.replayed, true);
  await store2.close();
});

test('IDB 适配层：during-pages 断电后重开停在旧根', async () => {
  let store = await IDBStore.open(DB + "-pages");
  let engine = new Engine(store);
  await engine.open();
  await engine.initialize([[1, 'a'], [2, 'b'], [3, 'c']]);
  await engine.submitBatch([{ op: 'insert', key: 9, value: 'nine' }], 'b2', CRASH_POINTS.DURING_PAGES);
  await store.close();

  const store2 = await IDBStore.open(DB + '-pages');
  const e2 = new Engine(store2);
  const report = await e2.open();
  assert.equal(report.conclusion, 'INTACT');
  assert.equal(e2.lookup(9), null);
  assert.equal(e2.snapshot().audit.pass, true);
  await store2.close();
});

test('IDB 适配层：深层索引 after-intent 断电重开后，既有键点查询与更新都可用，再开保持健康', async () => {
  const entries = [];
  for (let k = 10; k <= 140; k += 10) entries.push([k, `w${k}`]);
  let store = await IDBStore.open(DB + '-deep');
  let engine = new Engine(store);
  await engine.open();
  await engine.initialize(entries);
  await engine.submitBatch([
    { op: 'insert', key: 150, value: 'w150' },
    { op: 'insert', key: 160, value: 'w160' },
  ], 'deep-tail', CRASH_POINTS.AFTER_INTENT);
  await store.close();

  // 全新连接 = 重开复核
  const store2 = await IDBStore.open(DB + '-deep');
  const e2 = new Engine(store2);
  const report = await e2.open();
  assert.equal(report.conclusion, 'NEW_ROOT_PUBLISHED');
  const snap = e2.snapshot();
  assert.equal(snap.audit.pass, true);
  assert.equal(snap.queryOk, true);
  assert.equal(snap.keyCount, 16);
  // 叶序列里存在的既有键必须可经查询路径读取（缺陷场景下此处返回 null）
  assert.equal(e2.lookup(70).value, 'w70');
  assert.equal(e2.lookup(160).value, 'w160');
  const upd = await e2.submitBatch([{ op: 'update', key: 70, value: 'w70-改' }], 'deep-upd');
  assert.equal(upd.status, 'committed');
  assert.equal(e2.lookup(70).value, 'w70-改');
  await store2.close();

  // 再次打开（模拟刷新页面）：INTACT 且现象不复发
  const store3 = await IDBStore.open(DB + '-deep');
  const e3 = new Engine(store3);
  const report3 = await e3.open();
  assert.equal(report3.conclusion, 'INTACT');
  assert.equal(e3.lookup(70).value, 'w70-改');
  assert.equal(e3.snapshot().audit.pass, true);
  await store3.close();
});

test('IDB 适配层：单事务 putMany 后根与回执同时可见', async () => {
  const store = await IDBStore.open(DB + "-tx");
  const engine = new Engine(store);
  await engine.open();
  await engine.initialize([[1, 'a']]);
  const r = await engine.submitBatch([{ op: 'insert', key: 2, value: 'b' }], 'tx1');
  assert.equal(r.status, 'committed');
  const root = await store.get('root');
  const receipt = await store.get('receipt:tx1');
  assert.equal(root.gen, 2);
  assert.equal(receipt.status, 'committed');
  assert.deepEqual(root.keys, [1, 2]);
  assert.equal(await store.get('intent'), undefined);
  await store.close();
});
