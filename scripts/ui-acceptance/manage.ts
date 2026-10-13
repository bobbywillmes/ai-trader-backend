import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { ACCEPTANCE_DATABASE, ACCEPTANCE_MARKER, ACCEPTANCE_SENTINEL, ACCEPTANCE_USER } from './constants.js';
const action=process.argv[2]; const dir='.acceptance/ui'; const compose=['compose','-f','docker-compose.acceptance.yml','-p','ai-trader-ui-acceptance'];
function docker(args:string[]){const r=spawnSync('docker',[...compose,...args],{stdio:'inherit'});if(r.status!==0)process.exit(r.status??1);}
await mkdir(dir,{recursive:true});
if(action==='start'){const password=randomBytes(32).toString('base64url');await writeFile(`${dir}/db-password.txt`,password,{mode:0o600});await writeFile(`${dir}/database-url.txt`,`postgresql://${ACCEPTANCE_USER}:${password}@db:5432/${ACCEPTANCE_DATABASE}`,{mode:0o600});docker(['up','-d','--build','db']);}
else if(action==='migrate'){docker(['build','api']);docker(['run','--rm','--entrypoint','sh','api','-c',`export DATABASE_URL="$(cat /run/secrets/database_url)" && npx prisma migrate deploy && node --import tsx scripts/ui-acceptance/mark-database.ts`]);}
else if(action==='fixture'){docker(['build','api']);docker(['run','--rm','--entrypoint','node','api','--import','tsx','scripts/ui-acceptance/fixture.ts']);}
else if(action==='api'){docker(['up','-d','--build','api','proxy']);}
else if(action==='stop'){docker(['down','--volumes','--remove-orphans']);}
else if(action==='urls'){if(!existsSync(`${dir}/manifest.json`))throw new Error('Run acceptance:ui:fixture first.');console.log(await readFile(`${dir}/manifest.json`,'utf8'));}
else throw new Error('Expected start, migrate, fixture, api, stop, or urls.');
