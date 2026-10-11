import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks=vi.hoisted(()=>({process:vi.fn()}));
vi.mock('../services/order-intent-broker-comparison.service.js',()=>({processOrderIntentBrokerComparisons:mocks.process}));
import { runOrderIntentBrokerComparisonWorker } from './order-intent-broker-comparison.worker.js';
import { getWorkerDefinition } from './worker-health.definitions.js';

describe('broker comparison worker',()=>{
  beforeEach(()=>mocks.process.mockReset());
  it('is disabled by default',()=>expect(getWorkerDefinition('order_intent_broker_comparison').enabledByDefault).toBe(false));
  it('reports disabled database rollout',async()=>{mocks.process.mockResolvedValue({enabled:false,seeded:0,claimed:0,completed:0,retrying:0,terminalFailures:0});await expect(runOrderIntentBrokerComparisonWorker()).resolves.toMatchObject({outcome:'skipped',skipReason:'disabled'});});
  it('surfaces terminal failures',async()=>{mocks.process.mockResolvedValue({enabled:true,seeded:0,claimed:1,completed:0,retrying:0,terminalFailures:1});await expect(runOrderIntentBrokerComparisonWorker()).rejects.toThrow('TERMINAL_FAILURE:1');});
});
