import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Chip,
  Collapse,
  Divider,
  IconButton,
  List,
  ListItemButton,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import AutorenewIcon from '@mui/icons-material/Autorenew';
import RefreshIcon from '@mui/icons-material/Refresh';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import { Link as RouterLink } from 'react-router-dom';
import { catalogEvents } from '../services/catalogEvents';
import { useSampleStore } from '../stores/sampleStore';
import { useToastStore } from '../stores/uiStore';
import {
  isGbMetNo,
  suggestGbMetNo,
  type CatalogStaleError,
  type RenumberPreview,
} from '../types/renumber';
import { formatDate } from '../utils/format';

interface RowDraft {
  sampleId: string;
  oldSampleNo: string;
  newSampleNo: string;
}

const ISSUE_LABEL: Record<string, { label: string; color: 'error' | 'warning' }> = {
  'sample-missing': { label: '样本缺失', color: 'error' },
  'sample-changed': { label: '编号已变', color: 'warning' },
  'new-no-empty': { label: '新号为空', color: 'error' },
  'new-no-format': { label: '格式不符', color: 'error' },
  'new-no-duplicate-in-batch': { label: '批内撞号', color: 'error' },
  'new-no-collision': { label: '新号撞车', color: 'error' },
  'alias-collision': { label: '旧号冲突', color: 'error' },
  'section-target-missing': { label: '切片关系缺失', color: 'error' },
  'analysis-target-missing': { label: '检测关系缺失', color: 'error' },
};

