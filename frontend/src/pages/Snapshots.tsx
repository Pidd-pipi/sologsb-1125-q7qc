import { useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  Paper,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import SaveIcon from '@mui/icons-material/Save';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import { Link as RouterLink } from 'react-router-dom';
import EmptyState from '../components/common/EmptyState';
import { useSampleStore } from '../stores/sampleStore';
import { useToastStore } from '../stores/uiStore';
import { formatDate } from '../utils/format';

/** `/snapshots` 导出清单：导出当前样本编号作为历史快照，换号后仍显示当时编号 */
export default function Snapshots() {
  const snapshots = useSampleStore((s) => s.snapshots);
  const samples = useSampleStore((s) => s.samples);
  const createSnapshot = useSampleStore((s) => s.createSnapshot);
  const deleteSnapshot = useSampleStore((s) => s.deleteSnapshot);
  const notify = useToastStore((s) => s.notify);

  const [label, setLabel] = useState('');

  const sampleMap = useMemo(() => new Map(samples.map((s) => [s.id, s])), [samples]);

  const submit = async () => {
    const name = label.trim() || `导出清单 ${formatDate(Date.now())}`;
    await createSnapshot(name);
    setLabel('');
    notify(`已导出清单「${name}」，样本编号已冻结`);
  };

  return (
    <Stack spacing={2.5}>
      <Box>
        <Typography variant="h4">导出清单</Typography>
        <Typography variant="body2" color="text.secondary">
          导出当前样本档案编号作为历史快照。整批换号后，快照仍显示导出当时的编号；若样本已换号，会标注现行编号并保留档案链接。
        </Typography>
      </Box>

      <Paper variant="outlined" sx={{ p: 2 }}>
        <Stack direction="row" spacing={1.5} alignItems="center" flexWrap="wrap" useFlexGap>
          <TextField
            size="small"
            label="清单名称"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder={`导出清单 ${formatDate(Date.now())}`}
            sx={{ width: 260 }}
          />
          <Button variant="contained" startIcon={<SaveIcon />} onClick={() => void submit()} id="create-snapshot">
            导出当前清单
          </Button>
          <Typography variant="caption" color="text.secondary">
            将冻结当前 {samples.length} 份样本的编号
          </Typography>
        </Stack>
      </Paper>

      {snapshots.length === 0 ? (
        <EmptyState
          title="还没有导出清单"
          description="导出一份清单冻结当前样本编号，整批换号后仍可在此查看当时的编号。"
          actionLabel="导出第一份清单"
          onAction={() => void submit()}
        />
      ) : (
        <Stack spacing={2}>
          {snapshots.map((snap) => (
            <Paper key={snap.id} variant="outlined" sx={{ p: 2.5 }}>
              <Stack direction="row" justifyContent="space-between" alignItems="center" flexWrap="wrap" gap={1}>
                <Box>
                  <Typography variant="h6">{snap.label}</Typography>
                  <Typography variant="caption" color="text.secondary">
                    导出于 {formatDate(snap.createdAt)} · 冻结 {snap.items.length} 份样本编号
                  </Typography>
                </Box>
                <Button
                  size="small"
                  color="error"
                  startIcon={<DeleteOutlineIcon />}
                  onClick={() => {
                    void deleteSnapshot(snap.id);
                    notify(`已删除清单「${snap.label}」`);
                  }}
                >
                  删除
                </Button>
              </Stack>

              {snap.items.length === 0 ? (
                <Alert severity="info" sx={{ mt: 1.5 }}>
                  清单为空。
                </Alert>
              ) : (
                <Stack spacing={0.75} sx={{ mt: 1.5 }}>
                  {snap.items.map((it) => {
                    const cur = sampleMap.get(it.sampleId);
                    const changed = !!cur && cur.sampleNo !== it.sampleNo;
                    return (
                      <Stack
                        key={it.sampleId}
                        direction="row"
                        spacing={1}
                        alignItems="center"
                        flexWrap="wrap"
                        useFlexGap
                        sx={{
                          px: 1.25,
                          py: 0.75,
                          border: '1px solid',
                          borderColor: 'divider',
                          borderRadius: 1.5,
                        }}
                      >
                        <Typography variant="body2" sx={{ fontFamily: 'monospace' }}>
                          {it.sampleNo}
                        </Typography>
                        {changed ? (
                          <Chip size="small" color="primary" variant="outlined" label={`现号 ${cur?.sampleNo}`} />
                        ) : null}
                        {cur ? (
                          <Typography
                            component={RouterLink}
                            to={`/samples/${cur.id}`}
                            variant="caption"
                            sx={{ color: 'primary.main', textDecoration: 'none' }}
                          >
                            查看档案 ↗
                          </Typography>
                        ) : (
                          <Chip size="small" label="档案已删除" />
                        )}
                      </Stack>
                    );
                  })}
                </Stack>
              )}
            </Paper>
          ))}
        </Stack>
      )}
    </Stack>
  );
}
