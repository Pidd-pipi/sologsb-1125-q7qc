import Dexie, { type Table, type Transaction } from 'dexie';
import type { ExportManifest } from '../types/manifest';
import type { MeteoriteSample } from '../types/sample';
import type { FindRecord } from '../types/find';
import type { HistorySnapshot } from '../types/snapshot';
import type { ThinSection } from '../types/section';
import type { AnalysisRecord } from '../types/analysis';
import type { RenumberBatch } from '../types/renumber';

/** 库名固定为 gbmeteorite-db */
export const DB_NAME = 'gbmeteorite-db';

/**
 * 档案库元信息（单行表，主键固定为 'catalog'）。
 * catalogVersion 为整库乐观版本：任何改动档案的写操作都会 +1，
 * 换号预检/提交用它判断「批次是否已被他人改动」。
 */
export interface CatalogMeta {
  id: 'catalog';
  catalogVersion: number;
  updatedAt: number;
}

export const META_ID = 'catalog' as const;

/**
 * 版本历史（IndexedDB 升级迁移）：
 *  - v1：建 samples / finds / sections 三张表
 *  - v2：新增 analysis 表，并为 analysis 加 sampleId 索引
 *  - v3：为 samples 补 updatedAt 字段，并按 id 回填旧记录
 *  - v4：标本馆并入，支持整批换号 GB-MET：
 *        samples 增加 aliases 多值索引（旧号唯一别名），
 *        新增 meta / exportManifests / historySnapshots / renumberBatches。
 */
export class MeteoriteDB extends Dexie {
  meta!: Table<CatalogMeta, string>;
  samples!: Table<MeteoriteSample, string>;
  finds!: Table<FindRecord, string>;
  sections!: Table<ThinSection, string>;
  analysis!: Table<AnalysisRecord, string>;
  exportManifests!: Table<ExportManifest, string>;
  historySnapshots!: Table<HistorySnapshot, string>;
  renumberBatches!: Table<RenumberBatch, string>;

  constructor() {
    super(DB_NAME);

    this.version(1).stores({
      samples: 'id, sampleNo, category, chemicalGroup, totalWeight, createdAt',
      finds: 'id, sampleId, region, createdAt',
      sections: 'id, sectionNo, sampleId, thickness, createdAt',
    });

    this.version(2)
      .stores({
        samples: 'id, sampleNo, category, chemicalGroup, totalWeight, createdAt',
        finds: 'id, sampleId, region, createdAt',
        sections: 'id, sectionNo, sampleId, thickness, createdAt',
        analysis: 'id, sampleId, sectionId, method, testedAt, createdAt',
      })
      .upgrade(async (tx) => {
        // v2：旧记录补齐新表所需字段，避免读取时 undefined
        await tx
          .table<AnalysisRecord, string>('analysis')
          .toCollection()
          .modify((rec) => {
            if (typeof rec.createdAt !== 'number') rec.createdAt = Date.now();
          });
      });

    this.version(3)
      .stores({
        samples:
          'id, sampleNo, category, chemicalGroup, totalWeight, createdAt, updatedAt',
        finds: 'id, sampleId, region, createdAt',
        sections: 'id, sectionNo, sampleId, thickness, createdAt',
        analysis: 'id, sampleId, sectionId, method, testedAt, createdAt',
      })
      .upgrade(async (tx) => {
        // v3：为样本表补 updatedAt，并按 id 回填旧记录
        await tx
          .table<MeteoriteSample, string>('samples')
          .toCollection()
          .modify((sample) => {
            if (typeof sample.updatedAt !== 'number') {
              sample.updatedAt =
                typeof sample.createdAt === 'number' ? sample.createdAt : Date.now();
            }
          });
      });

    this.version(4)
      .stores({
        samples:
          'id, sampleNo, category, chemicalGroup, totalWeight, createdAt, updatedAt, *aliases',
        finds: 'id, sampleId, region, createdAt',
        sections: 'id, sectionNo, sampleId, thickness, createdAt',
        analysis: 'id, sampleId, sectionId, method, testedAt, createdAt',
        meta: 'id',
        exportManifests: 'id, status, createdAt',
        historySnapshots: 'id, batchId, createdAt',
        renumberBatches: 'id, createdAt',
      })
      .upgrade(async (tx) => {
        // v4：初始化档案版本；旧样本补空别名数组，保证多值索引与读取一致
        const metaTable = tx.table<CatalogMeta, string>('meta');
        if (!(await metaTable.get(META_ID))) {
          await metaTable.add({ id: META_ID, catalogVersion: 1, updatedAt: Date.now() });
        }
        await tx
          .table<MeteoriteSample, string>('samples')
          .toCollection()
          .modify((sample) => {
            if (!Array.isArray(sample.aliases)) sample.aliases = [];
          });
      });
  }
}

export const db = new MeteoriteDB();

