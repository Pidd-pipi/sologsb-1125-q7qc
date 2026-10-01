import { bumpCatalogVersion, db, getCatalogVersion, makeId } from '../db';
import type { AnalysisRecord } from '../types/analysis';
import type { ExportManifest } from '../types/manifest';
import type { FindRecord } from '../types/find';
import type { HistorySnapshot, SampleSnapshot } from '../types/snapshot';
import type { MeteoriteSample } from '../types/sample';
import type { ThinSection } from '../types/section';
import {
  CatalogStaleError,
  GB_MET_NO_PATTERN,
  type ImpactedRefs,
  type RenumberBatch,
  type RenumberEntry,
  type RenumberIssue,
  type RenumberPreview,
  type RenumberPreviewItem,
} from '../types/renumber';

/** 一次预检所需的库内快照 */
interface CatalogBundle {
  catalogVersion: number;
  samples: MeteoriteSample[];
  finds: FindRecord[];
  sections: ThinSection[];
  analysis: AnalysisRecord[];
  manifests: ExportManifest[];
}

async function loadBundle(): Promise<CatalogBundle> {
  const [catalogVersion, samples, finds, sections, analysis, manifests] = await Promise.all([
    getCatalogVersion(),
    db.samples.toArray(),
    db.finds.toArray(),
    db.sections.toArray(),
    db.analysis.toArray(),
    db.exportManifests.toArray(),
  ]);
  return { catalogVersion, samples, finds, sections, analysis, manifests };
}

const normalize = (no: string) => no.trim().toUpperCase();

/** 受影响样本现状指纹：编号/别名/重量/更新时间 + 关联行数，任一变化都使旧预览失效 */
export function computeFingerprint(bundle: CatalogBundle, sampleIds: string[]): string {
  const ids = new Set(sampleIds);
  const samples = bundle.samples
    .filter((s) => ids.has(s.id))
    .map((s) => ({
      id: s.id,
      no: s.sampleNo,
      aliases: s.aliases ?? [],
      weight: s.totalWeight,
      updatedAt: s.updatedAt,
      finds: bundle.finds.filter((f) => f.sampleId === s.id).map((f) => f.id),
      sections: bundle.sections.filter((x) => x.sampleId === s.id).map((x) => x.id),
      analysis: bundle.analysis.filter((a) => a.sampleId === s.id).map((a) => a.id),
      manifests: bundle.manifests
        .filter((m) => m.items.some((it) => it.sampleId === s.id))
        .map((m) => `${m.id}:${m.status}:${m.items.filter((it) => it.sampleId === s.id).length}`),
    }));
  return JSON.stringify({ v: bundle.catalogVersion, samples });
}

function emptyRefs(): ImpactedRefs {
  return { finds: [], sections: [], analysis: [], manifests: [] };
}

/**
 * 整批换号预检（只读，不落库、不改任何数据）。
 * 列出样本、发现地、切片、检测记录、导出清单五类受影响条目，
 * 并汇总所有阻断问题（新号撞车 / 关系缺失等）。
 */
export async function previewRenumber(rawEntries: RenumberEntry[]): Promise<RenumberPreview> {
  const bundle = await loadBundle();
  return buildPreview(bundle, rawEntries);
}