/** `/renumber` 整批换号（并入 GB-MET 编号体系） */
export default function Renumber() {
  const samples = useSampleStore((s) => s.samples);
  const snapshots = useSampleStore((s) => s.snapshots);
  const batches = useSampleStore((s) => s.batches);
  const catalogVersion = useSampleStore((s) => s.catalogVersion);
  const previewRenumber = useSampleStore((s) => s.previewRenumber);
  const commitRenumber = useSampleStore((s) => s.commitRenumber);
  const notify = useToastStore((s) => s.notify);

  const [selected, setSelected] = useState<string[]>([]);
  const [rows, setRows] = useState<RowDraft[]>([]);
  const [reason, setReason] = useState('标本馆藏品并入，迁移 GB-MET 编号');
  const [preview, setPreview] = useState<RenumberPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [commitError, setCommitError] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [openSnapshot, setOpenSnapshot] = useState<string | null>(null);

  const allGbMetNos = useMemo(
    () => samples.flatMap((s) => [s.sampleNo, ...(s.aliases ?? [])]),
    [samples],
  );

  const toggleSelect = (id: string) => {
    setPreview(null);
    setCommitError(null);
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  const buildRows = (ids: string[]): RowDraft[] => {
    let seq = 1;
    return ids.map((id) => {
      const s = samples.find((x) => x.id === id);
      if (!s) return { sampleId: id, oldSampleNo: '(已缺失)', newSampleNo: '' };
      const candidate = suggestGbMetNo(allGbMetNos, seq);
      seq = Number(candidate.slice('GB-MET-'.length)) + 1;
      return { sampleId: id, oldSampleNo: s.sampleNo, newSampleNo: candidate };
    });
  };

  // 选中变化时同步草稿行（保留已编辑的新号）
  useEffect(() => {
    setRows((prev) => {
      const prevMap = new Map(prev.map((r) => [r.sampleId, r]));
      let seq = 1;
      return selected.map((id) => {
        const existed = prevMap.get(id);
        const s = samples.find((x) => x.id === id);
        if (existed) return existed;
        if (!s) return { sampleId: id, oldSampleNo: '(已缺失)', newSampleNo: '' };
        const candidate = suggestGbMetNo(allGbMetNos, seq);
        seq = Number(candidate.slice('GB-MET-'.length)) + 1;
        return { sampleId: id, oldSampleNo: s.sampleNo, newSampleNo: candidate };
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  // 其他标签页已提交换号 → 作废本地预览，强制重新预览
  useEffect(() => {
    return catalogEvents.subscribe((e) => {
      if (preview && e.catalogVersion !== preview.catalogVersion) {
        setPreview(null);
        setCommitError(
          `另一会话已改动档案（v${preview.catalogVersion} → v${e.catalogVersion}），本批次已失效，请重新预览`,
        );
        notify('检测到档案被另一会话修改，批次预览已作废', 'warning');
      }
    });
  }, [preview, notify]);

  // 本标签页内 catalogVersion 变化（其他动作）也作废预览
  useEffect(() => {
    if (preview && catalogVersion !== preview.catalogVersion) {
      setPreview(null);
    }
  }, [catalogVersion, preview]);

  const runPreview = async () => {
    if (!rows.length) return;
    setPreviewing(true);
    setCommitError(null);
    try {
      const result = await previewRenumber(rows);
      setPreview(result);
      if (result.issues.length > 0) {
        notify(`预检发现 ${result.issues.length} 项阻断问题，整批暂不可提交`, 'warning');
      } else {
        notify('预检通过：未发现撞号或关系缺失');
      }
    } finally {
      setPreviewing(false);
    }
  };

  const runCommit = async () => {
    if (!preview || preview.issues.length > 0) return;
    setCommitting(true);
    setCommitError(null);
    try {
      const { batchId } = await commitRenumber(preview, reason.trim() || '整批换号');
      notify(`换号批次 ${batchId} 已提交，旧号已留为唯一别名`);
      setPreview(null);
      setSelected([]);
      setRows([]);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : '提交失败，整批未改动，请重新预览后再试';
      setCommitError(message);
      if ((err as CatalogStaleError).name === 'CatalogStaleError') {
        setPreview(null);
      }
    } finally {
      setCommitting(false);
    }
  };

  const updateNewNo = (sampleId: string, value: string) => {
    setPreview(null);
    setRows((prev) => prev.map((r) => (r.sampleId === sampleId ? { ...r, newSampleNo: value } : r)));
  };

  const affectedTotals = preview
    ? {
        finds: preview.entries.reduce((n, e) => n + e.refs.finds.length, 0),
        sections: preview.entries.reduce((n, e) => n + e.refs.sections.length, 0),
        analysis: preview.entries.reduce((n, e) => n + e.refs.analysis.length, 0),
        manifests: preview.entries.reduce((n, e) => n + e.refs.manifests.length, 0),
      }
    : null;

  const canCommit = !!preview && preview.issues.length === 0 && rows.length > 0;
  const previewStale = !!preview && preview.catalogVersion !== catalogVersion;

  return (
    <Stack spacing={2.5}>
      <Box>
        <Typography variant="h4">整批换号 · GB-MET 并入</Typography>
        <Typography variant="body2" color="text.secondary">
          标本馆并入另一批藏品后，把旧编号整批迁移为 GB-MET 编号。先预检列出样本、发现地、切片、检测记录、导出清单的受影响条目；
          新号撞车或关系缺失时整批不改。确认提交后旧号留为唯一别名，全部引用指向新档案，历史快照保留当时编号。
        </Typography>
        <Chip size="small" sx={{ mt: 1 }} label={`档案版本 v${catalogVersion}`} variant="outlined" />
      </Box>

      {commitError && <Alert severity="error" onClose={() => setCommitError(null)}>{commitError}</Alert>}

      <Paper variant="outlined" sx={{ p: 2.5 }}>
        <Typography variant="h6" sx={{ mb: 1.5 }}>
          第一步 · 勾选本批要换号的样本（{selected.length}）
        </Typography>
        <List dense disablePadding sx={{ maxHeight: 320, overflow: 'auto', border: '1px solid', borderColor: 'divider', borderRadius: 2 }}>
          {samples.map((s) => {
            const checked = selected.includes(s.id);
            return (
              <ListItemButton key={s.id} onClick={() => toggleSelect(s.id)} divider>
                <Checkbox size="small" checked={checked} tabIndex={-1} disableRipple edge="start" />
                <Stack direction="row" spacing={1.5} alignItems="center" sx={{ flex: 1, flexWrap: 'wrap' }}>
                  <Typography variant="subtitle2" sx={{ minWidth: 150 }}>{s.sampleNo}</Typography>
                  {(s.aliases ?? []).length > 0 && (
                    <Chip size="small" variant="outlined" label={`旧号 ${s.aliases!.join('、')}`} />
                  )}
                  <Typography variant="caption" color="text.secondary">{s.note ?? '无备注'}</Typography>
                </Stack>
              </ListItemButton>
            );
          })}
        </List>

        <Stack direction="row" spacing={2} alignItems="center" sx={{ mt: 2 }} flexWrap="wrap" useFlexGap>
          <Button
            variant="outlined"
            size="small"
            onClick={() => {
              setRows(buildRows(selected));
              setPreview(null);
            }}
            disabled={!selected.length}
          >
            重新生成建议号
          </Button>
          <TextField
            size="small"
            label="换号事由"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            sx={{ width: 320 }}
          />
        </Stack>
      </Paper>

      {rows.length > 0 && (
        <Paper variant="outlined" sx={{ p: 2.5 }}>
          <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 1.5 }}>
            <Typography variant="h6">第二步 · 核对旧号 → 新号映射</Typography>
            <Stack direction="row" spacing={1}>
              <Tooltip title="预检只读，不会改动任何数据">
                <Button
                  variant="contained"
                  startIcon={<AutorenewIcon />}
                  loading={previewing}
                  onClick={() => void runPreview()}
                >
                  生成预检清单
                </Button>
              </Tooltip>
            </Stack>
          </Stack>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>旧编号</TableCell>
                <TableCell sx={{ width: 240 }}>新 GB-MET 编号</TableCell>
                <TableCell>现有别名</TableCell>
                <TableCell>预检问题</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.map((r) => {
                const pv = preview?.entries.find((e) => e.sampleId === r.sampleId);
                const issues = pv?.issues ?? [];
                const valid = isGbMetNo(r.newSampleNo);
                return (
                  <TableRow key={r.sampleId} hover>
                    <TableCell>{r.oldSampleNo}</TableCell>
                    <TableCell>
                      <TextField
                        size="small"
                        fullWidth
                        value={r.newSampleNo}
                        error={r.newSampleNo.trim() !== '' && !valid}
                        helperText={r.newSampleNo.trim() !== '' && !valid ? '格式 GB-MET-000000' : undefined}
                        onChange={(e) => updateNewNo(r.sampleId, e.target.value)}
                      />
                    </TableCell>
                    <TableCell>
                      {(pv?.aliases ?? []).length ? (
                        pv!.aliases.map((a) => <Chip key={a} size="small" label={a} sx={{ mr: 0.5 }} />)
                      ) : (
                        <Typography variant="caption" color="text.secondary">—</Typography>
                      )}
                    </TableCell>
                    <TableCell>
                      {issues.length ? (
                        issues.map((iss) => (
                          <Tooltip key={iss.code + iss.message} title={iss.message}>
                            <Chip
                              size="small"
                              color={ISSUE_LABEL[iss.code]?.color ?? 'error'}
                              label={ISSUE_LABEL[iss.code]?.label ?? iss.code}
                              sx={{ mr: 0.5, mb: 0.25 }}
                            />
                          </Tooltip>
                        ))
                      ) : pv ? (
                        <Chip size="small" color="success" label="可换号" />
                      ) : (
                        <Typography variant="caption" color="text.secondary">待预检</Typography>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </Paper>
      )}

      {preview && (
        <Paper variant="outlined" sx={{ p: 2.5 }}>
          <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 1.5 }}>
            <Typography variant="h6">第三步 · 预检清单（只读预览，不落库）</Typography>
            <Stack direction="row" spacing={1} alignItems="center">
              <Chip size="small" variant="outlined" label={`基于 v${preview.catalogVersion}`} />
              {previewStale && <Chip size="small" color="warning" label="版本已过期" />}
              <Button size="small" startIcon={<RefreshIcon />} onClick={() => void runPreview()}>
                重新预览
              </Button>
            </Stack>
          </Stack>

          {preview.issues.length > 0 ? (
            <Alert severity="error" sx={{ mb: 2 }}>
              预检发现 {preview.issues.length} 项阻断问题（新号撞车 / 关系缺失等），整批将保持原样，不会执行任何改动。
              <List dense disablePadding sx={{ mt: 1 }}>
                {preview.issues.map((iss, i) => (
                  <Typography key={i} variant="body2">
                    · {iss.message}
                  </Typography>
                ))}
              </List>
            </Alert>
          ) : (
            <Alert severity="success" sx={{ mb: 2 }}>
              预检通过：{preview.entries.length} 份样本，将重指发现地 {affectedTotals!.finds} 条、切片{' '}
              {affectedTotals!.sections} 张、检测记录 {affectedTotals!.analysis} 条、导出清单{' '}
              {affectedTotals!.manifests} 个条目。旧号将作为唯一别名保留，导出清单内冻结编号不变。
            </Alert>
          )}

          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>旧号 → 新号</TableCell>
                <TableCell align="center">发现地</TableCell>
                <TableCell align="center">切片</TableCell>
                <TableCell align="center">检测记录</TableCell>
                <TableCell>导出清单条目（冻结编号）</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {preview.entries.map((e) => (
                <TableRow key={e.sampleId} hover>
                  <TableCell>
                    <Typography variant="subtitle2">
                      {e.oldSampleNo} → {e.newSampleNo}
                    </Typography>
                    {e.refs.finds.map((f) => (
                      <Typography key={f.id} variant="caption" color="text.secondary" component="div">
                        发现地：{f.region} · {f.placeName}
                      </Typography>
                    ))}
                  </TableCell>
                  <TableCell align="center">{e.refs.finds.length}</TableCell>
                  <TableCell align="center">
                    {e.refs.sections.length ? (
                      <Tooltip title={e.refs.sections.map((x) => x.sectionNo).join('、')}>
                        <Chip size="small" label={e.refs.sections.length} />
                      </Tooltip>
                    ) : (
                      0
                    )}
                  </TableCell>
                  <TableCell align="center">
                    {e.refs.analysis.length ? (
                      <Tooltip title={e.refs.analysis.map((x) => `${x.method} ${x.testedAt}`).join('；')}>
                        <Chip size="small" label={e.refs.analysis.length} />
                      </Tooltip>
                    ) : (
                      0
                    )}
                  </TableCell>
                  <TableCell>
                    {e.refs.manifests.length ? (
                      e.refs.manifests.map((m) => (
                        <Typography key={`${m.id}-${m.lineNo}`} variant="caption" component="div">
                          {m.name} #{m.lineNo} · 冻结号 {m.frozenNo}
                        </Typography>
                      ))
                    ) : (
                      <Typography variant="caption" color="text.secondary">无</Typography>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>

          <Stack direction="row" spacing={1.5} sx={{ mt: 2.5 }} justifyContent="flex-end">
            <Button
              variant="outlined"
              color="inherit"
              onClick={() => {
                setPreview(null);
              }}
            >
              放弃预览
            </Button>
            <Button
              variant="contained"
              color="primary"
              disabled={!canCommit || previewStale || committing}
              loading={committing}
              startIcon={<AutorenewIcon />}
              onClick={() => void runCommit()}
            >
              {previewStale ? '版本已变，请重新预览' : '确认整批换号'}
            </Button>
          </Stack>
        </Paper>
      )}

      <Paper variant="outlined" sx={{ p: 2.5 }}>
        <Stack
          direction="row"
          alignItems="center"
          justifyContent="space-between"
          sx={{ cursor: 'pointer' }}
          onClick={() => setShowHistory((v) => !v)}
        >
          <Typography variant="h6">历史换号批次与快照（{batches.length}）</Typography>
          <IconButton size="small">
            <ExpandMoreIcon sx={{ transform: showHistory ? 'rotate(180deg)' : 'none', transition: 'transform .2s' }} />
          </IconButton>
        </Stack>
        <Collapse in={showHistory}>
          {batches.length === 0 ? (
            <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
              尚无换号批次。历史快照不可变，始终显示换号当时的编号。
            </Typography>
          ) : (
            <List dense sx={{ mt: 1 }}>
              {batches.map((b) => {
                const snap = snapshots.find((x) => x.batchId === b.id);
                const open = openSnapshot === b.id;
                return (
                  <Box key={b.id} sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 2, p: 1.5, mb: 1 }}>
                    <Stack
                      direction="row"
                      alignItems="center"
                      justifyContent="space-between"
                      sx={{ cursor: 'pointer' }}
                      onClick={() => setOpenSnapshot(open ? null : b.id)}
                    >
                      <Box>
                        <Typography variant="subtitle2">
                          {formatDate(b.createdAt)} · {b.reason}
                        </Typography>
                        <Typography variant="caption" color="text.secondary">
                          {b.entries.length} 份样本 · v{b.baseCatalogVersion} → v{b.nextCatalogVersion} · 批次 {b.id}
                        </Typography>
                      </Box>
                      <ExpandMoreIcon sx={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform .2s' }} />
                    </Stack>
                    <Collapse in={open}>
                      <Table size="small" sx={{ mt: 1 }}>
                        <TableHead>
                          <TableRow>
                            <TableCell>当时编号（快照冻结）</TableCell>
                            <TableCell>换号后</TableCell>
                            <TableCell align="center">发现地/切片/检测</TableCell>
                            <TableCell>当前档案</TableCell>
                          </TableRow>
                        </TableHead>
                        <TableBody>
                          {snap?.samples.map((ss) => {
                            const entry = b.entries.find((e) => e.oldSampleId === ss.sample.id);
                            const currentId = entry?.newSampleId;
                            const stillExists = samples.some((s) => s.id === currentId);
                            return (
                              <TableRow key={ss.sample.id}>
                                <TableCell>
                                  <Typography variant="body2" fontWeight={700}>{ss.sample.sampleNo}</Typography>
                                  <Typography variant="caption" color="text.secondary">
                                    快照内编号不随后续操作改写
                                  </Typography>
                                </TableCell>
                                <TableCell>{entry?.newSampleNo ?? '—'}</TableCell>
                                <TableCell align="center">
                                  {[ss.find ? 1 : 0, ss.sections.length, ss.analysis.length].join(' / ')}
                                </TableCell>
                                <TableCell>
                                  {stillExists ? (
                                    <Typography
                                      component={RouterLink}
                                      to={`/samples/${currentId}`}
                                      variant="caption"
                                      sx={{ color: 'primary.main', textDecoration: 'none' }}
                                    >
                                      打开新档案 ↗
                                    </Typography>
                                  ) : (
                                    <Typography variant="caption" color="text.secondary">已再次换号或删除</Typography>
                                  )}
                                </TableCell>
                              </TableRow>
                            );
                          })}
                        </TableBody>
                      </Table>
                    </Collapse>
                  </Box>
                );
              })}
            </List>
          )}
        </Collapse>
        <Divider sx={{ my: 2 }} />
        <Button component={RouterLink} to="/exports" variant="text" size="small">
          前往导出清单（查看冻结编号）
        </Button>
      </Paper>
    </Stack>
  );
}
