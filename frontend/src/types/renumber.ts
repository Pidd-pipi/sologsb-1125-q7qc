/** 整批换号（并入 GB-MET 编号体系）领域模型 */

/** 单条换号映射：旧档案 → 新 GB-MET 编号 */
export interface RenumberEntry {
  /** 旧样本档案 id（提交后该档案删除，由新档案接替） */
  sampleId: string;
  /** 预检时锁定的旧编号；提交时会与库内现值再比对 */
  oldSampleNo: string;
  /** 新 GB-MET 编号，如 GB-MET-000123 */
  newSampleNo: string;
}

/** 预检问题分类 */
export type RenumberIssueCode =
  | 'sample-missing'
  | 'sample-changed'
  | 'new-no-empty'
  | 'new-no-format'
  | 'new-no-duplicate-in-batch'
  | 'new-no-collision'
  | 'alias-collision'
  | 'section-target-missing'
  | 'analysis-target-missing';

/** 预检发现的问题：命中任一阻断类问题时整批不可提交、整批不改 */
export interface RenumberIssue {
  code: RenumberIssueCode;
  message: string;
  /** 关联条目（样本 / 切片 / 检测记录 id），便于定位 */
  refId?: string;
}

/** 受影响的关联条目计数与明细（预览用） */
export interface ImpactedRefs {
  finds: { id: string; placeName: string; region: string }[];
  sections: { id: string; sectionNo: string }[];
  analysis: { id: string; method: string; testedAt: string }[];
  manifests: { id: string; name: string; lineNo: number; frozenNo: string }[];
}

/** 单条映射的预检视图 */
export interface RenumberPreviewItem extends RenumberEntry {
  aliases: string[];
  issues: RenumberIssue[];
  refs: ImpactedRefs;
}

/**
 * 一次批次预览（不落库）。
 * catalogVersion / fingerprint 是乐观并发凭据：
 * 提交时必须与库内现状一致，否则判定批次已被他人改动，需重新预览。
 */
export interface RenumberPreview {
  entries: RenumberPreviewItem[];
  issues: RenumberIssue[];
  /** 预检时刻档案版本 */
  catalogVersion: number;
  /** 受影响样本现状指纹（编号 + 别名 + 关联行数与更新时间） */
  fingerprint: string;
  generatedAt: number;
}

/** 换号批次落库记录 */
export interface RenumberBatch {
  id: string;
  reason: string;
  entries: {
    oldSampleId: string;
    newSampleId: string;
    oldSampleNo: string;
    newSampleNo: string;
  }[];
  /** 提交前档案版本 */
  baseCatalogVersion: number;
  /** 提交后档案版本 */
  nextCatalogVersion: number;
  createdAt: number;
}

/** 批次提交冲突：档案已被另一会话改动 */
export class CatalogStaleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CatalogStaleError';
  }
}

/** GB-MET 新编号格式：GB-MET- + 至少 4 位数字（允许更长） */
export const GB_MET_NO_PATTERN = /^GB-MET-\d{4,}$/;

/** 判断一个编号是否为 GB-MET 体系编号 */
export function isGbMetNo(no: string): boolean {
  return GB_MET_NO_PATTERN.test(no.trim());
}

/** 生成下一个建议新号：GB-MET-<6 位序号>，跳过现用号与别名 */
export function suggestGbMetNo(existingNos: string[], seq: number): string {
  const used = new Set(existingNos.map((n) => n.trim().toUpperCase()));
  let n = seq;
  let candidate = `GB-MET-${String(n).padStart(6, '0')}`;
  while (used.has(candidate)) {
    n += 1;
    candidate = `GB-MET-${String(n).padStart(6, '0')}`;
  }
  return candidate;
}
