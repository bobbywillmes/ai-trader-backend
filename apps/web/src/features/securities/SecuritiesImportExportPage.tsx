import { useState } from 'react';
import { Alert, Button, Card, Checkbox, FileInput, Group, Select, Stack, Table, Text, TextInput, Title } from '@mantine/core';
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
  const [scheduled, setScheduled] = useState(false);
  const [scheduledDate, setScheduledDate] = useState('');
  const [mode, setMode] = useState<ImportMode>('partial');
  const [preview, setPreview] = useState<{ input: ImportInput; filename: string; plan: ImportPlan } | null>(null);
  const [freezePreview, setFreezePreview] = useState<FreezePlan | null>(null);
  const [membershipChanged, setMembershipChanged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  async function run(action: () => Promise<void>) { setBusy(true); setError(''); try { await action(); } catch (cause) { setError(cause instanceof Error ? cause.message : 'Request failed.'); } finally { setBusy(false); } }
  function clearPreview() { setPreview(null); setFreezePreview(null); setMembershipChanged(false); }
  const nyToday = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const invalidScheduledDate = scheduled && (!scheduledDate || scheduledDate <= nyToday);
  async function doPreview() { if (!file || invalidScheduledDate) return; await run(async () => { const input: ImportInput = { csv: await file.text(), timing: scheduled ? { kind: 'scheduled', membershipEffectiveDate: scheduledDate } : { kind: 'immediate' }, mode }; setPreview({ input, filename: file.name, plan: await requestImport(input, false) }); setMessage(''); }); }
  async function doApply() { if (!preview) return; await run(async () => { const plan = await requestImport(preview.input, true); setPreview({ ...preview, plan }); setMembershipChanged(plan.timing.kind === 'immediate' && plan.breadthMembershipChanged); setMessage(plan.timing.kind === 'scheduled' ? 'Import applied. Membership changes are scheduled.' : 'Import applied.'); await queryClient.invalidateQueries({ queryKey: ['securities'] }); await queryClient.invalidateQueries({ queryKey: ['securitiesSummary'] }); }); }
  return <main><Stack gap="lg"><div><Text component={Link} to="/securities" size="sm">Securities</Text><Text span size="sm"> › Import / Export</Text><Title order={2}>Import / Export Securities</Title></div>
    <Card withBorder><Stack><Title order={3}>Import</Title><Text size="sm">Partial update changes only supplied rows and nonblank cells. Snapshot reconciliation removes omitted Securities from each universe column included in the file. Metadata always updates only from nonblank supplied cells.</Text>
      <FileInput label="CSV file" accept=".csv,text/csv" value={file} onChange={(value) => { setFile(value); clearPreview(); }} />
      <Select label="Mode" value={mode} data={[{ value: 'partial', label: 'Partial update' }, { value: 'snapshot', label: 'Snapshot reconciliation' }]} onChange={(value) => { setMode(value as ImportMode); clearPreview(); }} />
      <details><summary style={{ cursor: 'pointer', fontWeight: 600 }}>Advanced options</summary><Stack gap="sm" mt="sm">
        <Checkbox label="Schedule universe membership changes for a future date" checked={scheduled} onChange={(event) => { setScheduled(event.currentTarget.checked); clearPreview(); }} />
        {scheduled && <><TextInput label="Membership effective date" type="date" value={scheduledDate} onChange={(event) => { setScheduledDate(event.currentTarget.value); clearPreview(); }} error={invalidScheduledDate ? `Choose a date after today's America/New_York date (${nyToday}).` : undefined} />
          <Text size="sm" c="dimmed">Use this for announced index changes that take effect on a future date. Security records and nonblank metadata are applied immediately, but universe membership changes do not take effect until the selected date. Until then, the current universe and Universe Snapshot remain unchanged. This does not enable trading or schedule any trading action.</Text></>}
      </Stack></details>
      {mode === 'snapshot' && <Alert color="orange">Omitting a Security from the CSV removes it from every universe column included in the header. Review the removal table before applying.</Alert>}
      <Group><Button onClick={doPreview} loading={busy} disabled={!file || invalidScheduledDate}>Preview</Button><Button color="red" onClick={doApply} loading={busy} disabled={!preview || preview.plan.applied || preview.plan.conflicts.length > 0}>Apply reviewed import</Button></Group>
      {error && <Alert color="red">{error}</Alert>}{message && <Alert color="green">{message}</Alert>}
      {preview && <Stack><SecuritiesImportSummary filename={preview.filename} plan={preview.plan} />
        <ChangeTable title="New Securities" rows={preview.plan.newSecurities} /><ChangeTable title="Metadata changes" rows={preview.plan.metadataChanges} /><ChangeTable title="Membership additions" rows={[...preview.plan.membershipAdditions, ...preview.plan.membershipReopens]} /><ChangeTable title="Membership removals" rows={[...preview.plan.membershipRemovals, ...preview.plan.membershipDeletions]} />
      </Stack>}
      {membershipChanged && preview && <Stack><Alert color="blue">Universe membership changed. A Breadth universe revision is available.</Alert><Group><Button variant="default" loading={busy} onClick={() => run(async () => { setFreezePreview(await requestFreeze(preview.plan.effectiveDate, false)); })}>Preview Breadth Revision</Button><Button loading={busy} disabled={!freezePreview || freezePreview.alreadyExists} onClick={() => run(async () => { const result = await requestFreeze(preview.plan.effectiveDate, true); setFreezePreview(result); setMessage('Breadth revision frozen.'); })}>Freeze Breadth Revision</Button></Group>{freezePreview && <Text size="sm">{freezePreview.memberCount} members · {freezePreview.constituentHash}</Text>}</Stack>}
    </Stack></Card>
    <Card withBorder><Stack><Title order={3}>Export</Title><Group><Button variant="default" onClick={() => run(() => downloadSecurityCsv('universe-snapshot'))}>Export Universe Snapshot</Button><Button variant="default" onClick={() => run(() => downloadSecurityCsv('security-catalog'))}>Export Security Catalog</Button></Group></Stack></Card>
  </Stack></main>;
}
