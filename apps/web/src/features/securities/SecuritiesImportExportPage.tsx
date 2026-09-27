import { useState } from 'react';
import { Alert, Button, Card, FileInput, Group, Select, Stack, Table, Text, TextInput, Title } from '@mantine/core';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { downloadSecurityCsv, requestFreeze, requestImport, type FreezePlan, type ImportInput, type ImportMode, type ImportPlan } from './universeApi';
import { SecuritiesImportSummary } from './SecuritiesImportSummary';

function ChangeTable({ title, rows }: { title: string; rows: { symbol: string; code?: string; before?: Record<string, string | null>; after?: Record<string, string | null> }[] }) {
  return <Card withBorder radius="md" p="sm"><details open={rows.length > 0 && rows.length < 20}><summary style={{ cursor: 'pointer', fontWeight: 600 }}>{title} ({rows.length})</summary><div style={{ maxHeight: 400, overflow: 'auto' }}><Table striped><Table.Thead><Table.Tr><Table.Th>Symbol</Table.Th><Table.Th>Universe / change</Table.Th></Table.Tr></Table.Thead><Table.Tbody>{rows.map((row, index) => <Table.Tr key={`${row.symbol}-${row.code ?? index}`}><Table.Td>{row.symbol}</Table.Td><Table.Td>{row.code ?? `${JSON.stringify(row.before)} → ${JSON.stringify(row.after)}`}</Table.Td></Table.Tr>)}</Table.Tbody></Table></div></details></Card>;
}

export function SecuritiesImportExportPage() {
  const queryClient = useQueryClient();
  const [file, setFile] = useState<File | null>(null);
  const [effectiveDate, setEffectiveDate] = useState('');
  const [mode, setMode] = useState<ImportMode>('partial');
  const [preview, setPreview] = useState<{ input: ImportInput; filename: string; plan: ImportPlan } | null>(null);
  const [freezePreview, setFreezePreview] = useState<FreezePlan | null>(null);
  const [membershipChanged, setMembershipChanged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  async function run(action: () => Promise<void>) { setBusy(true); setError(''); try { await action(); } catch (cause) { setError(cause instanceof Error ? cause.message : 'Request failed.'); } finally { setBusy(false); } }
  function clearPreview() { setPreview(null); setFreezePreview(null); setMembershipChanged(false); }
  async function doPreview() { if (!file || !effectiveDate) return; await run(async () => { const input = { csv: await file.text(), effectiveDate, mode }; setPreview({ input, filename: file.name, plan: await requestImport(input, false) }); setMessage(''); }); }
  async function doApply() { if (!preview) return; await run(async () => { const plan = await requestImport(preview.input, true); setPreview({ ...preview, plan }); setMembershipChanged(plan.breadthMembershipChanged); setMessage('Import applied.'); await queryClient.invalidateQueries({ queryKey: ['securities'] }); await queryClient.invalidateQueries({ queryKey: ['securitiesSummary'] }); }); }
  return <main><Stack gap="lg"><div><Text component={Link} to="/securities" size="sm">Securities</Text><Text span size="sm"> › Import / Export</Text><Title order={2}>Import / Export Securities</Title></div>
    <Card withBorder><Stack><Title order={3}>Import</Title><Text size="sm">Partial update changes only supplied rows and nonblank cells. Snapshot reconciliation removes omitted Securities from each universe column included in the file. Metadata always updates only from nonblank supplied cells.</Text>
      <FileInput label="CSV file" accept=".csv,text/csv" value={file} onChange={(value) => { setFile(value); clearPreview(); }} />
      <TextInput label="Effective date" type="date" value={effectiveDate} onChange={(event) => { setEffectiveDate(event.currentTarget.value); clearPreview(); }} />
      <Select label="Mode" value={mode} data={[{ value: 'partial', label: 'Partial update' }, { value: 'snapshot', label: 'Snapshot reconciliation' }]} onChange={(value) => { setMode(value as ImportMode); clearPreview(); }} />
      {mode === 'snapshot' && <Alert color="orange">Omitting a Security from the CSV removes it from every universe column included in the header. Review the removal table before applying.</Alert>}
      <Group><Button onClick={doPreview} loading={busy} disabled={!file || !effectiveDate}>Preview</Button><Button color="red" onClick={doApply} loading={busy} disabled={!preview || preview.plan.applied || preview.plan.conflicts.length > 0}>Apply reviewed import</Button></Group>
      {error && <Alert color="red">{error}</Alert>}{message && <Alert color="green">{message}</Alert>}
      {preview && <Stack><SecuritiesImportSummary filename={preview.filename} plan={preview.plan} />
        <ChangeTable title="New Securities" rows={preview.plan.newSecurities} /><ChangeTable title="Metadata changes" rows={preview.plan.metadataChanges} /><ChangeTable title="Membership additions" rows={preview.plan.membershipAdditions} /><ChangeTable title="Membership removals" rows={preview.plan.membershipRemovals} />
      </Stack>}
      {membershipChanged && preview && <Stack><Alert color="blue">Universe membership changed. A Breadth universe revision is available.</Alert><Group><Button variant="default" loading={busy} onClick={() => run(async () => { setFreezePreview(await requestFreeze(preview.input.effectiveDate, false)); })}>Preview Breadth Revision</Button><Button loading={busy} disabled={!freezePreview || freezePreview.alreadyExists} onClick={() => run(async () => { const result = await requestFreeze(preview.input.effectiveDate, true); setFreezePreview(result); setMessage('Breadth revision frozen.'); })}>Freeze Breadth Revision</Button></Group>{freezePreview && <Text size="sm">{freezePreview.memberCount} members · {freezePreview.constituentHash}</Text>}</Stack>}
    </Stack></Card>
    <Card withBorder><Stack><Title order={3}>Export</Title><Group><Button variant="default" onClick={() => run(() => downloadSecurityCsv('universe-snapshot'))}>Export Universe Snapshot</Button><Button variant="default" onClick={() => run(() => downloadSecurityCsv('security-catalog'))}>Export Security Catalog</Button></Group></Stack></Card>
  </Stack></main>;
}