function buildPreview(bundle: CatalogBundle, rawEntries: RenumberEntry[]): RenumberPreview {
  const byId = new Map(bundle.samples.map((s) => [s.id, s]));

  // 全库现用号 + 别名占用表（归一化大写比较）
  const occupiedNo = new Map<string, string>(); // 编号 -> 样本 id
  const aliasOwners = new Map<string, string[]>(); // 别名 -> 持有该别名的样本 id 列表
  bundle.samples.forEach((s) => {
    occupiedNo.set(normalize(s.sampleNo), s.id);
    (s.aliases ?? []).forEach((a) => {
      const key = normalize(a);
      if (!key) return;
      const list = aliasOwners.get(key) ?? [];
      list.push(s.id);
      aliasOwners.set(key, list);
    });
  });

  // 批内新号自查（同一批撞车）
  const batchNewNos = new Map<string, number>();
  rawEntries.forEach((e) => {
    const key = normalize(e.newSampleNo);
    if (key) batchNewNos.set(key, (batchNewNos.get(key) ?? 0) + 1);
  });

  // 批内旧号集合：新号撞上本批另一条目的当前编号也要拦（他条目换号后旧号才转为别名）
  const batchOldIdsByNo = new Map<string, string>();
  rawEntries.forEach((e) => {
    const owner = byId.get(e.sampleId);
    if (owner) batchOldIdsByNo.set(normalize(owner.sampleNo), e.sampleId);
  });

  const items: RenumberPreviewItem[] = rawEntries.map((entry) => {
    const issues: RenumberIssue[] = [];
    const refs = emptyRefs();
    const sample = byId.get(entry.sampleId);

    if (!sample) {
      issues.push({
        code: 'sample-missing',
        message: `旧档案 ${entry.oldSampleNo}（${entry.sampleId}）已不存在，无法换号`,
        refId: entry.sampleId,
      });
      return { ...entry, aliases: [], issues, refs };
    }

    if (sample.sampleNo !== entry.oldSampleNo) {
      issues.push({
        code: 'sample-changed',
        message: `${entry.oldSampleNo} 当前编号已是 ${sample.sampleNo}，预检基于过期数据，请重新选择`,
        refId: sample.id,
      });
    }

    const newNo = entry.newSampleNo.trim();
    if (!newNo) {
      issues.push({ code: 'new-no-empty', message: `${entry.oldSampleNo} 的新编号为空`, refId: sample.id });
    } else if (!GB_MET_NO_PATTERN.test(newNo)) {
      issues.push({
        code: 'new-no-format',
        message: `新编号「${newNo}」不符合 GB-MET-<至少4位数字> 格式`,
        refId: sample.id,
      });
    } else {
      const newKey = normalize(newNo);
      if ((batchNewNos.get(newKey) ?? 0) > 1) {
        issues.push({
          code: 'new-no-duplicate-in-batch',
          message: `新编号 ${newNo} 在本批中被重复使用`,
          refId: sample.id,
        });
      }
      // 新号与自身当前编号相同：无意义换号
      if (newKey === normalize(sample.sampleNo)) {
        issues.push({
          code: 'new-no-collision',
          message: `新编号 ${newNo} 与当前编号相同，无需换号`,
          refId: sample.id,
        });
      }
      // 新号撞批外档案现用号
      const ownerId = occupiedNo.get(newKey);
      if (ownerId && ownerId !== sample.id && !batchOldIdsByNo.has(newKey)) {
        issues.push({
          code: 'new-no-collision',
          message: `新编号 ${newNo} 已被现有样本 ${byId.get(ownerId)?.sampleNo ?? ownerId} 占用`,
          refId: sample.id,
        });
      }
      // 新号撞本批另一条目的当前编号（他的旧号在本批提交后才转为别名，不能提前占用）
      const batchOldOwner = batchOldIdsByNo.get(newKey);
      if (batchOldOwner && batchOldOwner !== sample.id) {
        const other = byId.get(batchOldOwner);
        issues.push({
          code: 'new-no-collision',
          message: `新编号 ${newNo} 是本批另一份样本 ${other?.sampleNo ?? batchOldOwner} 的当前编号，旧号只能留作唯一别名`,
          refId: sample.id,
        });
      }
      // 新号撞上任何一份档案的旧别名（旧号必须唯一，不能再次启用）
      const aliasHolders = (aliasOwners.get(newKey) ?? []).filter((id) => id !== sample.id);
      if (aliasHolders.length > 0) {
        issues.push({
          code: 'alias-collision',
          message: `新编号 ${newNo} 曾是 ${aliasHolders
            .map((id) => byId.get(id)?.sampleNo ?? id)
            .join('、')} 的旧编号，旧号唯一保留、不可复用`,
          refId: sample.id,
        });
      }
    }

    // 旧号唯一性预检：旧号若已作为别的样本别名存在，提交后会破坏唯一别名
    const oldKey = normalize(sample.sampleNo);
    const oldAliasHolders = (aliasOwners.get(oldKey) ?? []).filter((id) => id !== sample.id);
    if (oldAliasHolders.length > 0) {
      issues.push({
        code: 'alias-collision',
        message: `旧编号 ${sample.sampleNo} 已被 ${oldAliasHolders
          .map((id) => byId.get(id)?.sampleNo ?? id)
          .join('、')} 留作别名，旧号必须唯一`,
        refId: sample.id,
      });
    }

    // —— 受影响的关联条目（预览清单）；同时检查关系缺失 ——
    bundle.finds
      .filter((f) => f.sampleId === sample.id)
      .forEach((f) => refs.finds.push({ id: f.id, placeName: f.placeName, region: f.region }));

    const mySections = bundle.sections.filter((x) => x.sampleId === sample.id);
    mySections.forEach((x) => refs.sections.push({ id: x.id, sectionNo: x.sectionNo }));

    bundle.analysis
      .filter((a) => a.sampleId === sample.id)
      .forEach((a) => {
        refs.analysis.push({ id: a.id, method: a.method, testedAt: a.testedAt });
        if (a.target === 'section') {
          if (!a.sectionId) {
            issues.push({
              code: 'analysis-target-missing',
              message: `检测记录 ${a.testedAt}（${a.method}）声明检测切片但未关联切片`,
              refId: a.id,
            });
          } else if (!bundle.sections.some((x) => x.id === a.sectionId)) {
            issues.push({
              code: 'analysis-target-missing',
              message: `检测记录 ${a.testedAt}（${a.method}）指向的切片 ${a.sectionId} 不存在`,
              refId: a.id,
            });
          } else if (!mySections.some((x) => x.id === a.sectionId)) {
            issues.push({
              code: 'analysis-target-missing',
              message: `检测记录 ${a.testedAt}（${a.method}）指向的切片不属于 ${sample.sampleNo}，关系不一致`,
              refId: a.id,
            });
          }
        }
      });

    // 切片 → 样本的反向关系缺失（孤立切片理论上 sampleId 索引必在；防御性检查同批外的孤立记录）
    // 这里只列出本样本切片，全局孤立切片在整批级别再扫一遍。

    bundle.manifests.forEach((m) => {
      m.items
        .filter((it) => it.sampleId === sample.id)
        .forEach((it) =>
          refs.manifests.push({ id: m.id, name: m.name, lineNo: it.lineNo, frozenNo: it.sampleNoAtExport }),
        );
    });

    return { ...entry, aliases: sample.aliases ?? [], issues, refs };
  });

  // 整批级别关系缺失扫描：任何指向本批样本的关联行若找不到对应档案（脏数据）即阻断
  const batchIds = new Set(rawEntries.map((e) => e.sampleId));
  bundle.sections.forEach((x) => {
    if (batchIds.has(x.sampleId) && !byId.has(x.sampleId)) {
      items
        .find((it) => it.sampleId === x.sampleId)
        ?.issues.push({
          code: 'section-target-missing',
          message: `切片 ${x.sectionNo} 关联的样本档案缺失`,
          refId: x.id,
        });
    }
  });
  bundle.analysis.forEach((a) => {
    if (batchIds.has(a.sampleId) && !byId.has(a.sampleId)) {
      items
        .find((it) => it.sampleId === a.sampleId)
        ?.issues.push({
          code: 'analysis-target-missing',
          message: `检测记录 ${a.testedAt} 关联的样本档案缺失`,
          refId: a.id,
        });
    }
  });

  const issues = items.flatMap((it) => it.issues);
  return {
    entries: items,
    issues,
    catalogVersion: bundle.catalogVersion,
    fingerprint: computeFingerprint(bundle, rawEntries.map((e) => e.sampleId)),
    generatedAt: Date.now(),
  };
}

