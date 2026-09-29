import { describe, expect, it } from 'vitest';
import { datesBetween, marketSession } from '../services/market-calendar.js';
import { bridgeCandidate, compareRawCloses, finalizeBreadth, missingRuns, type ResearchBar } from './breadth-v2-calculation.js';

const bars = (...rows: [string, string, string][]) => new Map<string, ResearchBar>(rows.map(([date, close, splitFactor]) => [date, { close, splitFactor }]));

describe('BREADTH_V2 strict research arithmetic', () => {
  it('uses market-session anchors across weekends and reviewed closures', () => {
    const sessions = datesBetween('2026-09-03', '2026-09-11').filter(date => marketSession(date, [{ sessionDate: '2026-09-07', type: 'CLOSED', closeTimeMinutesEt: null }]));
    expect(sessions).toEqual(['2026-09-03', '2026-09-04', '2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11']);
    expect(sessions[5 - 1]).toBe('2026-09-10');
    expect(sessions[5 - 5]).toBe('2026-09-03');
  });
  it('classifies advancing, declining and exact unchanged without a tolerance', () => {
    const sessions = ['2026-09-24', '2026-09-25'];
    expect(compareRawCloses(sessions, 0, 1, bars(['2026-09-24', '100', '1'], ['2026-09-25', '101', '1']))?.direction).toBe('ADVANCING');
    expect(compareRawCloses(sessions, 0, 1, bars(['2026-09-24', '100', '1'], ['2026-09-25', '99', '1']))?.direction).toBe('DECLINING');
    expect(compareRawCloses(sessions, 0, 1, bars(['2026-09-24', '100', '1'], ['2026-09-25', '100', '1']))?.direction).toBe('UNCHANGED');
  });
  it('normalizes one split, target split, reverse split, and multiple 5d/20d splits', () => {
    const sessions = Array.from({ length: 21 }, (_, i) => `d${i}`);
    expect(sessions[20 - 1]).toBe('d19');
    expect(sessions[20 - 5]).toBe('d15');
    expect(sessions[20 - 20]).toBe('d0');
    const one = bars(['d0', '100', '1'], ['d1', '50', '2']);
    expect(compareRawCloses(sessions, 0, 1, one)?.direction).toBe('UNCHANGED');
    const reverse = bars(['d0', '10', '1'], ['d1', '20', '0.5']);
    expect(compareRawCloses(sessions, 0, 1, reverse)?.direction).toBe('UNCHANGED');
    const series = new Map(sessions.map(date => [date, { close: '25', splitFactor: '1' }]));
    series.set('d0', { close: '100', splitFactor: '1' });
    series.set('d1', { close: '50', splitFactor: '2' });
    series.set('d16', { close: '50', splitFactor: '1' });
    series.set('d18', { close: '25', splitFactor: '2' });
    expect(compareRawCloses(sessions, 0, 20, series)?.direction).toBe('UNCHANGED');
    expect(compareRawCloses(sessions, 16, 20, series)?.direction).toBe('UNCHANGED');
  });
  it('requires real target, exact anchor and complete intervening split evidence', () => {
    const sessions = ['a', 'b', 'c'];
    expect(compareRawCloses(sessions, 0, 2, bars(['a', '100', '1'], ['c', '101', '1']))).toBeNull();
    expect(compareRawCloses(sessions, 0, 2, bars(['b', '100', '1'], ['c', '101', '1']))).toBeNull();
    expect(compareRawCloses(sessions, 0, 2, bars(['a', '100', '1'], ['b', '100', '1']))).toBeNull();
  });
  it('uses only real bars for one/two-gap exploratory candidates', () => {
    const sessions = ['a', 'b', 'c', 'd'];
    const one = bars(['a', '100', '1'], ['c', '101', '1'], ['d', '102', '1']);
    expect(bridgeCandidate(sessions, 1, 2, one, 1)).toMatchObject({ expectedAnchorSession: 'b', actualAnchorSession: 'a', targetSession: 'c', bridgedGapSessions: 1, splitEvidenceComplete: false });
    const two = bars(['a', '100', '1'], ['d', '103', '1']);
    expect(bridgeCandidate(sessions, 2, 3, two, 1)).toBeNull();
    expect(bridgeCandidate(sessions, 2, 3, two, 2)).toMatchObject({ actualAnchorSession: 'a', bridgedGapSessions: 2 });
    expect(bridgeCandidate(sessions, 1, 2, bars(['a', '100', '1']), 1)).toBeNull();
  });
  it('keeps unchanged eligible but outside the directional denominator', () => {
    expect(finalizeBreadth(4, 1, 1, 1)).toEqual({ universeCount: 4, eligibleCount: 3, excludedCount: 1, advancingCount: 1, decliningCount: 1, unchangedCount: 1, directionalCount: 2, advanceShare: 0.5, netBreadth: 0, coverageRatio: 0.75 });
    expect(finalizeBreadth(2, 0, 0, 1)).toMatchObject({ directionalCount: 0, advanceShare: null, netBreadth: null, coverageRatio: 0.5 });
  });
  it('groups missing expected sessions without inventing prices', () => {
    const sessions = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'];
    expect(missingRuns(sessions, bars(['a', '1', '1'], ['c', '1', '1'], ['g', '1', '1'], ['j', '1', '1']))).toEqual([
      { from: 'b', through: 'b', length: 1, bucket: 'ONE' },
      { from: 'd', through: 'f', length: 3, bucket: 'THREE_TO_FIVE' },
      { from: 'h', through: 'i', length: 2, bucket: 'TWO' },
    ]);
  });
});
