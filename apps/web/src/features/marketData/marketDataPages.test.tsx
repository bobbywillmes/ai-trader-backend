// @vitest-environment happy-dom
import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { day, lab, marketStatus } from './fixtures.test-support';
const mocks=vi.hoisted(()=>({request:vi.fn(),owner:true}));
vi.mock('../../lib/api',()=>({apiRequest:mocks.request,getAdminToken:()=> 'test-token'}));
vi.mock('../auth/useAuth',()=>({useIsSystemOwner:()=>mocks.owner}));
vi.mock('./TrendEvidenceChart',()=>({TrendEvidenceChart:({onSelect}:{onSelect:(date:string)=>void})=><button onClick={()=>onSelect('2026-09-14')}>Select September 14 candle</button>}));
import { MarketCalendarPage } from './MarketCalendarPage';
import { TrendLabPage } from './TrendLabPage';
let client:QueryClient;
let calendar=[{id:1,sessionDate:'2026-11-27T00:00:00.000Z',name:'Thanksgiving Friday',type:'EARLY_CLOSE',closeTimeMinutesEt:780}];
function Location(){return <output aria-label="Current query">{useLocation().search}</output>;}
function mount(page:'calendar'|'lab',width=1400){Object.defineProperty(window,'innerWidth',{value:width,configurable:true});client=new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}});return render(<MantineProvider env="test"><QueryClientProvider client={client}><MemoryRouter initialEntries={[page==='calendar'?'/system/market-calendar?year=2026':'/system/trend-lab?from=2026-09-14&to=2026-09-15']}>
  {page==='calendar'?<MarketCalendarPage/>:<TrendLabPage/>}<Location/>
</MemoryRouter></QueryClientProvider></MantineProvider>);}
beforeEach(()=>{vi.clearAllMocks();mocks.owner=true;calendar=[{id:1,sessionDate:'2026-11-27T00:00:00.000Z',name:'Thanksgiving Friday',type:'EARLY_CLOSE',closeTimeMinutesEt:780}];mocks.request.mockImplementation(async(path:string,options:{method?:string;body?:Record<string,unknown>}={})=>{
  if(path.includes('/trend-lab/day?')){const p=new URL(path,'https://test').searchParams;return day(p.get('date')!,p.get('profile') as 'MIDDLE');}
  if(path.includes('/trend-lab?'))return lab;
  if(path.endsWith('/status'))return marketStatus;
  if(path.endsWith('/backfill'))return {results:[{symbol:'SPY',inserted:1},{symbol:'RSP',inserted:1}]};
  if(options.method==='DELETE'){calendar=[];return null;}
  if(options.method==='PUT'||options.method==='POST'){calendar=[{...calendar[0],...options.body,id:1}];return calendar[0];}
  if(path.includes('/calendar?'))return calendar;
  throw new Error(`Unexpected request ${path}`);
});});
afterEach(()=>{cleanup();client?.clear();});
describe('market calendar operator UI',()=>{
  it('shows Eastern times and official manual reference with a year filter',async()=>{
    mount('calendar');expect(await screen.findByText('Thanksgiving Friday')).toBeTruthy();expect(screen.getByText('13:00')).toBeTruthy();
    expect(screen.getByRole('link',{name:/official NYSE/}).getAttribute('href')).toBe('https://www.nyse.com/trade/hours-calendars');
    fireEvent.change(screen.getByLabelText('Calendar year'),{target:{value:'2027'}});await waitFor(()=>expect(mocks.request).toHaveBeenCalledWith('/api/market-data/calendar?year=2027',expect.anything()));
  });
  it('creates an early-close exception with Eastern minutes',async()=>{
    mount('calendar');fireEvent.click(screen.getByRole('button',{name:'Add exception'}));
    fireEvent.change(await screen.findByLabelText(/Session date/),{target:{value:'2026-12-24'}});fireEvent.change(screen.getByLabelText(/^Name/),{target:{value:'Christmas Eve'}});fireEvent.change(screen.getByLabelText('Session type'),{target:{value:'EARLY_CLOSE'}});
    expect((screen.getByLabelText(/Early close \(Eastern Time\)/) as HTMLInputElement).value).toBe('13:00');fireEvent.click(screen.getByRole('button',{name:'Save exception'}));
    await waitFor(()=>expect(mocks.request).toHaveBeenCalledWith('/api/market-data/calendar',expect.objectContaining({method:'POST',body:{sessionDate:'2026-12-24',name:'Christmas Eve',type:'EARLY_CLOSE',closeTimeMinutesEt:780}})));
  });
  it('edits and explicitly deletes a calendar exception',async()=>{
    mount('calendar');fireEvent.click(await screen.findByRole('button',{name:'Edit Thanksgiving Friday'}));fireEvent.change(await screen.findByLabelText('Session type'),{target:{value:'CLOSED'}});fireEvent.click(screen.getByRole('button',{name:'Save exception'}));
    await waitFor(()=>expect(mocks.request).toHaveBeenCalledWith('/api/market-data/calendar/1',expect.objectContaining({method:'PUT',body:expect.objectContaining({type:'CLOSED',closeTimeMinutesEt:null})})));
    fireEvent.click(await screen.findByRole('button',{name:'Delete Thanksgiving Friday'}));fireEvent.click(await screen.findByRole('button',{name:'Delete exception'}));await waitFor(()=>expect(mocks.request).toHaveBeenCalledWith('/api/market-data/calendar/1',expect.objectContaining({method:'DELETE'})));
  });
  it('keeps failed form edits visible',async()=>{
    mount('calendar');fireEvent.click(await screen.findByRole('button',{name:'Edit Thanksgiving Friday'}));mocks.request.mockRejectedValueOnce(new Error('Date already exists'));fireEvent.click(await screen.findByRole('button',{name:'Save exception'}));expect(await screen.findByText('Date already exists')).toBeTruthy();expect(screen.getByLabelText(/^Name/)).toBeTruthy();
  });
});
describe('Trend Lab evidence UI',()=>{
  it('shows comparison, both instruments, thresholds and human-readable hysteresis',async()=>{
    mount('lab');expect(await screen.findByText('SPY is UP; RSP is NEUTRAL. Equal-weight confirmation is incomplete.')).toBeTruthy();expect(screen.getAllByText('Measurement 1')).toHaveLength(2);expect(screen.getAllByText('Neutral ± (%)')).toHaveLength(6);expect(screen.getByText('Two valid daily assessments support at least NEUTRAL; recover one state and reset confirmation.')).toBeTruthy();expect(screen.getByText(/Supporting count: 2\/2/)).toBeTruthy();
  });
  it('changes profile and selected date through URL-backed controls',async()=>{
    mount('lab');fireEvent.click(await screen.findByRole('button',{name:'Loose'}));await waitFor(()=>expect(mocks.request.mock.calls.some(([path])=>path.includes('profile=LOOSE'))).toBe(true));
    fireEvent.click(screen.getByRole('button',{name:'Select September 14 candle'}));await waitFor(()=>expect(screen.getByLabelText('Current query').textContent).toContain('date=2026-09-14'));await waitFor(()=>expect(mocks.request.mock.calls.some(([path])=>path.includes('date=2026-09-14')&&path.includes('profile=LOOSE'))).toBe(true));
  });
  it('hides owner backfill from operators',async()=>{mocks.owner=false;mount('lab');await screen.findByText('SPY is UP; RSP is NEUTRAL. Equal-weight confirmation is incomplete.');expect(screen.queryByText('Owner historical backfill')).toBeNull();});
  it('shows source coverage and split semantics without requiring raw JSON',async()=>{
    mount('lab');fireEvent.click(await screen.findByRole('button',{name:'Source bars and split normalization'}));expect(await screen.findAllByText(/No split events returned/)).toHaveLength(2);expect(screen.getAllByText(/recommended 250/)).toHaveLength(2);
  });
  it.each([390,768])('keeps chart selection and evidence usable at %s px',async width=>{mount('lab',width);fireEvent.click(await screen.findByRole('button',{name:'Select September 14 candle'}));expect(await screen.findByText('2026-09-14 · MIDDLE explanation')).toBeTruthy();expect(screen.getAllByText('Measurement 9')).toHaveLength(2);});
  it('reports expired snapshots instead of silently changing evidence',async()=>{
    const original=mocks.request.getMockImplementation()!;mocks.request.mockImplementation((path,options)=>path.includes('/trend-lab/day?')?Promise.reject(new Error('Research snapshot expired.')):original(path,options));mount('lab');expect(await screen.findByText('Research snapshot expired.')).toBeTruthy();expect(screen.getByRole('button',{name:'Refresh research snapshot'})).toBeTruthy();
  });
});
