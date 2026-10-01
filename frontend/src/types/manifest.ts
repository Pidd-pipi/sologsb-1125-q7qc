import type { MeteoriteSample } from './sample';

/** 导出清单状态 */
export type ManifestStatus = 'draft' | 'sent';

/**
 * 导出清单条目（ExportManifestItem）。
 * 导出时刻冻结的样本号：换号后清单仍显示导出当时编号，
 * 与样本当前档案通过 sampleId 关联（换号时 sampleId 跟随新档案）。
 */
export interface ExportManifestItem {
  /** 导出清单内序号 */
  lineNo: number;
  /** 关联样本（换号后为新档案 id） */
  sampleId: string;
  /** 导出当时冻结的样本编号（不随后续换号改写） */
  sampleNoAtExport: string;
  /** 导出时重量 g */
  totalWeightAtExport: number;
}

/** 导出清单（ExportManifest） */
export interface ExportManifest {
  id: string;
  /** 清单名称，如「2026-Q3 馆际交换清单」 */
  name: string;
  items: ExportManifestItem[];
  status: ManifestStatus;
  createdAt: number;
  sentAt?: number;
}

/** 构造导出条目：在导出时刻冻结编号与重量 */
export function buildManifestItems(
  samples: MeteoriteSample[],
  sampleIds: string[],
): ExportManifestItem[] {
  const byId = new Map(samples.map((s) => [s.id, s]));
  return sampleIds
    .map((id, idx) => {
      const s = byId.get(id);
      if (!s) return null;
      return {
        lineNo: idx + 1,
        sampleId: s.id,
        sampleNoAtExport: s.sampleNo,
        totalWeightAtExport: s.totalWeight,
      } satisfies ExportManifestItem;
    })
    .filter((x): x is ExportManifestItem => x !== null);
}
