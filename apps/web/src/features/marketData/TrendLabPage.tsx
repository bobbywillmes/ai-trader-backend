import { Accordion, Alert, Badge, Button, Card, Group, NativeSelect, SimpleGrid, Stack, Table, Text, TextInput, Title } from '@mantine/core';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useIsSystemOwner } from '../auth/useAuth';
import { DataState } from '../../components/data-display';
import { backfillMarketData } from './api';
import { useMarketDataStatus, useRefreshTrendLab, useTrendDay, useTrendLab } from './hooks';
import { TrendEvidenceChart } from './TrendEvidenceChart';
import type { InstrumentEvidence, TrendProfile, TrendState } from './types';

const profiles: TrendProfile[] = ['TIGHT','MIDDLE','LOOSE'];
const stateColor = (state: TrendState | null) => state==='UP'?'teal':state==='DOWN'?'red':'gray';
function State({state}: {state:TrendState|null}) {return <Badge color={stateColor(state)}>{state??'Unavailable'}</Badge>;}
const number = (value:number|null) => value===null?'—':value.toLocaleString(undefined,{maximumFractionDigits:4});
const todayEt = () => new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
function Instrument({symbol,evidence}: {symbol:string;evidence:InstrumentEvidence}) {
  return <Card withBorder style={{minWidth:0}}><Stack gap="sm"><Group justify="space-between"><Title order={3}>{symbol}</Title><State state={evidence.state}/></Group>
    <Text size="sm">{evidence.reason}</Text><Text size="xs" c="dimmed">EMA10 {number(evidence.ema10)} · EMA20 {number(evidence.ema20)} · EMA50 {number(evidence.ema50)}</Text>
    {evidence.horizons&&Object.entries(evidence.horizons).map(([horizon,state])=><section key={horizon}><Group gap="xs" mb="xs"><Text fw={700}>{horizon.charAt(0)+horizon.slice(1).toLowerCase()}</Text><State state={state}/></Group>
      <Table.ScrollContainer minWidth={440}><Table fz="xs"><Table.Thead><Table.Tr><Table.Th>Measurement</Table.Th><Table.Th>Value (%)</Table.Th><Table.Th>Neutral ± (%)</Table.Th><Table.Th>Sign</Table.Th></Table.Tr></Table.Thead><Table.Tbody>{evidence.measurements.filter(m=>m.horizon===horizon).map(m=><Table.Tr key={m.key}><Table.Td>{m.label}</Table.Td><Table.Td>{number(m.value)}</Table.Td><Table.Td>{number(m.deadband)}</Table.Td><Table.Td>{m.classification}</Table.Td></Table.Tr>)}</Table.Tbody></Table></Table.ScrollContainer>
    </section>)}<Text size="xs" c="dimmed">Boundary equality is neutral. Two positive or two negative measurements determine a horizon; otherwise it is neutral.</Text>
  </Stack></Card>;
}
function DataStatus() {
  const query=useMarketDataStatus();const owner=useIsSystemOwner();const client=useQueryClient();
  const [from,setFrom]=useState<string|null>(null);const [to,setTo]=useState(todayEt);const [progress,setProgress]=useState('');
  const backfill=useMutation({mutationFn:async()=>{
    let cursor=from??query.data!.dataStart;let inserted=0;
    if(!cursor||cursor>to||to>todayEt())throw new Error('Choose a valid historical range ending on or before today.');
    while(cursor<=to){const endDate=new Date(`${cursor}T00:00:00Z`);endDate.setUTCDate(endDate.getUTCDate()+query.data!.maxBackfillDays-1);const end=[endDate.toISOString().slice(0,10),to].sort()[0];setProgress(`Fetching ${cursor} through ${end}…`);const result=await backfillMarketData(cursor,end);inserted+=result.results.reduce((sum,x)=>sum+x.inserted,0);const next=new Date(`${end}T00:00:00Z`);next.setUTCDate(next.getUTCDate()+1);cursor=next.toISOString().slice(0,10);await client.invalidateQueries({queryKey:['market-data-status']});}
    setProgress(`Completed: ${inserted.toLocaleString()} new bars inserted. Existing bars were preserved.`);
  },onSettled:()=>{void client.invalidateQueries({queryKey:['market-data-status']});}});
  return <Card withBorder><Stack><Title order={2} size="h4">Stored market data</Title>
    {query.error&&<Alert color="red">{query.error.message}</Alert>}
    <SimpleGrid cols={{base:1,sm:2}}>{query.data?.symbols.map(s=><section key={s.symbol}><Text fw={700}>{s.symbol} · {s.count.toLocaleString()} daily bars</Text><Text size="sm">{s.earliest??'No history'} → {s.latest??'No history'}</Text>{s.securityId===null&&<Text c="red">Create the existing-catalog Security before ingestion.</Text>}{s.missing.length>0&&<Text c="red" size="sm">{s.missing.length} eligible bars missing: {s.missing.slice(0,5).join(', ')}</Text>}{s.notYetEligible.length>0&&<Text size="sm" c="dimmed">Not yet eligible: {s.notYetEligible.join(', ')}</Text>}</section>)}</SimpleGrid>
    <Text size="xs" c="dimmed">Unadjusted Massive evidence · Daily ingestion waits 30 minutes after expected session close. Operational gap checks begin {query.data?.operationalFrom??'when synchronization starts'}.</Text>
    {query.data?.sync&&<Text size="xs">Last sync: {query.data.sync.lastResult} · {query.data.sync.lastAttemptAt?new Date(query.data.sync.lastAttemptAt).toLocaleString():'Not run'}</Text>}
    {owner&&query.data&&<Accordion><Accordion.Item value="backfill"><Accordion.Control>Owner historical backfill</Accordion.Control><Accordion.Panel><Stack>
      <Text size="sm">Requests run in bounded chunks. Massive subscription history limits may reject older ranges. Completed chunks remain stored; choose the supported start date to resume.</Text>
      <Group align="flex-end"><TextInput type="date" label="Backfill start" min={query.data.dataStart} value={from??query.data.dataStart} onChange={e=>setFrom(e.currentTarget.value)} disabled={backfill.isPending}/><TextInput type="date" label="Backfill end" max={todayEt()} value={to} onChange={e=>setTo(e.currentTarget.value)} disabled={backfill.isPending}/><Button loading={backfill.isPending} onClick={()=>backfill.mutate()}>Backfill SPY / RSP</Button></Group>
      {progress&&<Text role="status" size="sm">{progress}</Text>}{backfill.error&&<Alert color="red">{backfill.error.message}</Alert>}
    </Stack></Accordion.Panel></Accordion.Item></Accordion>}
    {query.data?.events[0]&&<Text size="xs" c="dimmed">Latest backfill event: {query.data.events[0].message} ({new Date(query.data.events[0].createdAt).toLocaleString()})</Text>}
  </Stack></Card>;
}
export function TrendLabPage() {
  const [params,setParams]=useSearchParams();const from=params.get('from')??`${new Date().getFullYear()-3}-01-01`;const to=params.get('to')??todayEt();
  const profile=profiles.includes(params.get('profile') as TrendProfile)?params.get('profile') as TrendProfile:'MIDDLE';
  const symbol=params.get('symbol')==='RSP'?'RSP':'SPY';
  const [rangeFrom,setRangeFrom]=useState(from);const [rangeTo,setRangeTo]=useState(to);
  const query=useTrendLab(from,to);const status=useMarketDataStatus();const data=query.data;const timeline=data?.profiles[profile].timeline;
  const selected=params.get('date')??timeline?.at(-1)?.date;const detail=useTrendDay(data?.datasetId,profile,selected,from,to);
  const refresh=useRefreshTrendLab(from,to);
  const update=(values:Record<string,string>,clearDate=false)=>{const next=new URLSearchParams(params);Object.entries(values).forEach(([key,value])=>next.set(key,value));if(clearDate)next.delete('date');setParams(next);};
  const selectedSeries=data?.series.find(s=>s.symbol===symbol);const index=timeline?.findIndex(day=>day.date===selected)??-1;
  return <main style={{minWidth:0}}><Stack gap="lg">
    <Group justify="space-between"><div><Title order={1}>Trend Calibration Lab</Title><Text c="dimmed">SPY + RSP · Daily structural Trend · Three research candidates</Text></div><Badge color="violet" size="lg">Research only</Badge></Group>
    <DataStatus/>
    <Card withBorder><form onSubmit={e=>{e.preventDefault();update({from:rangeFrom,to:rangeTo},true);}}><Group align="flex-end"><TextInput type="date" required label="Research start" value={rangeFrom} min={status.data?.researchStart} max={rangeTo} onChange={e=>setRangeFrom(e.currentTarget.value)}/><TextInput type="date" required label="Research end" value={rangeTo} min={rangeFrom} max={todayEt()} onChange={e=>setRangeTo(e.currentTarget.value)}/><Button type="submit">Apply range</Button><Button variant="default" onClick={()=>refresh.mutate()} loading={query.isFetching||refresh.isPending}>Refresh research</Button></Group></form></Card>
    {refresh.error&&<Alert color="red" title="Research refresh failed">{refresh.error.message}</Alert>}
    {query.isLoading&&<DataState state="loading" message="Reading stored bars and Massive split evidence…"/>}{query.error&&<DataState state="error" title="Trend research unavailable" message={query.error.message} onRetry={()=>void query.refetch()}/>}
    {data&&<>
      <Alert color="blue"><Stack gap={4}>{data.warnings.map(w=><Text key={w} size="sm">{w}</Text>)}</Stack></Alert>
      <SimpleGrid cols={{base:1,sm:3}}>{profiles.map(p=>{const summary=data.profiles[p].summary;return <Card key={p} withBorder style={{borderColor:p===profile?'var(--mantine-color-blue-5)':undefined}}><Stack gap="xs"><Button variant={p===profile?'filled':'light'} onClick={()=>update({profile:p})} aria-pressed={p===profile}>{p.charAt(0)+p.slice(1).toLowerCase()}</Button><Group gap="xs">{(['UP','NEUTRAL','DOWN'] as const).map(state=><Badge key={state} variant="light" color={stateColor(state)}>{state} {summary.statePercentages[state].toFixed(1)}%</Badge>)}</Group><Text size="sm">Transitions: <b>{summary.transitions}</b> · {summary.annualizedTransitions.toFixed(1)} per 252 valid sessions</Text><Text size="sm">Median run: <b>{summary.medianRunDuration??'—'}</b> valid sessions</Text><Text size="sm">One-day runs: <b>{summary.oneDayRuns}</b> · ≤2 days: <b>{summary.twoDayOrShorterRuns}</b></Text><Text size="xs" c="dimmed">{summary.validDays} valid / {summary.unavailableDays} unavailable known sessions</Text><Accordion><Accordion.Item value="years"><Accordion.Control>Transitions by year</Accordion.Control><Accordion.Panel>{Object.entries(summary.transitionsPerYear).map(([year,count])=><Text key={year} size="sm">{year}: {count}</Text>)}<Text size="xs" c="dimmed">{summary.runDefinition}</Text></Accordion.Panel></Accordion.Item></Accordion></Stack></Card>;})}</SimpleGrid>
      <Card withBorder style={{minWidth:0}}><Stack><Group justify="space-between"><div><Title order={2} size="h4">{profile} · {symbol} evidence chart</Title><Text size="xs" c="dimmed">Click a candle to inspect both instruments. Markers show effective market Trend transitions.</Text></div><NativeSelect label="Chart instrument" value={symbol} data={['SPY','RSP']} onChange={e=>update({symbol:e.currentTarget.value})}/></Group><Group gap="xs"><Badge color="blue" variant="dot">EMA10</Badge><Badge color="yellow" variant="dot">EMA20</Badge><Badge color="grape" variant="dot">EMA50</Badge><Text size="xs">Split-normalized to {to} · raw stored bars stay unadjusted</Text></Group>
        {selectedSeries?.bars.length&&timeline?<TrendEvidenceChart bars={selectedSeries.bars} timeline={timeline} onSelect={date=>update({date})}/>:<Text>No chart observations in this range.</Text>}
      </Stack></Card>
      <Group align="flex-end"><TextInput type="date" label="Evidence date" value={selected??''} min={from} max={to} onChange={e=>update({date:e.currentTarget.value})}/><Button variant="default" disabled={index<=0} onClick={()=>update({date:timeline![index-1].date})}>Previous session</Button><Button variant="default" disabled={index<0||index>=(timeline?.length??0)-1} onClick={()=>update({date:timeline![index+1].date})}>Next session</Button></Group>
      {detail.isFetching&&<Text size="sm">Loading date evidence…</Text>}{detail.error&&<Alert color="red" title="Date evidence unavailable">{detail.error.message}<Button size="xs" variant="subtle" onClick={()=>refresh.mutate()}>Refresh research snapshot</Button></Alert>}
      {detail.data&&<Stack><Card withBorder><Stack gap="xs"><Title order={2} size="h4">{detail.data.date} · {profile} explanation</Title><Group><Text>Raw market Trend</Text><State state={detail.data.rawState}/><Text>Effective Trend</Text><State state={detail.data.effectiveState}/></Group><Text>{detail.data.marketReason}</Text><Text fw={600}>{detail.data.transition.reason}</Text><Text size="sm">Previous effective: {detail.data.transition.previousEffectiveState??'None (bootstrap)'} · Confirmation before: {detail.data.transition.confirmationBefore}/2 · Supporting count: {detail.data.transition.supportingCount}/2 · Carried confirmation: {detail.data.transition.recoveryConfirmation}/2</Text></Stack></Card>
        <SimpleGrid cols={{base:1,xl:2}}><Instrument symbol="SPY" evidence={detail.data.spy}/><Instrument symbol="RSP" evidence={detail.data.rsp}/></SimpleGrid>
      </Stack>}
      <Accordion variant="contained"><Accordion.Item value="sources"><Accordion.Control>Source bars and split normalization</Accordion.Control><Accordion.Panel><Stack>{data.series.map(s=><section key={s.symbol}><Text fw={700}>{s.symbol}: {s.source.count} input bars · {s.source.earliest??'None'} → {s.source.dataThrough??'None'}</Text><Text size="sm">Pre-roll: {s.source.preRollSessions} sessions before display start (recommended {data.preRollRequired}).</Text>{s.splits.length?s.splits.map(split=><Text key={split.id} size="sm">{split.executionDate}: {split.splitFrom} old → {split.splitTo} new shares. Earlier OHLC multiplied by {split.priceFactor}; volume divided by that factor.</Text>):<Text size="sm">No split events returned in the input range. Prices are not dividend-adjusted.</Text>}</section>)}</Stack></Accordion.Panel></Accordion.Item><Accordion.Item value="raw"><Accordion.Control>Raw diagnostics</Accordion.Control><Accordion.Panel><Text size="xs" style={{overflowWrap:'anywhere'}}>Dataset: {data.datasetId} · Evidence schema {data.evidenceSchemaVersion} · Generated {data.generatedAt}</Text><pre style={{maxHeight:300,overflow:'auto',fontSize:11}}>{JSON.stringify(detail.data??null,null,2)}</pre></Accordion.Panel></Accordion.Item></Accordion>
    </>}
  </Stack></main>;
}
