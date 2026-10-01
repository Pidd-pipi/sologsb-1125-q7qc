import type { AnalysisRecord } from './analysis';
import type { FindRecord } from './find';
import type { MeteoriteSample } from './sample';
import type { ThinSection } from './section';

/** 单份样本换号时刻的冻结副本 */
export interface SampleSnapshot {
  sample: MeteoriteSample;
  find: FindRecord | null;
  sections: ThinSection[];
  analysis: AnalysisRecord[];
}

/**
 * 历史快照（HistorySnapshot）。
 * 不可变：换号提交时整批落一份，快照里的样本号永远是「当时编号」（旧号）。
 * 快照保存旧档案 id 与新档案 id 的对应，方便从当前档案回看。
 */
export interface HistorySnapshot {
  id: string;
  /** 产生该快照的换号批次 */
  batchId: string;
  reason: string;
  createdAt: number;
  samples: SampleSnapshot[];
  /** 旧档案 id → 新档案 id（本批内） */
  idMap: Record<string, string>;
}
