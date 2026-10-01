import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Divider,
  Grid,
  List,
  ListItem,
  ListItemText,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Typography,
} from '@mui/material';
import SwapHorizIcon from '@mui/icons-material/SwapHoriz';
import RefreshIcon from '@mui/icons-material/Refresh';
import { db } from '../db';
import {
  commitRenumber,
  previewRenumber,
  RenumberConflictError,
  REF_KIND_LABELS,
  type RenumberPreview,
} from '../services/renumber';
import { useSampleStore } from '../stores/sampleStore';
import { useToastStore } from '../stores/uiStore';
import { formatDate } from '../utils/format';

/** `/renumber` 整批换号：预览 → 校验 → 提交，并发冲突时强制重新预览 */
export default function Renumber() {
  const loadAll = useSampleStore((s) => s.loadAll);
  const revision = useSampleStore((s) => s.revision);
  const notify = useToastStore((s) => s.notify);

  const [preview, setPreview] = useState<RenumberPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [committing, setCommitting] = useState(false);

  const runPreview = useCallback(async () => {
    setLoading(true);
    setConflict(false);
    try {
      const p = await previewRenumber(db);
      setPreview(p);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void runPreview();
  }, [runPreview]);

  const commit = async () => {
    if (!preview || preview.errors.length || !preview.plan.length) return;
    setCommitting(true);
    try {
      const nextRevision = await commitRenumber(db, preview);
      notify(`整批换号完成（批次 v${nextRevision}），旧号已留为唯一别名`);
      await loadAll();
      await runPreview();
    } catch (e) {
      if (e instanceof RenumberConflictError) {
        // 后到的一方看到批次已变：重新预览，不与先到的结果混成两批
        setConflict(true);
        await loadAll();
        await runPreview();
      } else {
        throw e;
      }
    } finally {
      setCommitting(false);
    }
  };

  const findCount = preview?.affectedRefs.filter((r) => r.kind === 'find').length ?? 0;
  const sectionCount = preview?.affectedRefs.filter((r) => r.kind === 'section').length ?? 0;
  const analysisCount = preview?.affectedRefs.filter((r) => r.kind === 'analysis').length ?? 0;
  const blocked = !!preview && (preview.errors.length > 0 || preview.plan.length === 0);

  return (
    <Stack spacing={2.5}>
      <Box>
        <Typography variant="h4">整批换号</Typography>
        <Typography variant="body2" color="text.secondary">
          并入新一批藏品后，将本批样本编号统一迁移到 GB-MET 体系。先列出受影响的样本、发现地、切片、检测记录与导出清单；
          新号撞车或关系缺失时整批不改。确认后旧号留作唯一别名可继续检索，所有引用随样本一起指向新档案，历史快照仍显示当时编号。
        </Typography>
      </Box>

      {conflict ? (
        <Alert severity="warning" onClose={() => setConflict(false)}>
          批次已被其他会话修改（版本已更新）。已为你重新预览，请核对后再提交；本次不会与先提交的结果混成两批。
        </Alert>
      ) : null}

      {!preview || loading ? (
        <Stack alignItems="center" spacing={2} sx={{ py: 6 }}>
          <CircularProgress />
          <Typography variant="body2" color="text.secondary">
            正在比对整批档案…
          </Typography>
        </Stack>
      ) : (
        <>
          <Paper variant="outlined" sx={{ p: 2 }}>
            <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap alignItems="center">
              <Chip size="small" label={`当前批次版本 v${revision}`} variant="outlined" />
              <Chip size="small" label={`预览版本 v${preview.baseRevision}`} color="primary" variant="outlined" />
              <Divider orientation="vertical" flexItem />
              <Chip size="small" label={`样本 ${preview.affectedSamples.length}`} />
              <Chip size="small" label={`发现地 ${findCount}`} />
              <Chip size="small" label={`切片 ${sectionCount}`} />
              <Chip size="small" label={`检测 ${analysisCount}`} />
              <Chip size="small" label={`导出清单 ${preview.affectedSnapshots.length}`} />
              <Box sx={{ flex: 1 }} />
              <Button startIcon={<RefreshIcon />} onClick={() => void runPreview()} disabled={loading}>
                重新预览
              </Button>
            </Stack>
          </Paper>

          {preview.errors.length > 0 ? (
            <Alert severity="error">
              存在 {preview.errors.length} 项阻断问题，整批换号不会执行：
              <ul style={{ margin: '8px 0 0', paddingLeft: 20 }}>
                {preview.errors.map((e, i) => (
                  <li key={i}>{e.message}</li>
                ))}
              </ul>
            </Alert>
          ) : null}

          <Paper variant="outlined" sx={{ p: 2.5 }}>
            <Typography variant="h6" sx={{ mb: 1.5 }}>
              样本换号对照（{preview.affectedSamples.length}）
            </Typography>
            {preview.affectedSamples.length === 0 ? (
              <Alert severity="info">全部样本已是 GB-MET 编号，本批无需换号。</Alert>
            ) : (
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>旧号（换号后留为唯一别名）</TableCell>
                    <TableCell width={48} />
                    <TableCell>新号（GB-MET）</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {preview.affectedSamples.map((p) => (
                    <TableRow key={p.sampleId}>
                      <TableCell>
                        <Typography variant="body2" sx={{ fontFamily: 'monospace' }}>
                          {p.oldNo}
                        </Typography>
                      </TableCell>
                      <TableCell>
                        <SwapHorizIcon fontSize="small" color="action" />
                      </TableCell>
                      <TableCell>
                        <Typography variant="body2" sx={{ fontFamily: 'monospace', fontWeight: 700 }}>
                          {p.newNo}
                        </Typography>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </Paper>

          <Grid container spacing={2.5}>
            <Grid item xs={12} md={7}>
              <Paper variant="outlined" sx={{ p: 2.5, height: '100%' }}>
                <Typography variant="h6" sx={{ mb: 1 }}>
                  引用联动（{preview.affectedRefs.length}）
                </Typography>
                <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
                  发现地、切片与检测记录通过样本档案关联，换号后随样本一起指向新档案，关系不断裂。
                </Typography>
                {preview.affectedRefs.length === 0 ? (
                  <Alert severity="info">没有引用本批样本的发现地 / 切片 / 检测记录。</Alert>
                ) : (
                  <List dense disablePadding>
                    {preview.affectedRefs.map((r) => (
                      <ListItem key={`${r.kind}-${r.id}`} disableGutters>
                        <ListItemText
                          primary={
                            <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
                              <Typography variant="body2" sx={{ fontFamily: 'monospace' }}>
                                {r.oldNo}
                              </Typography>
                              <SwapHorizIcon fontSize="inherit" color="action" />
                              <Typography variant="body2" sx={{ fontFamily: 'monospace', fontWeight: 700 }}>
                                {r.newNo}
                              </Typography>
                            </Stack>
                          }
                          secondary={`${REF_KIND_LABELS[r.kind]} · ${r.label}`}
                        />
                      </ListItem>
                    ))}
                  </List>
                )}
              </Paper>
            </Grid>

            <Grid item xs={12} md={5}>
              <Paper variant="outlined" sx={{ p: 2.5, height: '100%' }}>
                <Typography variant="h6" sx={{ mb: 1 }}>
                  导出清单快照（{preview.affectedSnapshots.length}）
                </Typography>
                <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
                  以下导出清单包含本批样本，换号后仍显示导出当时的编号，不随换号改变。
                </Typography>
                {preview.affectedSnapshots.length === 0 ? (
                  <Alert severity="info">暂无包含本批样本的导出清单。</Alert>
                ) : (
                  <List dense disablePadding>
                    {preview.affectedSnapshots.map((s) => (
                      <ListItem key={s.id} disableGutters>
                        <ListItemText
                          primary={s.label}
                          secondary={`导出于 ${formatDate(s.createdAt)} · 冻结 ${s.frozenCount} 份样本编号`}
                        />
                      </ListItem>
                    ))}
                  </List>
                )}
              </Paper>
            </Grid>
          </Grid>

          <Stack direction="row" spacing={1.5} alignItems="center">
            <Button
              variant="contained"
              startIcon={<SwapHorizIcon />}
              onClick={() => void commit()}
              disabled={blocked || committing}
              id="renumber-commit"
            >
              {committing ? '正在换号…' : '确认整批换号'}
            </Button>
            <Button variant="outlined" onClick={() => void runPreview()} disabled={loading || committing}>
              重新预览
            </Button>
            {blocked ? (
              <Typography variant="caption" color="error">
                {preview.errors.length > 0
                  ? '存在阻断项，整批不改'
                  : '本批无需换号'}
              </Typography>
            ) : (
              <Typography variant="caption" color="text.secondary">
                将一次性更新 {preview.plan.length} 份样本，旧号留为唯一别名
              </Typography>
            )}
          </Stack>
        </>
      )}
    </Stack>
  );
}
