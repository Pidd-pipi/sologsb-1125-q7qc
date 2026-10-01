import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { MeteoriteDB, DB_NAME, BATCH_REVISION_KEY } from '../src/db';
import {
  previewRenumber,
  commitRenumber,
  RenumberConflictError,
} from '../src/services/renumber';
import type { MeteoriteSample } from '../src/types/sample';

let passed = 0;
let failed = 0;

function assert(cond: boolean, msg: string) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
}

async function makeDb(): Promise<MeteoriteDB> {
  await Dexie.delete(DB_NAME);
  const db = new MeteoriteDB();
  await db.open();
  return db;
}

async function seedSamples(db: MeteoriteDB, nos: string[]): Promise<string[]> {
  const ids: string[] = [];
  const now = Date.now();
  for (let i = 0; i < nos.length; i++) {
    const id = `sample_${i}_${Math.random().toString(36).slice(2, 8)}`;
    ids.push(id);
    const sample: MeteoriteSample = {
      id,
      sampleNo: nos[i],
      aliases: [],
      totalWeight: 100 + i,
      category: 'chondrite',
      chemicalGroup: 'H',
      weathering: 'W1',
      fallOrFind: 'find',
      storage: 'cabinet-a',
      createdAt: now + i * 1000,
      updatedAt: now + i * 1000,
    };
    await db.samples.add(sample);
  }
  return ids;
}

async function testBasicRenumber() {
  console.log('\n[1] 基本换号：MET → GB-MET，旧号留别名');
  const db = await makeDb();
  await seedSamples(db, ['MET-2024-001', 'MET-2024-002', 'MET-2024-003']);

  const preview = await previewRenumber(db);
  assert(preview.errors.length === 0, '无阻断性错误');
  assert(preview.plan.length === 3, '计划包含 3 份样本');
  assert(preview.plan[0].oldNo === 'MET-2024-001', '第 1 条旧号 MET-2024-001');
  assert(preview.plan[0].newNo === 'GB-MET-2026-001', '第 1 条新号 GB-MET-2026-001');
  assert(preview.plan[1].newNo === 'GB-MET-2026-002', '第 2 条新号 GB-MET-2026-002');
  assert(preview.plan[2].newNo === 'GB-MET-2026-003', '第 3 条新号 GB-MET-2026-003');

  const rev = await commitRenumber(db, preview);
  assert(rev === 1, '提交后批次版本为 1');

  const samples = await db.samples.toArray();
  const s1 = samples.find((s) => s.sampleNo === 'GB-MET-2026-001');
  assert(!!s1, '样本已启用新号 GB-MET-2026-001');
  assert(s1?.aliases?.includes('MET-2024-001'), '旧号 MET-2024-001 已留为别名');
  assert(!samples.some((s) => s.sampleNo === 'MET-2024-001'), '旧号不再作为现用号');

  // 再次预览：全部已是 GB-MET，计划为空
  const preview2 = await previewRenumber(db);
  assert(preview2.plan.length === 0, '换号后再次预览计划为空');
  assert(preview2.baseRevision === 1, '再次预览版本为 1');
  db.close();
}

async function testCollisionBlock() {
  console.log('\n[2] 新号撞车：整批不改');
  const db = await makeDb();
  // 先放一个 GB-MET-2026-001 占用新号段
  await seedSamples(db, ['GB-MET-2026-001', 'MET-2024-001', 'MET-2024-002']);

  const preview = await previewRenumber(db);
  // MET-2024-001 → GB-MET-2026-002, MET-2024-002 → GB-MET-2026-003，不撞车
  assert(preview.errors.length === 0, '新号顺延不撞车，无错误');
  assert(preview.plan[0].newNo === 'GB-MET-2026-002', '新号从 002 开始顺延');

  // 制造撞车：手动让两个旧号都指向同一新号（通过重复旧号）
  const db2 = await makeDb();
  await seedSamples(db2, ['MET-2024-001', 'MET-2024-001']);
  const preview2 = await previewRenumber(db2);
  assert(preview2.errors.some((e) => e.kind === 'collision'), '重复旧号触发撞车错误');
  db.close();
  db2.close();
}

