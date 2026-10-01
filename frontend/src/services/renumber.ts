import type { MeteoriteDB } from '../db';
import { BATCH_REVISION_KEY } from '../db';
import type { AnalysisRecord } from '../types/analysis';
import type { FindRecord } from '../types/find';
import type { MeteoriteSample } from '../types/sample';
import { GB_MET_PREFIX, generateGbMetNo, isGbMetNo } from '../types/sample';
import type { ThinSection } from '../types/section';
import type { ExportSnapshot } from '../types/snapshot';

/** 换号计划中的一条：某样本的旧号 → 新号 */
export interface RenumberPlanItem {
  sampleId: string;
  oldNo: string;
  newNo: string;
}

/** 受换号影响的引用记录（发现地 / 切片 / 检测） */
export interface AffectedRef {
  id: string;
  sampleId: string;
  oldNo: string;
  newNo: string;
  kind: 'find' | 'section' | 'analysis';
  label: string;
}

/** 受换号影响的导出清单（快照将保持当时编号不变） */
export interface SnapshotRef {
  id: string;
  label: string;
  createdAt: number;
  /** 冻结编号中属于本批换号样本的条数 */
  frozenCount: number;
}

export type RenumberErrorKind = 'collision' | 'missing-relation';

export interface RenumberError {
  kind: RenumberErrorKind;
  message: string;
}

/** 整批换号预览 */
export interface RenumberPreview {
  /** 预览所依据的批次版本号 */
  baseRevision: number;
  /** 换号计划（旧号 → 新号） */
  plan: RenumberPlanItem[];
  /** 受影响样本（= 计划） */
  affectedSamples: RenumberPlanItem[];
  /** 受影响的引用记录 */
  affectedRefs: AffectedRef[];
  /** 受影响的导出清单 */
  affectedSnapshots: SnapshotRef[];
  /** 阻断性错误：存在时整批不改 */
  errors: RenumberError[];
}

/** 并发提交冲突：批次已被其他会话修改，需重新预览 */
export class RenumberConflictError extends Error {
  constructor() {
    super('批次已被其他会话修改，请重新预览后再提交');
    this.name = 'RenumberConflictError';
  }
}

/** 读取当前批次版本号 */
export async function getBatchRevision(db: MeteoriteDB): Promise<number> {
  const row = await db.meta.get(BATCH_REVISION_KEY);
  return row && typeof row.value === 'number' ? row.value : 0;
}

/** 从编号中解析 GB-MET 序号 */
function parseGbMetSeq(no: string): number | null {
  const m = no.match(new RegExp(`^${GB_MET_PREFIX}\\d{4}-(\\d{3,})$`));
  return m ? Number(m[1]) : null;
}

/**
 * 生成整批换号预览：列出受影响的样本、发现地、切片、检测记录与导出清单，
 * 并做新号撞车与关系缺失校验。存在阻断性错误时 errors 非空，调用方不得提交。
 */