/** 生成一个稳定的本地 id */
export function makeId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${Date.now().toString(36)}_${rand}`;
}

/** 读取当前档案版本（v4 之前的库或异常情况下兜底为 1） */
export async function getCatalogVersion(): Promise<number> {
  const meta = await db.meta.get(META_ID);
  return meta?.catalogVersion ?? 1;
}

/** 档案版本 +1；与业务写入放在同一事务内调用 */
export async function bumpCatalogVersion(tx: Transaction): Promise<number> {
  const metaTable = tx.table<CatalogMeta, string>('meta');
  const meta = await metaTable.get(META_ID);
  const next = (meta?.catalogVersion ?? 1) + 1;
  await metaTable.put({ id: META_ID, catalogVersion: next, updatedAt: Date.now() });
  return next;
}

/** 首次运行时灌入演示档案，保证页面有可检索内容 */
export async function seedIfEmpty(): Promise<void> {
  const count = await db.samples.count();
  if (count > 0) return;
  const now = Date.now();
  await db.transaction(
    'rw',
    [db.samples, db.finds, db.sections, db.analysis, db.exportManifests, db.meta],
    async () => {
      await db.meta.put({ id: META_ID, catalogVersion: 1, updatedAt: now });
      await db.samples.bulkAdd([
        {
          id: 'sample_seed_1',
          sampleNo: 'MET-2024-001',
          aliases: [],
          totalWeight: 1250.4,
          category: 'chondrite',
          chemicalGroup: 'H',
          weathering: 'W1',
          fallOrFind: 'find',
          storage: 'cabinet-a',
          note: '撒哈拉回收，熔壳完整',
          createdAt: now - 86400000 * 40,
          updatedAt: now - 86400000 * 40,
        },
        {
          id: 'sample_seed_2',
          sampleNo: 'MET-2024-002',
          aliases: [],
          totalWeight: 8420,
          category: 'iron',
          chemicalGroup: 'IAB',
          weathering: 'W0',
          fallOrFind: 'find',
          storage: 'cabinet-b',
          note: '八面体结构清晰',
          createdAt: now - 86400000 * 30,
          updatedAt: now - 86400000 * 30,
        },
        {
          id: 'sample_seed_3',
          sampleNo: 'MET-2024-003',
          aliases: [],
          totalWeight: 318.9,
          category: 'achondrite',
          chemicalGroup: 'ungrouped',
          weathering: 'W2',
          fallOrFind: 'fall',
          storage: 'desiccator',
          note: '目击坠落，无熔壳',
          createdAt: now - 86400000 * 18,
          updatedAt: now - 86400000 * 18,
        },
      ]);
      await db.finds.bulkAdd([
        {
          id: 'find_seed_1',
          sampleId: 'sample_seed_1',
          placeName: 'Dar al Gani 区域',
          region: '利比亚',
          longitude: 16.2,
          latitude: 27.4,
          coordinateSource: 'gps',
          environment: 'desert',
          finder: '野外队 A 组',
          createdAt: now - 86400000 * 40,
        },
        {
          id: 'find_seed_2',
          sampleId: 'sample_seed_2',
          placeName: 'Gobi 南缘',
          region: '中国 内蒙古',
          longitude: 108.6,
          latitude: 42.1,
          coordinateSource: 'literature',
          environment: 'desert',
          finder: '标本室交换',
          createdAt: now - 86400000 * 30,
        },
      ]);
      await db.sections.bulkAdd([
        {
          id: 'section_seed_1',
          sectionNo: 'TS-2024-001',
          sampleId: 'sample_seed_1',
          thickness: 30,
          preparation: 'resin',
          minerals: { olivine: 42, pyroxene: 28, feldspar: 12, metal: 18 },
          micrographs: ['met001_ppl.jpg', 'met001_xpl.jpg'],
          quality: 'good',
          createdAt: now - 86400000 * 35,
        },
        {
          id: 'section_seed_2',
          sectionNo: 'TS-2024-002',
          sampleId: 'sample_seed_2',
          thickness: 60,
          preparation: 'epoxy',
          minerals: { olivine: 2, pyroxene: 5, feldspar: 1, metal: 92 },
          micrographs: ['met002_reflect.jpg'],
          quality: 'fair',
          createdAt: now - 86400000 * 25,
        },
      ]);
      await db.analysis.bulkAdd([
        {
          id: 'analysis_seed_1',
          sampleId: 'sample_seed_1',
          target: 'sample',
          method: 'microprobe',
          fa: 18.6,
          fs: 16.2,
          ni: 0.8,
          kamaciteBandwidth: 0.02,
          testedAt: '2024-06-12',
          createdAt: now - 86400000 * 20,
        },
        {
          id: 'analysis_seed_2',
          sampleId: 'sample_seed_2',
          target: 'sample',
          method: 'sem-eds',
          fa: 3.2,
          fs: 4.1,
          ni: 7.4,
          kamaciteBandwidth: 0.62,
          testedAt: '2024-07-03',
          createdAt: now - 86400000 * 12,
        },
      ]);
      // 演示一份「并入前」导出清单：其中冻结的旧编号在换号后仍照旧显示
      await db.exportManifests.add({
        id: 'manifest_seed_1',
        name: '并入前馆际交换清单（2024 秋）',
        status: 'sent',
        createdAt: now - 86400000 * 10,
        sentAt: now - 86400000 * 9,
        items: [
          { lineNo: 1, sampleId: 'sample_seed_1', sampleNoAtExport: 'MET-2024-001', totalWeightAtExport: 1250.4 },
          { lineNo: 2, sampleId: 'sample_seed_2', sampleNoAtExport: 'MET-2024-002', totalWeightAtExport: 8420 },
        ],
      });
    },
  );
}
