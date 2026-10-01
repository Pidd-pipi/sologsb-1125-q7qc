import { create } from 'zustand';
import { bumpCatalogVersion, db, getCatalogVersion, makeId, seedIfEmpty } from '../db';
import { catalogEvents } from '../services/catalogEvents';
import { commitRenumber, previewRenumber } from '../services/renumber';
import type { AnalysisRecord } from '../types/analysis';
import type { ExportManifest } from '../types/manifest';
import type { FindRecord } from '../types/find';
import type { MeteoriteSample } from '../types/sample';
import type { HistorySnapshot } from '../types/snapshot';
import type { RenumberBatch, RenumberPreview } from '../types/renumber';
import type { ThinSection } from '../types/section';

export interface SampleState {
  samples: MeteoriteSample[];
  finds: FindRecord[];
  sections: ThinSection[];
  analysis: AnalysisRecord[];
  manifests: ExportManifest[];
  snapshots: HistorySnapshot[];
  batches: RenumberBatch[];
  catalogVersion: number;
  loading: boolean;
  loaded: boolean;
  loadAll: () => Promise<void>;
  addSample: (input: Omit<MeteoriteSample, 'id' | 'createdAt' | 'updatedAt' | 'aliases'>) => Promise<string>;
  updateSample: (id: string, patch: Partial<MeteoriteSample>) => Promise<void>;
  removeSample: (id: string) => Promise<void>;
  addFind: (input: Omit<FindRecord, 'id' | 'createdAt'>) => Promise<string>;
  addSection: (input: Omit<ThinSection, 'id' | 'createdAt'>) => Promise<string>;
  updateSection: (id: string, patch: Partial<ThinSection>) => Promise<void>;
  addAnalysis: (input: Omit<AnalysisRecord, 'id' | 'createdAt'>) => Promise<string>;
  createManifest: (name: string, sampleIds: string[]) => Promise<string>;
  markManifestSent: (id: string) => Promise<void>;
  previewRenumber: (
    entries: { sampleId: string; oldSampleNo: string; newSampleNo: string }[],
  ) => Promise<RenumberPreview>;
  commitRenumber: (preview: RenumberPreview, reason: string) => Promise<{ batchId: string }>;
  resolveSampleId: (id: string) => string | undefined;
  nextSampleSeq: () => number;
}

