import { spawnSync } from 'node:child_process';

function inspect(container:string){const result=spawnSync('docker',['inspect',container,'--format','{{json .NetworkSettings}}'],{encoding:'utf8'});if(result.status!==0)throw new Error(`Unable to inspect ${container}.`);return JSON.parse(result.stdout) as {Networks:Record<string,{Gateway:string}>;Ports:Record<string,unknown>};}
const api=inspect('ai-trader-ui-acceptance-api-1');
const db=inspect('ai-trader-ui-acceptance-db-1');
const proxy=inspect('ai-trader-ui-acceptance-proxy-1');
const internal='ai-trader-ui-acceptance_acceptance_internal',ingress='ai-trader-ui-acceptance_acceptance_ingress';
if(Object.keys(api.Networks).join()!==internal||api.Networks[internal]?.Gateway!==''||Object.keys(api.Ports).length!==0)throw new Error('API is not exclusively isolated with no published ports.');
if(Object.keys(db.Networks).join()!==internal||db.Networks[internal]?.Gateway!==''||Object.values(db.Ports).some(Boolean))throw new Error('Database is not exclusively isolated with no published ports.');
if(!proxy.Networks[internal]||!proxy.Networks[ingress]||JSON.stringify(proxy.Ports)!=='{"8080/tcp":[{"HostIp":"127.0.0.1","HostPort":"3304"}]}')throw new Error('Proxy network or loopback binding is incorrect.');
const egress=spawnSync('docker',['exec','ai-trader-ui-acceptance-api-1','node','-e',"fetch('https://example.com',{signal:AbortSignal.timeout(3000)}).then(()=>process.exit(9)).catch(()=>process.exit(0))"]);
if(egress.status!==0)throw new Error('API container unexpectedly reached an external destination.');
const inbound=await fetch('http://127.0.0.1:3304/');if(!inbound.ok)throw new Error('Localhost proxy could not reach the API.');
const notAForwardProxy=await fetch('http://127.0.0.1:3304/http://example.com');if(notAForwardProxy.status!==404)throw new Error('Proxy accepted an unexpected arbitrary target.');
console.log(JSON.stringify({ok:true,apiEgress:'DENIED',databasePublishedPorts:0,apiPublishedPorts:0,proxyBinding:'127.0.0.1:3304',arbitraryProxyTarget:'DENIED'}));
