/** 陨石分类：球粒陨石 / 铁陨石 / 石铁陨石 / 无球粒陨石 */
export type SampleCategory = 'chondrite' | 'iron' | 'stony-iron' | 'achondrite';

/** 化学群：普通球粒 H/L/LL 与铁陨石 IAB；未知时用 ungrouped */
export type ChemicalGroup = 'H' | 'L' | 'LL' | 'IAB' | 'ungrouped';

/** 风化等级 W0（新鲜）→ W4（严重风化） */
export type WeatheringGrade = 'W0' | 'W1' | 'W2' | 'W3' | 'W4';

/** 发现或坠落标记 */
export type FallOrFind = 'fall' | 'find';

/** 存放位置 */
export type StorageLocation = 'cabinet-a' | 'cabinet-b' | 'desiccator' | 'loan-out';

/** 陨石样本（MeteoriteSample） */
export interface MeteoriteSample {
  id: string;
  /** 样本编号，现行体系为 GB-MET-<年>-<三位序号>；换号前的旧号见 aliases */
  sampleNo: string;
  /** 别名（曾用编号）：整批换号前的旧号留作唯一别名，可继续被检索 */
  aliases?: string[];
  /** 总重量，单位 g */
  totalWeight: number;
  category: SampleCategory;
  chemicalGroup: ChemicalGroup;
  weathering: WeatheringGrade;
  fallOrFind: FallOrFind;
  storage: StorageLocation;
  /** 备注（可选） */
  note?: string;
  createdAt: number;
  /** v3 升级迁移新增字段 */
  updatedAt: number;
}

export const CATEGORY_LABELS: Record<SampleCategory, string> = {
  chondrite: '球粒陨石',
  iron: '铁陨石',
  'stony-iron': '石铁陨石',
  achondrite: '无球粒陨石',
};

export const CHEMICAL_GROUP_LABELS: Record<ChemicalGroup, string> = {
  H: 'H（高铁）',
  L: 'L（低铁）',
  LL: 'LL（低铁低金属）',
  IAB: 'IAB（铁陨石群）',
  ungrouped: '未分群',
};

export const WEATHERING_LABELS: Record<WeatheringGrade, string> = {
  W0: 'W0 新鲜',
  W1: 'W1 轻微',
  W2: 'W2 中等',
  W3: 'W3 明显',
  W4: 'W4 严重',
};

export const FALL_OR_FIND_LABELS: Record<FallOrFind, string> = {
  fall: '目击坠落',
  find: '发现',
};

export const STORAGE_LABELS: Record<StorageLocation, string> = {
  'cabinet-a': 'A 柜 · 干燥剂箱',
  'cabinet-b': 'B 柜 · 常温架',
  desiccator: '真空干燥器',
  'loan-out': '外借中',
};

export const SAMPLE_CATEGORIES: SampleCategory[] = ['chondrite', 'iron', 'stony-iron', 'achondrite'];
export const CHEMICAL_GROUPS: ChemicalGroup[] = ['H', 'L', 'LL', 'IAB', 'ungrouped'];
export const WEATHERING_GRADES: WeatheringGrade[] = ['W0', 'W1', 'W2', 'W3', 'W4'];
export const FALL_OR_FINDS: FallOrFind[] = ['fall', 'find'];
export const STORAGE_LOCATIONS: StorageLocation[] = ['cabinet-a', 'cabinet-b', 'desiccator', 'loan-out'];

/** 分类建议结果 */
export interface ClassificationAdvice {
  category: SampleCategory;
  confidence: 'high' | 'medium' | 'low';
  summary: string;
  hits: string[];
}

/** 样本编号生成：MET-<年>-<三位序号> */
export function generateSampleNo(year: number, seq: number): string {
  return `MET-${year}-${String(seq).padStart(3, '0')}`;
}

/** GB-MET 整批换号后的新编号前缀 */
export const GB_MET_PREFIX = 'GB-MET-';

/** 判断编号是否已是 GB-MET 体系 */
export function isGbMetNo(no: string): boolean {
  return new RegExp(`^${GB_MET_PREFIX}\\d{4}-\\d{3,}$`).test(no);
}

/** 生成 GB-MET 编号：GB-MET-<年>-<三位序号> */
export function generateGbMetNo(year: number, seq: number): string {
  return `${GB_MET_PREFIX}${year}-${String(seq).padStart(3, '0')}`;
}