async function testMissingRelationBlock() {
  console.log('\n[3] 关系缺失：孤儿引用整批不改');
  const db = await makeDb();
  const ids = await seedSamples(db, ['MET-2024-001']);
  // 插入一条指向不存在样本的发现地
  await db.finds.add({
    id: 'find_orphan',
    sampleId: 'sample_nonexistent',
    placeName: '孤儿发现地',
    region: '测试地区',
    longitude: 0,
    latitude: 0,
    coordinateSource: 'gps',
    environment: 'desert',
    finder: '测试',
    createdAt: Date.now(),
  });
  // 插入一条指向不存在样本的切片
  await db.sections.add({
    id: 'section_orphan',
    sectionNo: 'TS-2024-001',
    sampleId: 'sample_nonexistent',
    thickness: 30,
    preparation: 'resin',
    minerals: { olivine: 40, pyroxene: 30, feldspar: 15, metal: 15 },
    micrographs: [],
    quality: 'unrated',
    createdAt: Date.now(),
  });

  const preview = await previewRenumber(db);
  assert(preview.errors.length === 2, '发现地与切片孤儿各报一个错');
  assert(
    preview.errors.every((e) => e.kind === 'missing-relation'),
    '错误类型均为关系缺失',
  );

  // 尝试提交应失败
  let threw = false;
  try {
    await commitRenumber(db, preview);
  } catch {
    threw = true;
  }
  assert(threw, '存在阻断项时提交被拒绝');

  // 确认数据未被修改
  const samples = await db.samples.toArray();
  assert(samples[0].sampleNo === 'MET-2024-001', '阻断提交后样本号未变');
  db.close();
}

async function testConcurrentConflict() {
  console.log('\n[4] 并发提交：后到一方看到批次已变并重新预览');
  const db = await makeDb();
  await seedSamples(db, ['MET-2024-001', 'MET-2024-002']);

  // 两个人同时预览，都基于版本 0
  const previewA = await previewRenumber(db);
  const previewB = await previewRenumber(db);
  assert(previewA.baseRevision === 0 && previewB.baseRevision === 0, '双方预览版本均为 0');

  // A 先提交
  const revA = await commitRenumber(db, previewA);
  assert(revA === 1, 'A 提交后版本为 1');

  // B 后提交，应冲突
  let conflict = false;
  try {
    await commitRenumber(db, previewB);
  } catch (e) {
    conflict = e instanceof RenumberConflictError;
  }
  assert(conflict, 'B 提交时检测到批次冲突');

  // B 重新预览，应看到新版本且计划为空
  const previewB2 = await previewRenumber(db);
  assert(previewB2.baseRevision === 1, 'B 重新预览版本为 1');
  assert(previewB2.plan.length === 0, 'B 重新预览计划为空（已被 A 换完）');

  // 确认最终结果只有一份换号结果，没有混成两批
  const samples = await db.samples.toArray();
  assert(
    samples.every((s) => s.sampleNo.startsWith('GB-MET-')),
    '所有样本均为 GB-MET 号，无重复换号',
  );
  assert(
    samples.filter((s) => s.aliases?.includes('MET-2024-001')).length === 1,
    'MET-2024-001 只出现一次别名',
  );
  db.close();
}

async function testSnapshotFreeze() {
  console.log('\n[5] 导出清单：快照冻结当时编号');
  const db = await makeDb();
  const ids = await seedSamples(db, ['MET-2024-001', 'MET-2024-002']);

  // 换号前导出清单
  const snapId = `snap_${Math.random().toString(36).slice(2, 8)}`;
  await db.snapshots.add({
    id: snapId,
    label: '换号前导出',
    createdAt: Date.now(),
    items: ids.map((id, i) => ({ sampleId: id, sampleNo: `MET-2024-00${i + 1}` })),
  });

  const preview = await previewRenumber(db);
  assert(preview.affectedSnapshots.length === 1, '预览列出受影响的导出清单');
  assert(preview.affectedSnapshots[0].frozenCount === 2, '清单冻结 2 份样本编号');

  await commitRenumber(db, preview);

  // 换号后快照仍显示旧号
  const snap = await db.snapshots.get(snapId);
  assert(snap?.items[0].sampleNo === 'MET-2024-001', '换号后快照仍显示 MET-2024-001');
  db.close();
}

async function testAliasSearch() {
  console.log('\n[6] 旧号别名可检索');
  const db = await makeDb();
  await seedSamples(db, ['MET-2024-001']);
  const preview = await previewRenumber(db);
  await commitRenumber(db, preview);

  // 通过 aliases 多入口索引检索旧号
  const found = await db.samples.where('aliases').equals('MET-2024-001').toArray();
  assert(found.length === 1, '通过别名索引能检索到旧号 MET-2024-001');
  assert(found[0].sampleNo === 'GB-MET-2026-001', '检索到的样本现号为 GB-MET-2026-001');
  db.close();
}

async function main() {
  console.log('=== 整批换号逻辑测试 ===');
  await testBasicRenumber();
  await testCollisionBlock();
  await testMissingRelationBlock();
  await testConcurrentConflict();
  await testSnapshotFreeze();
  await testAliasSearch();
  console.log(`\n=== 结果：${passed} 通过，${failed} 失败 ===`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
