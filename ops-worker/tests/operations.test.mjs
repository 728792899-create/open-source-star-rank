import test from 'node:test';
import assert from 'node:assert/strict';
import {handleRequest,digest,recoveryPlan,monitor,validateManifest} from '../src/index.mjs';
class Store {
  data=new Map(); revision=0;
  async get(key){const v=this.data.get(key);if(!v)return null;return {...v,body:v.raw.slice(),arrayBuffer:async()=>v.raw.slice().buffer,json:async()=>JSON.parse(new TextDecoder().decode(v.raw))};}
  async head(key){return this.get(key);}
  async put(key,value,options={}){const old=this.data.get(key);if(options.onlyIf?.etagMatches && options.onlyIf.etagMatches!==old?.etag)return null;if(options.onlyIf?.etagDoesNotMatch==='*' && old)return null;const raw=typeof value==='string'?new TextEncoder().encode(value):new Uint8Array(value);const record={raw,size:raw.byteLength,etag:String(++this.revision),customMetadata:options.customMetadata};this.data.set(key,record);return record;}
}
const env=()=>({STORE:new Store(),BACKUP_TOKEN:'x'.repeat(40),GITHUB_REPOSITORY:'owner/repo',SOURCE_BRANCH:'main',SITE_INDEX:'https://example.test/data/index.json',AUTO_RECOVERY:'true',ISSUE_ALERTS:'false',GITHUB_TOKEN:'test'});
const req=(path,body,auth=true)=>new Request('https://ops.test'+path,{method:body===undefined?'GET':'PUT',headers:auth?{authorization:'Bearer '+'x'.repeat(40)}:{},...(body===undefined?{}:{body:typeof body==='string'?body:JSON.stringify(body)})});
const now=new Date('2026-09-20T17:15:00Z');
const current={updated_at:'2026-09-20T16:20:00Z',latest_date:'2026-09-20',sampling:{latest_snapshot_valid:true}};
test('recovery distinguishes missing capture, offline replay, site lag and real baseline',()=>{
 assert.equal(recoveryPlan({now}).mode,'collect_publish');
 assert.equal(recoveryPlan({now:new Date('2026-09-21T05:00:00Z')}).mode,null);
 assert.equal(recoveryPlan({now:new Date('2026-09-21T05:00:00Z'),receiptAvailable:true}).mode,'collect_publish');
 assert.equal(recoveryPlan({now,data:current}).mode,'deploy_existing');
 assert.equal(recoveryPlan({now,data:current,site:current}).reason,null);
 const baseline={...current,latest_date:null};assert.equal(recoveryPlan({now,data:baseline,site:baseline}).mode,null);
});
test('private backups require credentials, checksum match and readback',async()=>{
 const e=env();const raw='{"example":1}';const hash=await digest(new TextEncoder().encode(raw));
 assert.equal((await handleRequest(req('/objects/'+hash,raw,false),e)).status,401);
 assert.equal((await handleRequest(req('/objects/'+'a'.repeat(64),raw),e)).status,400);
 assert.equal((await handleRequest(req('/objects/'+hash,raw),e)).status,201);
 assert.equal(await (await handleRequest(req('/objects/'+hash),e)).text(),raw);
 assert.equal((await handleRequest(req('/objects/'+hash,raw),e)).status,201);
});
test('manifest rejects traversal and missing core files',()=>{
 const manifest={version:1,data_commit:'a'.repeat(40),created_at:now.toISOString(),files:[{path:'public/../secret.json',sha256:'a'.repeat(64),size:1}]};
 assert.throws(()=>validateManifest(manifest));manifest.files[0].path='public/index.json';assert.throws(()=>validateManifest(manifest));
});
test('latest backup requires full verification and cannot move backwards',async()=>{
 const e=env();const files=['public/index.json','state/candidates.json'].map(path=>({path,sha256:'b'.repeat(64),size:1}));
 const manifest={version:1,data_commit:'a'.repeat(40),created_at:now.toISOString(),files};
 const body=JSON.stringify(manifest);const hash=await digest(new TextEncoder().encode(body));
 assert.equal((await handleRequest(req('/manifests/'+hash,body),e)).status,201);
 assert.equal((await handleRequest(req('/backup/latest',{manifest:hash,verified_count:1}),e)).status,400);
 assert.equal((await handleRequest(req('/backup/latest',{manifest:hash,verified_count:2}),e)).status,200);
 const older=JSON.stringify({...manifest,created_at:'2026-09-19T00:00:00Z'});const id=await digest(new TextEncoder().encode(older));await handleRequest(req('/manifests/'+id,older),e);
 assert.equal((await handleRequest(req('/backup/latest',{manifest:id,verified_count:2}),e)).status,409);
});
test('monitor serializes runs and caps dispatches while reading fixed data revision',async(t)=>{
 const e=env();const requests=[];
 t.mock.method(globalThis,'fetch',async(url,options={})=>{
  requests.push({url,options});
  if(url.includes('/git/ref/'))return Response.json({object:{sha:'a'.repeat(40)}});
  if(url.includes('/contents/'))return new Response('',{status:404});
  if(url.includes('/runs?'))return Response.json({workflow_runs:[]});
  if(url.endsWith('/dispatches'))return new Response(null,{status:204});
  return new Response('',{status:503});
 });
 await monitor(e,now);assert.equal((await monitor(e,now)).skipped,'locked');
 await monitor(e,new Date(now.getTime()+30*60000));await monitor(e,new Date(now.getTime()+60*60000));await monitor(e,new Date(now.getTime()+90*60000));
 assert.equal(requests.filter(r=>r.url.endsWith('star-rank-pages.yml/dispatches')).length,3);
 assert.ok(requests.filter(r=>r.url.includes('/contents/')).every(r=>r.url.endsWith('ref='+'a'.repeat(40))));
});
test('disabled recovery never dispatches; stale monitor health is not green',async(t)=>{
 const e=env();e.AUTO_RECOVERY='false';let calls=0;
 t.mock.method(globalThis,'fetch',async(url)=>{if(url.includes('/dispatches'))calls++;return new Response('',{status:503});});
 await monitor(e,now);assert.equal(calls,0);assert.equal((await handleRequest(req('/health',undefined,false),e)).status,503);
});
test('GitHub App credentials mint a signed, short lived installation token',async(t)=>{
 const {githubCredentials}=await import('../src/index.mjs');
 const keys=await crypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']);
 const der=new Uint8Array(await crypto.subtle.exportKey('pkcs8',keys.privateKey));
 const privateKey='-----BEGIN PRIVATE KEY-----\n'+Buffer.from(der).toString('base64')+'\n-----END PRIVATE KEY-----';
 t.mock.method(globalThis,'fetch',async(url,options)=>{
  assert.equal(url,'https://api.github.com/app/installations/456/access_tokens');
  const jwt=options.headers.Authorization.slice(7);const [header,body,signature]=jwt.split('.');
  assert.equal(await crypto.subtle.verify('RSASSA-PKCS1-v1_5',keys.publicKey,Buffer.from(signature,'base64url'),new TextEncoder().encode(header+'.'+body)),true);
  const claims=JSON.parse(Buffer.from(body,'base64url'));assert.equal(claims.iss,'123');assert.equal(claims.exp-claims.iat,600);
  return Response.json({token:'installation-test',expires_at:new Date(now.getTime()+3600000).toISOString()});
 });
 const credentials=await githubCredentials({GITHUB_APP_ID:'123',GITHUB_INSTALLATION_ID:'456',GITHUB_APP_PRIVATE_KEY:privateKey},now);
 assert.equal(credentials.GITHUB_TOKEN,'installation-test');
});
test('reordered index keys do not trigger unnecessary deploys',()=>{
 const reordered={sampling:current.sampling,latest_date:current.latest_date,updated_at:current.updated_at};
 assert.equal(recoveryPlan({now,data:current,site:reordered}).reason,null);
});
test('backup dispatch failure does not block valid-window capture recovery',async(t)=>{
 const e=env();let collected=false;
 t.mock.method(globalThis,'fetch',async(url)=>{
  if(url.includes('/git/ref/'))return Response.json({object:{sha:'a'.repeat(40)}});
  if(url.includes('/contents/'))return new Response('',{status:404});
  if(url.includes('star-rank-backup.yml'))return new Response('',{status:503});
  if(url.includes('/runs?'))return Response.json({workflow_runs:[]});
  if(url.endsWith('star-rank-pages.yml/dispatches')){collected=true;return new Response(null,{status:204});}
  return new Response('',{status:503});
 });
 const report=await monitor(e,now);assert.equal(collected,true);assert.ok(report.issues.includes('独立备份补调度失败'));
});
test('enrichment publication lag is detected even when ranking index is unchanged',async(t)=>{
 const e=env();await e.STORE.put('backup/latest.json',JSON.stringify({received_at:now.toISOString()}));
 const operations={version:1,enrichment:{translation:{generated_at:now.toISOString(),coverage:{pending_count:0}}}};
 let dispatch;
 const content=value=>Response.json({encoding:'base64',content:Buffer.from(JSON.stringify(value)).toString('base64')});
 t.mock.method(globalThis,'fetch',async(url,options={})=>{
  url=String(url);
  if(url.includes('/git/ref/'))return Response.json({object:{sha:'a'.repeat(40)}});
  if(url.includes('/contents/public/index.json'))return content(current);
  if(url.includes('/contents/public/operations.json'))return content(operations);
  if(url.includes('/contents/'))return new Response('',{status:404});
  if(url===e.SITE_INDEX)return Response.json(current);
  if(url.endsWith('/operations.json'))return new Response('',{status:404});
  if(url.includes('/runs?'))return Response.json({workflow_runs:[]});
  if(url.endsWith('/dispatches')){dispatch=JSON.parse(options.body);return new Response(null,{status:204});}
  throw Error('Unexpected URL '+url);
 });
 const report=await monitor(e,now);
 assert.equal(report.action,'deploy_existing');assert.equal(dispatch.inputs.data_ref,'a'.repeat(40));
});
