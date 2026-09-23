import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {D1StateStore} from '../src/state-store.mjs';
import {monitor,handleRequest} from '../src/index.mjs';

// Execute the production SQL against real SQLite, with D1's asynchronous API shape.
function database(t) {
  const sqlite=new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../migrations/0001_operations_state.sql',import.meta.url),'utf8'));
  t.after(()=>sqlite.close());
  return {prepare(sql){return {bind(...args){return {
    async first(){return sqlite.prepare(sql).get(...args)??null;},
    async run(){const result=sqlite.prepare(sql).run(...args);return {success:true,meta:{changes:Number(result.changes)}};}
  };}};}};
}
const date=new Date('2026-09-23T16:45:00Z');
const env=db=>({STATE_DB:db,BACKUP_MODE:'disabled',GITHUB_REPOSITORY:'owner/repo',SOURCE_BRANCH:'main',SITE_INDEX:'https://site.test/data/index.json',AUTO_RECOVERY:'true',ISSUE_ALERTS:'false',GITHUB_TOKEN:'test'});
function mockGitHub(t,e,{current=false,dispatchFailure=false}={}) {
  const calls=[];
  const index={updated_at:date.toISOString(),latest_date:'2026-09-23',sampling:{latest_snapshot_valid:true}};
  t.mock.method(globalThis,'fetch',async(url,options={})=>{
    url=String(url);calls.push({url,options});
    assert.ok(!url.includes('star-rank-backup.yml'),'disabled backups must never be queried or dispatched');
    if(url.includes('/git/ref/'))return Response.json({object:{sha:'a'.repeat(40)}});
    if(current && url.includes('/contents/public/index.json'))return Response.json({encoding:'base64',content:Buffer.from(JSON.stringify(index)).toString('base64')});
    if(url.includes('/contents/'))return new Response(null,{status:404});
    if(url===e.SITE_INDEX)return current?Response.json(index):new Response(null,{status:503});
    if(url.includes('/runs?'))return Response.json({workflow_runs:[]});
    if(url.endsWith('/dispatches'))return new Response(null,{status:dispatchFailure?503:204});
    throw new Error('Unexpected request');
  });
  return calls;
}
test('D1 lock insert and expired revision CAS have exactly one winner',async t=>{
  const store=new D1StateStore(database(t));
  const winners=await Promise.all(Array.from({length:20},()=>store.put('locks/monitor','{"until":1}',{onlyIf:{etagDoesNotMatch:'*'}})));
  assert.equal(winners.filter(Boolean).length,1);
  const old=await store.get('locks/monitor');
  const replaced=await Promise.all(Array.from({length:20},()=>store.put('locks/monitor','{"until":2}',{onlyIf:{etagMatches:old.etag}})));
  assert.equal(replaced.filter(Boolean).length,1);
  assert.equal(await store.put('locks/monitor','{}',{onlyIf:{etagMatches:old.etag}}),null);
  assert.deepEqual(await (await store.get('locks/monitor')).json(),{until:2});
  await assert.rejects(store.put('objects/abc','{}'));
  await assert.rejects(store.put('monitor/latest.json',JSON.stringify('x'.repeat(65536))));
});
test('D1 monitor rejects concurrent runs and persists retry cap without R2',async t=>{
  const e=env(database(t));const calls=mockGitHub(t,e);
  const reports=await Promise.all(Array.from({length:8},()=>monitor(e,date)));
  assert.equal(reports.filter(r=>r.skipped==='locked').length,7);
  for(const minutes of [30,60,90])await monitor(e,new Date(date.getTime()+minutes*60000));
  assert.equal(calls.filter(c=>c.url.endsWith('/dispatches')).length,3);
  const store=new D1StateStore(e.STATE_DB);
  assert.equal((await (await store.get('recovery/2026-09-24.json')).json()).count,3);
  assert.equal((await (await store.get('monitor/latest.json')).json()).backup_status,'disabled');
});
test('uncertain failed dispatch consumes a durable attempt',async t=>{
  const e=env(database(t));mockGitHub(t,e,{dispatchFailure:true});
  const report=await monitor(e,date);
  assert.equal(report.status,'unhealthy');
  const store=new D1StateStore(e.STATE_DB);
  assert.equal((await (await store.get('recovery/2026-09-24.json')).json()).count,1);
});
test('healthy sampling can be healthy with backup limitation explicitly exposed',async t=>{
  const e=env(database(t));mockGitHub(t,e,{current:true});
  const report=await monitor(e,date);
  assert.equal(report.status,'healthy');assert.equal(report.backup_enabled,false);
  assert.equal(report.backup_status,'disabled');assert.equal(report.backup_at,null);
  assert.equal(report.limitations.length,1);
  const store=new D1StateStore(e.STATE_DB);
  await store.put('monitor/latest.json',JSON.stringify({...report,checked_at:new Date().toISOString()}));
  const response=await handleRequest(new Request('https://ops.test/health'),e);
  assert.equal(response.status,200);assert.equal((await response.json()).backup_enabled,false);
  assert.equal((await handleRequest(new Request('https://ops.test/backup/latest'),e)).status,404);
  assert.equal((await handleRequest(new Request('https://ops.test/objects/'+'a'.repeat(64),{method:'PUT',body:'{}'}),e)).status,404);
});
test('missing dispatch credentials and missing state storage cannot report ready',async t=>{
  const e=env(database(t));delete e.GITHUB_TOKEN;mockGitHub(t,e,{current:true});
  const report=await monitor(e,date);
  assert.equal(report.status,'unhealthy');assert.equal(report.dispatch_authorized,false);
  assert.ok(report.issues.some(s=>s.includes('GitHub 调度授权')));
  const unavailable=await handleRequest(new Request('https://ops.test/health'),{BACKUP_MODE:'disabled'});
  assert.equal(unavailable.status,503);assert.equal((await unavailable.json()).status,'storage_unavailable');
});
