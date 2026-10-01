/** 导出清单项：导出时冻结当时的样本编号 */
export interface SnapshotItem {
  /** 关联样本 id */
  sampleId: string;
  /** 导出当时的样本编号（快照冻结，不随后续整批换号改变） */
  sampleNo: string;
}

/** 导出清单（历史快照）：整批换号后仍显示导出当时的编号 */
export interface ExportSnapshot {
  id: string;
  /** 清单名称 */
  label: string;
  /** 导出时间 */
  createdAt: number;
  /** 冻结的样本编号清单 */
  items: SnapshotItem[];
}

/** 由当前样本档案生成一份导出清单（冻结编号） */
export function buildSnapshotItems(samples: { id: string; sampleNo: string }[]): SnapshotItem[] {
  return samples.map((s) => ({ sampleId: s.id, sampleNo: s.sampleNo }));
}
