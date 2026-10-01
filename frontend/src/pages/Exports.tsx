import { useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
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
  Typography,
} from '@mui/material';
import IosShareIcon from '@mui/icons-material/IosShare';
import { Link as RouterLink } from 'react-router-dom';
import { useSampleStore } from '../stores/sampleStore';
import { useToastStore } from '../stores/uiStore';
import { formatDate, formatWeight } from '../utils/format';

/** `/exports` 导出清单：导出时冻结编号，换号后仍显示当时编号 */
export default function Exports() {
  const samples = useSampleStore((s) => s.samples);
  const manifests = useSampleStore((s) => s.manifests);
  const createManifest = useSampleStore((s) => s.createManifest);
  const markManifestSent = useSampleStore((s) => s.markManifestSent);
  const notify = useToastStore((s) => s.notify);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [name, setName] = useState('');
  const [picked, setPicked] = useState<string[]>([]);

  const sampleMap = useMemo(() => new Map(samples.map((s) => [s.id, s])), [samples]);

  const openDialog = () => {
    setName(`导出清单 ${new Date().toISOString().slice(0, 10)}`);
    setPicked([]);
    setDialogOpen(true);
  };

  const submit = async () => {
    if (!picked.length) return;
    const id = await createManifest(name, picked);
    notify(`已生成清单，${picked.length} 个条目的编号已按导出时刻冻结`);
    setDialogOpen(false);
    return id;
  };

  return (
    <Stack spacing={2.5}>
      <Stack direction="row" alignItems="flex-end" justifyContent="space-between" flexWrap="wrap" gap={2}>
        <Box>
          <Typography variant="h4">导出清单</Typography>
          <Typography variant="body2" color="text.secondary">
            清单条目在导出时刻冻结样本号与重量。整批换号后条目引用指向新档案，但清单仍显示导出当时的编号；
            可对照查看当前 GB-MET 编号。
          </Typography>
        </Box>
        <Button variant="contained" startIcon={<IosShareIcon />} onClick={openDialog}>
          新建导出清单
        </Button>
      </Stack>

      {manifests.length === 0 ? (
        <Alert severity="info">尚无导出清单。</Alert>
      ) : (
        manifests.map((m) => (
          <Paper key={m.id} variant="outlined" sx={{ p: 2.5 }}>
            <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 1.5 }} flexWrap="wrap" gap={1}>
              <Box>
                <Typography variant="h6">{m.name}</Typography>
                <Typography variant="caption" color="text.secondary">
                  生成 {formatDate(m.createdAt)}
                  {m.sentAt ? ` · 发出 ${formatDate(m.sentAt)}` : ' · 草稿未发出'} · {m.items.length} 条
                </Typography>
              </Box>
              <Stack direction="row" spacing={1} alignItems="center">
                <Chip size="small" color={m.status === 'sent' ? 'success' : 'default'} label={m.status === 'sent' ? '已发出' : '草稿'} />
                {m.status === 'draft' && (
                  <Button size="small" variant="outlined" onClick={() => { void markManifestSent(m.id); notify('清单已标记为发出'); }}>
                    标记发出
                  </Button>
                )}
              </Stack>
            </Stack>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell sx={{ width: 60 }}>#</TableCell>
                  <TableCell>导出当时编号（冻结）</TableCell>
                  <TableCell>当前档案编号</TableCell>
                  <TableCell align="right">重量</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {m.items.map((it) => {
                  const current = sampleMap.get(it.sampleId);
                  const renumbered = current && current.sampleNo !== it.sampleNoAtExport;
                  return (
                    <TableRow key={`${m.id}-${it.lineNo}`} hover>
                      <TableCell>{it.lineNo}</TableCell>
                      <TableCell>
                        <Typography variant="body2" fontWeight={700}>{it.sampleNoAtExport}</Typography>
                        {renumbered && (
                          <Typography variant="caption" color="text.secondary">历史编号，保持清单原样</Typography>
                        )}
                      </TableCell>
                      <TableCell>
                        {current ? (
                          <Stack direction="row" spacing={0.75} alignItems="center" flexWrap="wrap" useFlexGap>
                            <Typography
                              component={RouterLink}
                              to={`/samples/${current.id}`}
                              variant="body2"
                              sx={{ color: 'primary.main', textDecoration: 'none' }}
                            >
                              {current.sampleNo} ↗
                            </Typography>
                            {renumbered && <Chip size="small" color="secondary" label="已换号" />}
                          </Stack>
                        ) : (
                          <Typography variant="caption" color="text.secondary">档案已删除</Typography>
                        )}
                      </TableCell>
                      <TableCell align="right">{formatWeight(it.totalWeightAtExport)}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </Paper>
        ))
      )}

      <Dialog open={dialogOpen} onClose={() => setDialogOpen(false)} fullWidth maxWidth="sm">
        <DialogTitle>新建导出清单</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            fullWidth
            size="small"
            label="清单名称"
            value={name}
            onChange={(e) => setName(e.target.value)}
            sx={{ mb: 2, mt: 0.5 }}
          />
          <Typography variant="subtitle2" sx={{ mb: 1 }}>
            勾选导出样本（{picked.length}）
          </Typography>
          <List dense disablePadding sx={{ maxHeight: 320, overflow: 'auto', border: '1px solid', borderColor: 'divider', borderRadius: 2 }}>
            {samples.map((s) => {
              const checked = picked.includes(s.id);
              return (
                <ListItemButton
                  key={s.id}
                  divider
                  onClick={() => setPicked((prev) => (prev.includes(s.id) ? prev.filter((x) => x !== s.id) : [...prev, s.id]))}
                >
                  <Checkbox size="small" checked={checked} tabIndex={-1} disableRipple edge="start" />
                  <Stack direction="row" spacing={1} alignItems="center">
                    <Typography variant="subtitle2">{s.sampleNo}</Typography>
                    {(s.aliases ?? []).map((a) => (
                      <Chip key={a} size="small" variant="outlined" label={`旧号 ${a}`} />
                    ))}
                  </Stack>
                </ListItemButton>
              );
            })}
          </List>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDialogOpen(false)}>取消</Button>
          <Button variant="contained" disabled={!picked.length} onClick={() => void submit()}>
            生成（冻结当前编号）
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}
