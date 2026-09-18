import { Alert, Anchor, Button, Card, Group, Modal, NativeSelect, Stack, Table, Text, TextInput, Title } from '@mantine/core';
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useCalendar, useDeleteCalendar, useSaveCalendar } from './hooks';
import type { CalendarException, CalendarInput } from './types';
import { DataState } from '../../components/data-display';

const clock = (minutes: number | null) => minutes === null ? '' : `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
const blank = (): CalendarInput => ({ sessionDate: '', name: '', type: 'CLOSED', closeTimeMinutesEt: null });
export function MarketCalendarPage() {
  const [params, setParams] = useSearchParams();
  const requestedYear = Number(params.get('year')); const currentYear = new Date().getFullYear();
  const year = requestedYear >= 2000 && requestedYear <= 2100 ? requestedYear : currentYear;
  const query = useCalendar(year), save = useSaveCalendar(), remove = useDeleteCalendar();
  const [editing, setEditing] = useState<number | 'new' | null>(null); const [input, setInput] = useState<CalendarInput>(blank);
  const [deleting, setDeleting] = useState<CalendarException | null>(null);
  const open = (row?: CalendarException) => { save.reset(); setInput(row ? { sessionDate: row.sessionDate.slice(0,10), name: row.name, type: row.type, closeTimeMinutesEt: row.closeTimeMinutesEt } : blank()); setEditing(row?.id ?? 'new'); };
  return <main><Stack gap="lg">
    <Group justify="space-between"><div><Title order={1}>Market Calendar</Title><Text c="dimmed">US equity session exceptions · America/New_York (Eastern Time)</Text></div><Button onClick={() => open()}>Add exception</Button></Group>
    <Alert color="blue">Normal sessions are 09:30–16:00 Eastern Time. Weekends are closed automatically. Enter holidays and early closes manually from the <Anchor href="https://www.nyse.com/trade/hours-calendars" target="_blank" rel="noopener noreferrer">official NYSE holidays and trading hours</Anchor>. No holidays are imported automatically.</Alert>
    <NativeSelect label="Calendar year" value={year} onChange={e=>setParams({year:e.currentTarget.value})} data={Array.from({length:101},(_,i)=>String(2000+i))} maw={220}/>
    {query.isLoading ? <DataState state="loading" message="Loading calendar…"/> : query.error ? <DataState state="error" title="Calendar unavailable" message={query.error.message} onRetry={()=>void query.refetch()}/> : !query.data?.length ? <DataState state="empty" title={`No exceptions entered for ${year}`} message="Weekdays default to normal sessions. Add the year's exchange holidays and early closes."/> :
      <Card withBorder><Table.ScrollContainer minWidth={560}><Table captionSide="bottom"><Table.Caption>All times are Eastern Time; daylight saving time is handled automatically.</Table.Caption><Table.Thead><Table.Tr><Table.Th>Date</Table.Th><Table.Th>Name</Table.Th><Table.Th>Session</Table.Th><Table.Th>Close (ET)</Table.Th><Table.Th>Actions</Table.Th></Table.Tr></Table.Thead><Table.Tbody>{query.data.map(row=><Table.Tr key={row.id}><Table.Td>{row.sessionDate.slice(0,10)}</Table.Td><Table.Td>{row.name}</Table.Td><Table.Td>{row.type==='CLOSED'?'Closed':'Early close'}</Table.Td><Table.Td>{row.type==='CLOSED'?'—':clock(row.closeTimeMinutesEt)}</Table.Td><Table.Td><Group gap="xs" wrap="nowrap"><Button size="compact-sm" variant="default" onClick={()=>open(row)} aria-label={`Edit ${row.name}`}>Edit</Button><Button size="compact-sm" color="red" variant="subtle" onClick={()=>{remove.reset();setDeleting(row);}} aria-label={`Delete ${row.name}`}>Delete</Button></Group></Table.Td></Table.Tr>)}</Table.Tbody></Table></Table.ScrollContainer></Card>}
    <Modal opened={editing!==null} onClose={()=>setEditing(null)} title={editing==='new'?'Add calendar exception':'Edit calendar exception'}>
      <form onSubmit={e=>{e.preventDefault();save.mutate({input,...(typeof editing==='number'?{id:editing}:{})},{onSuccess:()=>setEditing(null)});}}><Stack>
        <TextInput required type="date" label="Session date" value={input.sessionDate} onChange={e=>setInput({...input,sessionDate:e.currentTarget.value})}/>
        <TextInput required maxLength={160} label="Name" value={input.name} onChange={e=>setInput({...input,name:e.currentTarget.value})}/>
        <NativeSelect label="Session type" value={input.type} data={[{value:'CLOSED',label:'Closed'},{value:'EARLY_CLOSE',label:'Early close'}]} onChange={e=>{const type=e.currentTarget.value as CalendarInput['type'];setInput({...input,type,closeTimeMinutesEt:type==='CLOSED'?null:780});}}/>
        {input.type==='EARLY_CLOSE'&&<TextInput required type="time" label="Early close (Eastern Time)" min="09:31" max="15:59" value={clock(input.closeTimeMinutesEt)} onChange={e=>{const parts=e.currentTarget.value.split(':').map(Number);setInput({...input,closeTimeMinutesEt:parts.length===2?parts[0]*60+parts[1]:null});}}/>}
        {save.error&&<Alert color="red">{save.error.message}</Alert>}<Button type="submit" loading={save.isPending}>Save exception</Button>
      </Stack></form>
    </Modal>
    <Modal opened={deleting!==null} onClose={()=>setDeleting(null)} title="Delete calendar exception"><Stack><Text>Remove {deleting?.name} on {deleting?.sessionDate.slice(0,10)}? This date will use the normal weekday/weekend schedule.</Text>{remove.error&&<Alert color="red">{remove.error.message}</Alert>}<Button color="red" loading={remove.isPending} onClick={()=>{if(deleting)remove.mutate(deleting.id,{onSuccess:()=>setDeleting(null)});}}>Delete exception</Button></Stack></Modal>
  </Stack></main>;
}