export interface CommitRenumberResult {
  batch: RenumberBatch;
  snapshot: HistorySnapshot;
}

/**
 * 提交整批换号（单事务、原子：任一校验不过则整批不改）。
 *
 * 并发规则：
 *  1. catalogVersion 必须等于预检时版本（另一会话先提交会 bump）；
 *  2. 受影响样本指纹必须与预检一致（防止版本相同但内容被改的边缘情况）；
 *  3. 事务内重跑全部预检校验，撞车/关系缺失仍可能在最后一刻出现时整体回滚。
 * 失败抛 CatalogStaleError，调用方需重新预览。
 */
export async function commitRenumber(
  preview: RenumberPreview,
  reason: string,
): Promise<CommitRenumberResult> {
  const entriesInput: RenumberEntry[] = preview.entries.map((e) => ({
    sampleId: e.sampleId,
    oldSampleNo: e.oldSampleNo,
    newSampleNo: e.newSampleNo,
  }));

  return db.transaction(
    'rw',
    [
      db.meta,
      db.samples,
      db.finds,
      db.sections,
      db.analysis,
      db.exportManifests,
      db.historySnapshots,
      db.renumberBatches,
    ],
    async (tx) => {
      // 1) 版本闸门：另一会话已改动档案 → 本批过期
      const meta = await db.meta.get('catalog');
      const currentVersion = meta?.catalogVersion ?? 1;
      if (currentVersion !== preview.catalogVersion) {
        throw new CatalogStaleError(
          `档案版本已从 v${preview.catalogVersion} 变为 v${currentVersion}，批次已被改动，请重新预览后再提交`,
        );
      }

      // 2) 事务内重取数据并重跑预检
      const fresh: CatalogBundle = {
        catalogVersion: currentVersion,
        samples: await db.samples.toArray(),
        finds: await db.finds.toArray(),
        sections: await db.sections.toArray(),
        analysis: await db.analysis.toArray(),
        manifests: await db.exportManifests.toArray(),
      };
      const recheck = buildPreview(fresh, entriesInput);
      if (recheck.issues.length > 0) {
        // 区分「过期」与「硬性撞车/关系缺失」：内容变化一律引导重新预览
        throw new CatalogStaleError(
          `预检条件已不成立（${recheck.issues.length} 项问题），整批未改动，请重新预览：${recheck.issues[0].message}`,
        );
      }
      const freshFingerprint = computeFingerprint(
        fresh,
        entriesInput.map((e) => e.sampleId),
      );
      if (freshFingerprint !== preview.fingerprint) {
        throw new CatalogStaleError('受影响样本在预览后发生变化，请重新预览后再提交（整批未改动）');
      }

      const now = Date.now();
      const batchId = makeId('renumber');
      const snapshotSamples: SampleSnapshot[] = [];
      const idMap: Record<string, string> = {};
      const batchEntries: RenumberBatch['entries'] = [];

      for (const entry of entriesInput) {
        const old = fresh.samples.find((s) => s.id === entry.sampleId);
        if (!old) throw new CatalogStaleError(`样本 ${entry.oldSampleNo} 已不存在，请重新预览`);
        const newId = makeId('sample');
        idMap[old.id] = newId;

        // 历史快照：冻结旧档案及其全部关联（显示当时编号）
        snapshotSamples.push({
          sample: structuredClone(old),
          find: structuredClone(fresh.finds.find((f) => f.sampleId === old.id) ?? null),
          sections: structuredClone(fresh.sections.filter((x) => x.sampleId === old.id)),
          analysis: structuredClone(fresh.analysis.filter((a) => a.sampleId === old.id)),
        });

        // 新档案：继承全部属性；旧号并入别名。当前编号若已在历史别名里（二次换号）先去重，
        // 保证旧号在全库中只作为唯一条目出现一次。
        const aliases = Array.from(
          new Set(
            [...(old.aliases ?? []).map((a) => a.trim()).filter(Boolean), old.sampleNo],
          ),
        );
        const next: MeteoriteSample = {
          ...structuredClone(old),
          id: newId,
          sampleNo: entry.newSampleNo.trim(),
          aliases,
          updatedAt: now,
        };
        await db.samples.add(next);
        await db.samples.delete(old.id);

        // 所有引用一起指向新档案
        await db.finds.where('sampleId').equals(old.id).modify({ sampleId: newId });
        await db.sections.where('sampleId').equals(old.id).modify({ sampleId: newId });
        await db.analysis.where('sampleId').equals(old.id).modify({ sampleId: newId });

        batchEntries.push({
          oldSampleId: old.id,
          newSampleId: newId,
          oldSampleNo: old.sampleNo,
          newSampleNo: entry.newSampleNo.trim(),
        });
      }

      // 导出清单：每份清单只重写一次，按本批完整 idMap 把条目引用全部指向新档案；
      // 导出时刻冻结的编号 sampleNoAtExport 保持不变（历史快照语义）。
      const batchOldIds = new Set(Object.keys(idMap));
      const touchedManifests = fresh.manifests.filter((m) =>
        m.items.some((it) => batchOldIds.has(it.sampleId)),
      );
      for (const m of touchedManifests) {
        const items = m.items.map((it) =>
          batchOldIds.has(it.sampleId) ? { ...it, sampleId: idMap[it.sampleId] } : it,
        );
        await db.exportManifests.update(m.id, { items });
      }

      const nextVersion = await bumpCatalogVersion(tx);

      const snapshot: HistorySnapshot = {
        id: makeId('snapshot'),
        batchId,
        reason,
        createdAt: now,
        samples: snapshotSamples,
        idMap,
      };
      await db.historySnapshots.add(snapshot);

      const batch: RenumberBatch = {
        id: batchId,
        reason,
        entries: batchEntries,
        baseCatalogVersion: preview.catalogVersion,
        nextCatalogVersion: nextVersion,
        createdAt: now,
      };
      await db.renumberBatches.add(batch);

      return { batch, snapshot };
    },
  );
}