export async function previewRenumber(db: MeteoriteDB): Promise<RenumberPreview> {
  const [samples, finds, sections, analysis, snapshots, baseRevision] = await Promise.all([
    db.samples.toArray(),
    db.finds.toArray(),
    db.sections.toArray(),
    db.analysis.toArray(),
    db.snapshots.toArray(),
    getBatchRevision(db),
  ]);

  const errors: RenumberError[] = [];
  const sampleIds = new Set(samples.map((s) => s.id));

  // —— 关系缺失校验：发现地 / 切片 / 检测记录不得指向不存在的样本或切片 ——
  for (const f of finds) {
    if (!sampleIds.has(f.sampleId)) {
      errors.push({
        kind: 'missing-relation',
        message: `发现地「${f.placeName || f.id}」关联的样本不存在（sampleId=${f.sampleId}）`,
      });
    }
  }
  for (const sec of sections) {
    if (!sampleIds.has(sec.sampleId)) {
      errors.push({
        kind: 'missing-relation',
        message: `切片「${sec.sectionNo}」关联的样本不存在（sampleId=${sec.sampleId}）`,
      });
    }
  }
  const sectionIds = new Set(sections.map((s) => s.id));
  for (const a of analysis) {
    if (!sampleIds.has(a.sampleId)) {
      errors.push({
        kind: 'missing-relation',
        message: `检测记录（${a.method} ${a.testedAt}）关联的样本不存在（sampleId=${a.sampleId}）`,
      });
    }
    if (a.target === 'section' && (!a.sectionId || !sectionIds.has(a.sectionId))) {
      errors.push({
        kind: 'missing-relation',
        message: `检测记录（对象=切片）关联的切片不存在（sectionId=${a.sectionId ?? '空'}）`,
      });
    }
  }

  // —— 制定换号计划：非 GB-MET 编号的样本依次分配 GB-MET 新号 ——
  const plan: RenumberPlanItem[] = [];
  const year = new Date().getFullYear();

  // 已被占用的 GB-MET 序号（现用号 + 别名）
  const usedSeqs = new Set<number>();
  for (const s of samples) {
    const seq = parseGbMetSeq(s.sampleNo);
    if (seq !== null) usedSeqs.add(seq);
    for (const alias of s.aliases ?? []) {
      const aliasSeq = parseGbMetSeq(alias);
      if (aliasSeq !== null) usedSeqs.add(aliasSeq);
    }
  }
  let nextSeq = usedSeqs.size ? Math.max(...usedSeqs) + 1 : 1;

  // 按登记顺序分配，保证结果确定
  const sorted = [...samples].sort((a, b) => a.createdAt - b.createdAt);
  for (const s of sorted) {
    if (isGbMetNo(s.sampleNo)) continue;
    plan.push({ sampleId: s.id, oldNo: s.sampleNo, newNo: generateGbMetNo(year, nextSeq++) });
  }

  // —— 撞车校验：新号不得重复、不得占用他人现用号/别名；旧号须唯一 ——
  const allNos = new Map<string, string>(); // 编号 -> 持有它的样本 id
  for (const s of samples) {
    allNos.set(s.sampleNo, s.id);
    for (const alias of s.aliases ?? []) allNos.set(alias, s.id);
  }
  const newNoCount = new Map<string, number>();
  const oldNoCount = new Map<string, number>();
  for (const p of plan) {
    newNoCount.set(p.newNo, (newNoCount.get(p.newNo) ?? 0) + 1);
    oldNoCount.set(p.oldNo, (oldNoCount.get(p.oldNo) ?? 0) + 1);
  }
  for (const p of plan) {
    if ((newNoCount.get(p.newNo) ?? 0) > 1) {
      errors.push({ kind: 'collision', message: `新号 ${p.newNo} 在本批计划中重复分配` });
    }
    const owner = allNos.get(p.newNo);
    if (owner && owner !== p.sampleId) {
      errors.push({ kind: 'collision', message: `新号 ${p.newNo} 已被其他样本占用` });
    }
    const oldOwner = allNos.get(p.oldNo);
    if (oldOwner && oldOwner !== p.sampleId) {
      errors.push({ kind: 'collision', message: `旧号 ${p.oldNo} 已被其他样本占用，不能作为唯一别名` });
    }
    if ((oldNoCount.get(p.oldNo) ?? 0) > 1) {
      errors.push({ kind: 'collision', message: `旧号 ${p.oldNo} 在本批中重复，别名无法唯一` });
    }
  }

  // —— 受影响的引用记录 ——
  const planBySample = new Map(plan.map((p) => [p.sampleId, p]));
  const affectedRefs: AffectedRef[] = [];
  for (const f of finds) {
    const p = planBySample.get(f.sampleId);
    if (p) {
      affectedRefs.push({
        id: f.id,
        sampleId: f.sampleId,
        oldNo: p.oldNo,
        newNo: p.newNo,
        kind: 'find',
        label: f.placeName || f.region || f.id,
      });
    }
  }
  for (const sec of sections) {
    const p = planBySample.get(sec.sampleId);
    if (p) {
      affectedRefs.push({
        id: sec.id,
        sampleId: sec.sampleId,
        oldNo: p.oldNo,
        newNo: p.newNo,
        kind: 'section',
        label: sec.sectionNo,
      });
    }
  }
  for (const a of analysis) {
    const p = planBySample.get(a.sampleId);
    if (p) {
      affectedRefs.push({
        id: a.id,
        sampleId: a.sampleId,
        oldNo: p.oldNo,
        newNo: p.newNo,
        kind: 'analysis',
        label: `${a.method} · ${a.testedAt}`,
      });
    }
  }

  // —— 受影响的导出清单（快照保持当时编号，不随换号改变） ——
  const affectedSnapshots: SnapshotRef[] = [];
  for (const snap of snapshots) {
    const frozenCount = snap.items.filter((it) => planBySample.has(it.sampleId)).length;
    if (frozenCount > 0) {
      affectedSnapshots.push({
        id: snap.id,
        label: snap.label,
        createdAt: snap.createdAt,
        frozenCount,
      });
    }
  }

  return {
    baseRevision,
    plan,
    affectedSamples: plan,
    affectedRefs,
    affectedSnapshots,
    errors,
  };
}

/**
 * 提交整批换号：在一个事务内重新读取批次版本并重新校验计划，
 * 版本不符或计划已变则抛 RenumberConflictError，由调用方重新预览。
 * 成功后旧号留为样本唯一别名，样本启用 GB-MET 新号，批次版本自增。
 */
export async function commitRenumber(
  db: MeteoriteDB,
  preview: RenumberPreview,
): Promise<number> {
  return await db.transaction(
    'rw',
    [db.samples, db.finds, db.sections, db.analysis, db.snapshots, db.meta],
    async () => {
      const currentRevision = await getBatchRevision(db);
      if (currentRevision !== preview.baseRevision) {
        throw new RenumberConflictError();
      }

      // 事务内重新预览，核对计划与阻断项
      const fresh = await previewRenumber(db);
      if (fresh.errors.length) {
        throw new Error('数据已变化，重新预览后存在阻断项，已取消本次整批换号');
      }
      const samePlan =
        fresh.plan.length === preview.plan.length &&
        fresh.plan.every(
          (p, i) =>
            p.sampleId === preview.plan[i].sampleId &&
            p.oldNo === preview.plan[i].oldNo &&
            p.newNo === preview.plan[i].newNo,
        );
      if (!samePlan) {
        throw new RenumberConflictError();
      }

      const now = Date.now();
      for (const p of preview.plan) {
        const sample = await db.samples.get(p.sampleId);
        if (!sample) continue;
        const aliases = Array.from(new Set([...(sample.aliases ?? []), p.oldNo]));
        await db.samples.update(p.sampleId, {
          sampleNo: p.newNo,
          aliases,
          updatedAt: now,
        });
      }

      const nextRevision = currentRevision + 1;
      await db.meta.put({ key: BATCH_REVISION_KEY, value: nextRevision });
      return nextRevision;
    },
  );
}

/** 引用记录类型的中文标签 */
export const REF_KIND_LABELS: Record<AffectedRef['kind'], string> = {
  find: '发现地',
  section: '切片',
  analysis: '检测记录',
};

/** 重新导出类型，供页面引用 */
export type { MeteoriteSample, FindRecord, ThinSection, AnalysisRecord, ExportSnapshot };
