import { useEffect, useRef } from 'react';
import { useMantineColorScheme, useMantineTheme } from '@mantine/core';
import { CandlestickSeries, ColorType, createChart, createSeriesMarkers, LineSeries, type Time } from 'lightweight-charts';
import type { TrendBar, TrendTimeline } from './types';
function chartDate(time: Time): string {
  if (typeof time === 'string') return time;
  if (typeof time === 'number') return new Date(time*1000).toISOString().slice(0,10);
  return `${time.year}-${String(time.month).padStart(2,'0')}-${String(time.day).padStart(2,'0')}`;
}
export function TrendEvidenceChart({bars,timeline,onSelect}: {bars:TrendBar[];timeline:TrendTimeline[];onSelect:(date:string)=>void}) {
  const container = useRef<HTMLDivElement>(null); const callback = useRef(onSelect);
  const theme = useMantineTheme(); const { colorScheme } = useMantineColorScheme();
  useEffect(()=>{callback.current=onSelect;},[onSelect]);
  useEffect(()=>{
    if(!container.current||!bars.length)return;
    const chart=createChart(container.current,{autoSize:true,layout:{background:{type:ColorType.Solid,color:'transparent'},textColor:colorScheme==='dark'?theme.colors.gray[3]:theme.colors.gray[8]},timeScale:{timeVisible:false},handleScroll:{vertTouchDrag:false},height:370});
    const candles=chart.addSeries(CandlestickSeries); candles.setData(bars.map(bar=>({time:bar.date,open:bar.open,high:bar.high,low:bar.low,close:bar.close})));
    for(const [key,color] of [['ema10','#228be6'],['ema20','#f59f00'],['ema50','#be4bdb']] as const){const line=chart.addSeries(LineSeries,{color,lineWidth:2,title:key.toUpperCase(),priceLineVisible:false});line.setData(bars.filter(bar=>bar[key]!==null).map(bar=>({time:bar.date,value:bar[key]!})));}
    const dates=new Set(bars.map(bar=>bar.date));
    createSeriesMarkers(candles,timeline.filter(day=>day.transitioned&&day.status==='VALID'&&dates.has(day.date)).map(day=>({time:day.date,position:day.effectiveState==='UP'?'belowBar' as const:'aboveBar' as const,color:day.effectiveState==='UP'?'#12b886':day.effectiveState==='DOWN'?'#fa5252':'#868e96',shape:day.effectiveState==='UP'?'arrowUp' as const:day.effectiveState==='DOWN'?'arrowDown' as const:'circle' as const,text:day.effectiveState??'Unavailable'})));
    chart.subscribeClick(event=>{if(event.time)callback.current(chartDate(event.time));});chart.timeScale().fitContent();
    return()=>chart.remove();
  },[bars,timeline,colorScheme,theme.colors]);
  return <div ref={container} aria-label="Daily candles, EMA10, EMA20, EMA50 and effective Trend transitions" style={{height:370,minWidth:0,width:'100%'}}/>;
}
