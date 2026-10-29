import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { afterAll, describe, expect, it } from 'vitest';
import { listExternalSignalOperations } from '../../services/external-signal-operations.service.js';

const databaseUrl=process.env.DATABASE_URL;
const describeDatabase=process.env.RUN_DATABASE_INTEGRITY_TESTS==='1'&&databaseUrl?describe:describe.skip;

describeDatabase('external signal Operations full-schema queries',()=>{
  const db=new PrismaClient({adapter:new PrismaPg({connectionString:databaseUrl!})});
  afterAll(async()=>db.$disconnect());

  it('executes bounded filters and summaries against the complete migrated schema',async()=>{
    const result=await listExternalSignalOperations({page:1,pageSize:5,unresolvedExit:true},db);
    expect(result.cycles.length).toBeLessThanOrEqual(5);
    expect(result.pagination).toMatchObject({page:1,pageSize:5});
    expect(result.summary.shadowOnly).toBe(true);
  });
});