export const useSampleStore = create<SampleState>((set, get) => ({
  samples: [],
  finds: [],
  sections: [],
  analysis: [],
  manifests: [],
  snapshots: [],
  batches: [],
  catalogVersion: 0,
  loading: false,
  loaded: false,

  loadAll: async () => {
    set({ loading: true });
    await seedIfEmpty();
    const [samples, finds, sections, analysis, manifests, snapshots, batches, catalogVersion] =
      await Promise.all([
        db.samples.toArray(),
        db.finds.toArray(),
        db.sections.toArray(),
        db.analysis.toArray(),
        db.exportManifests.toArray(),
        db.historySnapshots.toArray(),
        db.renumberBatches.toArray(),
        getCatalogVersion(),
      ]);
    samples.sort((a, b) => b.createdAt - a.createdAt);
    finds.sort((a, b) => b.createdAt - a.createdAt);
    sections.sort((a, b) => b.createdAt - a.createdAt);
    analysis.sort((a, b) => b.createdAt - a.createdAt);
    manifests.sort((a, b) => b.createdAt - a.createdAt);
    snapshots.sort((a, b) => b.createdAt - a.createdAt);
    batches.sort((a, b) => b.createdAt - a.createdAt);
    set({
      samples,
      finds,
      sections,
      analysis,
      manifests,
      snapshots,
      batches,
      catalogVersion,
      loading: false,
      loaded: true,
    });
  },

  addSample: async (input) => {
    const now = Date.now();
    const record: MeteoriteSample = {
      ...input,
      aliases: [],
      id: makeId('sample'),
      createdAt: now,
      updatedAt: now,
    };
    let nextVersion = 0;
    await db.transaction('rw', [db.samples, db.meta], async (tx) => {
      await db.samples.add(record);
      nextVersion = await bumpCatalogVersion(tx);
    });
    set({ samples: [record, ...get().samples], catalogVersion: nextVersion });
    catalogEvents.post({ type: 'catalog-updated', catalogVersion: nextVersion, at: Date.now() });
    return record.id;
  },

  updateSample: async (id, patch) => {
    const updatedAt = Date.now();
    await db.samples.update(id, { ...patch, updatedAt });
    set({
      samples: get().samples.map((s) => (s.id === id ? { ...s, ...patch, updatedAt } : s)),
    });
  },

  removeSample: async (id) => {
    let nextVersion = 0;
    await db.transaction(
      'rw',
      [db.samples, db.finds, db.sections, db.analysis, db.exportManifests, db.meta],
      async (tx) => {
        await db.samples.delete(id);
        await db.finds.where('sampleId').equals(id).delete();
        await db.sections.where('sampleId').equals(id).delete();
        await db.analysis.where('sampleId').equals(id).delete();
        // 导出清单移除已删样本条目（冻结编号随条目一起消失）
        const touched = await db.exportManifests
          .filter((m) => m.items.some((it) => it.sampleId === id))
          .toArray();
        for (const m of touched) {
          await db.exportManifests.update(m.id, {
            items: m.items
              .filter((it) => it.sampleId !== id)
              .map((it, idx) => ({ ...it, lineNo: idx + 1 })),
          });
        }
        nextVersion = await bumpCatalogVersion(tx);
      },
    );
    set({
      samples: get().samples.filter((s) => s.id !== id),
      finds: get().finds.filter((f) => f.sampleId !== id),
      sections: get().sections.filter((s) => s.sampleId !== id),
      analysis: get().analysis.filter((a) => a.sampleId !== id),
      manifests: get().manifests
        .map((m) =>
          m.items.some((it) => it.sampleId === id)
            ? { ...m, items: m.items.filter((it) => it.sampleId !== id) }
            : m,
        )
        .filter((m) => m.items.length > 0),
      catalogVersion: nextVersion,
    });
    catalogEvents.post({ type: 'catalog-updated', catalogVersion: nextVersion, at: Date.now() });
  },

  addFind: async (input) => {
    const record: FindRecord = { ...input, id: makeId('find'), createdAt: Date.now() };
    await db.finds.add(record);
    set({ finds: [record, ...get().finds] });
    return record.id;
  },

  addSection: async (input) => {
    const record: ThinSection = { ...input, id: makeId('section'), createdAt: Date.now() };
    await db.sections.add(record);
    set({ sections: [record, ...get().sections] });
    return record.id;
  },

  updateSection: async (id, patch) => {
    await db.sections.update(id, patch);
    set({ sections: get().sections.map((s) => (s.id === id ? { ...s, ...patch } : s)) });
  },

  addAnalysis: async (input) => {
    const record: AnalysisRecord = { ...input, id: makeId('analysis'), createdAt: Date.now() };
    await db.analysis.add(record);
    set({ analysis: [record, ...get().analysis] });
    return record.id;
  },

  createManifest: async (name, sampleIds) => {
    const samples = get().samples;
    const byId = new Map(samples.map((s) => [s.id, s]));
    const items = sampleIds
      .map((id, idx) => {
        const s = byId.get(id);
        if (!s) return null;
        return {
          lineNo: idx + 1,
          sampleId: s.id,
          sampleNoAtExport: s.sampleNo,
          totalWeightAtExport: s.totalWeight,
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);
    const record: ExportManifest = {
      id: makeId('manifest'),
      name: name.trim() || `导出清单 ${new Date().toISOString().slice(0, 10)}`,
      items,
      status: 'draft',
      createdAt: Date.now(),
    };
    await db.exportManifests.add(record);
    set({ manifests: [record, ...get().manifests] });
    return record.id;
  },

  markManifestSent: async (id) => {
    const sentAt = Date.now();
    await db.exportManifests.update(id, { status: 'sent', sentAt });
    set({
      manifests: get().manifests.map((m) => (m.id === id ? { ...m, status: 'sent', sentAt } : m)),
    });
  },

  previewRenumber: async (entries) => previewRenumber(entries),

  commitRenumber: async (preview, reason) => {
    const result = await commitRenumber(preview, reason);
    await get().loadAll();
    catalogEvents.post({
      type: 'renumber-committed',
      catalogVersion: result.batch.nextCatalogVersion,
      batchId: result.batch.id,
      reason,
      at: Date.now(),
    });
    return { batchId: result.batch.id };
  },

  resolveSampleId: (id) => {
    const { samples, snapshots } = get();
    const liveIds = new Set(samples.map((s) => s.id));
    if (liveIds.has(id)) return id;
    // 旧档案 id：按时间正序沿快照 idMap 链追到现存档案（可能经历多轮换号）
    const chain = [...snapshots].sort((a, b) => a.createdAt - b.createdAt);
    const mergedMap: Record<string, string> = {};
    for (const snap of chain) {
      // 先在已有链尾上接，再并入本批映射，得到 旧id→本批结束时id 的传递闭包
      for (const [from, to] of Object.entries(snap.idMap)) {
        mergedMap[from] = to;
      }
      for (const key of Object.keys(mergedMap)) {
        const tail = mergedMap[key];
        if (tail !== undefined && snap.idMap[tail] !== undefined) {
          mergedMap[key] = snap.idMap[tail];
        }
      }
    }
    const finalId = mergedMap[id];
    return finalId && liveIds.has(finalId) ? finalId : undefined;
  },

  nextSampleSeq: () => {
    const year = new Date().getFullYear();
    const prefix = `MET-${year}-`;
    const used = get()
      .samples.map((s) => s.sampleNo)
      .filter((no) => no.startsWith(prefix))
      .map((no) => Number(no.slice(prefix.length)))
      .filter((n) => Number.isFinite(n));
    const max = used.length ? Math.max(...used) : 0;
    return max + 1;
  },
}));
