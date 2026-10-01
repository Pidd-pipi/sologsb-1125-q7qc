/**
 * 整批换号领域逻辑的端到端验证（fake-indexeddb，直接跑 Dexie）。
 * 用 esbuild 临时打包后由 node 执行；不进生产包。
 */
import 'fake-indexeddb/auto';
import { db, getCatalogVersion } from '../src/db';
import { seedIfEmpty } from '../src/db';
import { commitRenumber, previewRenumber } from '../src/services/renumber';
import { CatalogStaleError } from '../src/types/renumber';

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean, extra = '') {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${name} ${extra}`);
  }
}

async function resetDb() {
  await db.delete();
  await db.open();
  await seedIfEmpty();
}

async function main() {
  // ---------- 1. 预检：列出五类受影响条目 ----------
  await resetDb();
  console.log('1) 预检列出受影响条目');
  const preview = await previewRenumber([
    { sampleId: 'sample_seed_1', oldSampleNo: 'MET-2024-001', newSampleNo: 'GB-MET-000001' },
    { sampleId: 'sample_seed_2', oldSampleNo: 'MET-2024-002', newSampleNo: 'GB-MET-000002' },
  ]);
  check('无阻断问题', preview.issues.length === 0, JSON.stringify(preview.issues));
  const e1 = preview.entries.find((x) => x.sampleId === 'sample_seed_1')!;
  check('样本受影响（条目本身）', preview.entries.length === 2);
  check('发现地 1 条', e1.refs.finds.length === 1);
  check('切片 1 张', e1.refs.sections.length === 1);
  check('检测记录 1 条', e1.refs.analysis.length === 1);
  check('导出清单条目 1（含冻结号）', e1.refs.manifests.length === 1 && e1.refs.manifests[0].frozenNo === 'MET-2024-001');

  // ---------- 2. 撞车：新号撞现有编号 / 批内重复 / 格式错 ----------
  console.log('2) 新号撞车整批不改');
  // 先用合法 GB-MET 号撞他条当前编号（批内占用），再验证非 GB-MET 格式
  const collision = await previewRenumber([
    // GB-MET-900001 合法但撞不到现有号；用同批他条旧号（换号后旧号才释放）制造撞车
    { sampleId: 'sample_seed_1', oldSampleNo: 'MET-2024-001', newSampleNo: 'GB-MET-900001' },
    { sampleId: 'sample_seed_2', oldSampleNo: 'MET-2024-002', newSampleNo: 'GB-MET-900001' },
  ]);
  check('批内同号被判为重复撞车', collision.issues.some((i) => i.code === 'new-no-duplicate-in-batch'));

  // 合法格式新号撞上批外现有编号（MET-2024-002 虽不是 GB-MET 号，但占用检查不挑格式——
  // 所以构造一条：把新号写成他档案当前编号会先过不了格式；改为先给 seed_2 换成 GB-MET 号再撞）
  // 这里直接验证非 GB-MET 格式被拦：
  const badFormat = await previewRenumber([
    { sampleId: 'sample_seed_1', oldSampleNo: 'MET-2024-001', newSampleNo: 'GB-MET-1' },
  ]);
  check('命中格式不符', badFormat.issues.some((i) => i.code === 'new-no-format'));
  const dup = await previewRenumber([
    { sampleId: 'sample_seed_1', oldSampleNo: 'MET-2024-001', newSampleNo: 'GB-MET-000009' },
    { sampleId: 'sample_seed_2', oldSampleNo: 'MET-2024-002', newSampleNo: 'GB-MET-000009' },
  ]);
  check('批内重复撞号', dup.issues.some((i) => i.code === 'new-no-duplicate-in-batch'));

  // ---------- 3. 关系缺失：检测记录指向不存在的切片 ----------
  console.log('3) 关系缺失整批不改');
  await db.analysis.add({
    id: 'analysis_dangling',
    sampleId: 'sample_seed_1',
    sectionId: 'section_not_exist',
    target: 'section',
    method: 'sem-eds',
    fa: 1,
    fs: 2,
    ni: 3,
    kamaciteBandwidth: 0.1,
    testedAt: '2024-09-09',
    createdAt: Date.now(),
  });
  const missing = await previewRenumber([
    { sampleId: 'sample_seed_1', oldSampleNo: 'MET-2024-001', newSampleNo: 'GB-MET-000001' },
  ]);
  check('检测切片关系缺失被检出', missing.issues.some((i) => i.code === 'analysis-target-missing'));
  await db.analysis.delete('analysis_dangling');

  // ---------- 4. 合法提交：旧号别名、全部引用指向新档案 ----------
  console.log('4) 提交后旧号成唯一别名，引用全部重指');
  const okPreview = await previewRenumber([
    { sampleId: 'sample_seed_1', oldSampleNo: 'MET-2024-001', newSampleNo: 'GB-MET-000001' },
    { sampleId: 'sample_seed_2', oldSampleNo: 'MET-2024-002', newSampleNo: 'GB-MET-000002' },
  ]);
  const beforeVersion = await getCatalogVersion();
  const result = await commitRenumber(okPreview, '并入测试');
  check('提交成功', !!result.batch.id);

  const old1StillThere = await db.samples.get('sample_seed_1');
  check('旧档案已删除', old1StillThere === undefined);
  const new1 = await db.samples.get(result.batch.entries[0].newSampleId);
  check('新档案使用 GB-MET 编号', new1?.sampleNo === 'GB-MET-000001');
  check('旧号成为别名', JSON.stringify(new1?.aliases) === JSON.stringify(['MET-2024-001']));
  check('别名唯一（无重复）', new Set(new1?.aliases).size === new1?.aliases.length);

  const newId1 = result.batch.entries[0].newSampleId;
  const newId2 = result.batch.entries[1].newSampleId;
  const find = await db.finds.get('find_seed_1');
  check('发现地重指新档案', find?.sampleId === newId1);
  const section = await db.sections.get('section_seed_1');
  check('切片重指新档案', section?.sampleId === newId1);
  const analysis = await db.analysis.get('analysis_seed_2');
  check('检测记录重指新档案', analysis?.sampleId === newId2);

  // 导出清单：引用换了，冻结编号不变
  const manifest = await db.exportManifests.get('manifest_seed_1');
  const item1 = manifest?.items.find((i) => i.lineNo === 1);
  check('清单条目指向新档案', item1?.sampleId === newId1);
  check('清单冻结编号仍是旧号', item1?.sampleNoAtExport === 'MET-2024-001');

  // 旧号全局唯一：没有任何样本把 MET-2024-001 当现用号，且只出现一次别名
  const all = await db.samples.toArray();
  const aliasCount = all.filter((s) => (s.aliases ?? []).includes('MET-2024-001')).length;
  check('旧号别名全局唯一', aliasCount === 1);

  // ---------- 5. 历史快照：显示当时编号 ----------
  console.log('5) 历史快照保留当时编号');
  const snap = await db.historySnapshots.get(result.snapshot.id);
  check('快照存在且关联批次', snap?.batchId === result.batch.id);
  const snapSample = snap?.samples.find((s) => s.sample.sampleNo === 'MET-2024-001');
  check('快照内仍显示旧编号', !!snapSample);
  check('快照冻结发现地/切片/检测', !!snapSample?.find && snapSample.sections.length === 1 && snapSample.analysis.length === 1);
  check('快照 idMap 记录旧→新', snap?.idMap['sample_seed_1'] === newId1);

  // ---------- 6. 旧号不可再被当新号使用 ----------
  console.log('6) 旧号唯一保留，撞别名时阻断');
  const aliasCollision = await previewRenumber([
    { sampleId: 'sample_seed_3', oldSampleNo: 'MET-2024-003', newSampleNo: 'GB-MET-000001' },
  ]);
  check('新号撞已有现用号被拦', aliasCollision.issues.some((i) => i.code === 'new-no-collision'));
  // 用旧号（现是别名）作为另一批新号：旧号不是 GB-MET 格式会先撞格式，
  // 因此改为验证「合法新号恰好等于某旧别名」的场景——把 seed_3 换成一个曾被使用的 GB-MET 号：
  // GB-MET-000001 是新档案 currentNo 而非别名（new-no-collision 分支，已上面验证）；
  // 这里构造二次换号：把 newId1 再次换号，其旧别名 GB-MET-000001 之后应不可被他样本复用
  const second = await previewRenumber([
    { sampleId: newId1, oldSampleNo: 'GB-MET-000001', newSampleNo: 'GB-MET-000201' },
  ]);
  check('同一档案二次换号预检通过', second.issues.length === 0, JSON.stringify(second.issues));
  await commitRenumber(second, '新档案二次换号');
  const reuseOld2 = await previewRenumber([
    { sampleId: 'sample_seed_3', oldSampleNo: 'MET-2024-003', newSampleNo: 'GB-MET-000001' },
  ]);
  check('复用已成别名的旧 GB-MET 号被拦', reuseOld2.issues.some((i) => i.code === 'alias-collision'));

  // ---------- 7. 并发：两人同批，后到者必须重新预览 ----------
  console.log('7) 并发提交：后到者看到批次已变并失败');
  // 标签A 与 标签B 同时对 sample_seed_3 生成预览
  const previewA = await previewRenumber([
    { sampleId: 'sample_seed_3', oldSampleNo: 'MET-2024-003', newSampleNo: 'GB-MET-000003' },
  ]);
  const previewB = await previewRenumber([
    { sampleId: 'sample_seed_3', oldSampleNo: 'MET-2024-003', newSampleNo: 'GB-MET-000099' },
  ]);
  // A 先提交成功（版本在初始提交后再 +1；具体值与前置动作数量解耦，只断言严格递增）
  const versionBeforeA = await getCatalogVersion();
  await commitRenumber(previewA, 'A 的换号');
  const versionAfterA = await getCatalogVersion();
  check('A 提交后版本推进', versionAfterA === versionBeforeA + 1);
  // B 用旧预览提交 → 必须整批失败
  let bError: unknown = null;
  try {
    await commitRenumber(previewB, 'B 的换号');
  } catch (err) {
    bError = err;
  }
  check('B 提交被拒', bError instanceof CatalogStaleError);
  check('整批未混成两批：B 的新号没落库', (await db.samples.where('sampleNo').equals('GB-MET-000099').count()) === 0);
  const sample3After = await db.samples.where('sampleNo').equals('GB-MET-000003').first();
  check('档案是 A 的结果（GB-MET-000003 + 旧号别名）', sample3After?.aliases?.includes('MET-2024-003') === true);
  // B 重新预览后看到现状（旧号已是别名，sample-changed 不会出现因为 B 用旧 id 已失效）
  const previewB2 = await previewRenumber([
    { sampleId: sample3After!.id, oldSampleNo: 'GB-MET-000003', newSampleNo: 'GB-MET-000100' },
  ]);
  check('B 重新预览后可再次提交', previewB2.issues.length === 0, JSON.stringify(previewB2.issues));
  await commitRenumber(previewB2, 'B 重新预览后的换号');
  const final3 = await db.samples.where('sampleNo').equals('GB-MET-000100').first();
  // 多轮换号：历次旧号（原始号 + 上一轮 GB-MET 号）累积成唯一别名列表
  check('二次换号累积别名', JSON.stringify(final3?.aliases) === JSON.stringify(['MET-2024-003', 'GB-MET-000003']));

  // ---------- 8. 阻断时绝无部分写入（版本不变、无新档案） ----------
  console.log('8) 原子性：阻断提交零写入');
  const vBefore = await getCatalogVersion();
  // newId1 在第 6 节已二次换号为 GB-MET-000201，取它当前档案做撞车尝试
  const id1Current = await db.samples.where('sampleNo').equals('GB-MET-000201').first();
  const id2Current = await db.samples.where('sampleNo').equals('GB-MET-000002').first();
  const badPreview = await previewRenumber([
    { sampleId: id1Current!.id, oldSampleNo: 'GB-MET-000201', newSampleNo: 'GB-MET-000002' },
  ]);
  // 该预览本身有撞车问题（GB-MET-000002 是他档现用号）；强制带空 issues 提交也必须被事务内复检拦下
  let atomicError: unknown = null;
  try {
    await commitRenumber({ ...badPreview, issues: [] }, '强行提交坏批次');
  } catch (err) {
    atomicError = err;
  }
  check('坏批次被事务拒绝', atomicError instanceof CatalogStaleError);
  check('版本未变', (await getCatalogVersion()) === vBefore);
  check('原档案仍在且编号未改', (await db.samples.get(id1Current!.id))?.sampleNo === 'GB-MET-000201');
  check('被撞档案完好', (await db.samples.get(id2Current!.id))?.sampleNo === 'GB-MET-000002');

  console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
