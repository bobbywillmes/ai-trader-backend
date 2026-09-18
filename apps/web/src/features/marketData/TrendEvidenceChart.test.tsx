// @vitest-environment happy-dom
import { MantineProvider } from '@mantine/core';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { lab } from './fixtures.test-support';
const mocks=vi.hoisted(()=>({create:vi.fn(),series:vi.fn(),markers:vi.fn(),click:vi.fn(),remove:vi.fn(),fit:vi.fn()}));
vi.mock('lightweight-charts',()=>({CandlestickSeries:'candles',LineSeries:'line',ColorType:{Solid:'solid'},createChart:mocks.create,createSeriesMarkers:mocks.markers}));
import { TrendEvidenceChart } from './TrendEvidenceChart';
afterEach(()=>{cleanup();vi.clearAllMocks();});
describe('Trend evidence chart integration',()=>{
  it('creates responsive candles/three EMA lines, transition markers and a date click handler; cleans up',()=>{
    mocks.series.mockReturnValue({setData:vi.fn()});mocks.create.mockReturnValue({addSeries:mocks.series,subscribeClick:mocks.click,timeScale:()=>({fitContent:mocks.fit}),remove:mocks.remove});const onSelect=vi.fn();
    const view=render(<MantineProvider><TrendEvidenceChart bars={lab.series[0].bars} timeline={lab.profiles.MIDDLE.timeline} onSelect={onSelect}/></MantineProvider>);
    expect(mocks.create.mock.calls[0][1]).toMatchObject({autoSize:true,handleScroll:{vertTouchDrag:false}});expect(mocks.series).toHaveBeenCalledTimes(4);expect(mocks.markers.mock.calls[0][1]).toMatchObject([{time:'2026-09-15',text:'UP',shape:'arrowUp'}]);
    mocks.click.mock.calls[0][0]({time:{year:2026,month:9,day:14}});expect(onSelect).toHaveBeenCalledWith('2026-09-14');view.unmount();expect(mocks.remove).toHaveBeenCalledTimes(1);
  });
});
