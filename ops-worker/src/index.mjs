import {stateStore} from './state-store.mjs';
const JSON_HEADERS = {'content-type':'application/json; charset=utf-8','cache-control':'no-store'};
const MAX_BYTES = 16 * 1024 * 1024;
const SHA = /^[a-f0-9]{64}$/;
const reply = (body,status=200) => new Response(JSON.stringify(body),{status,headers:JSON_HEADERS});
export const digest = async body => [...new Uint8Array(await crypto.subtle.digest('SHA-256',body))].map(b=>b.toString(16).padStart(2,'0')).join('');
export const beijingDay = now => new Date(now.getTime()+8*3600000).toISOString().slice(0,10);
const localHour = now => new Date(now.getTime()+8*3600000).getUTCHours();
const yesterday = now => beijingDay(new Date(now.getTime()-86400000));
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value==='object' ? Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])) : value;
const same = (left,right) => JSON.stringify(canonical(left))===JSON.stringify(canonical(right));
function currentCapture(index,now) {
  const updated = Date.parse(index?.updated_at);
  return Number.isFinite(updated) && updated <= now.getTime()+300000 && beijingDay(new Date(updated))===beijingDay(now) && index.sampling?.latest_snapshot_valid===true;
}
export function recoveryPlan({data,site,receiptAvailable=false,now=new Date()}) {
  if(!currentCapture(data,now)) {
    if(receiptAvailable) return {mode:'collect_publish',reason:'已有真实采集记录，恢复派生数据与发布'};
    if(localHour(now)<3) return {mode:'collect_publish',reason:'有效窗口内缺少今日采样'};
    return {mode:null,reason:'今日采样缺失，已超出有效窗口；等待下一窗口，不补造数据'};
  }
  // A first valid baseline cannot produce yesterday's delta: don't redeploy it forever.
  if(!site || !same(site,data)) return {mode:'deploy_existing',reason:'数据已保存，线上版本未同步'};
  if(data.latest_date!==yesterday(now)) return {mode:null,reason:'今日基线已保存，等待连续有效快照形成日榜'};
  return {mode:null,reason:null};
}
export function validateManifest(value) {
  if(value?.version!==1 || !/^[a-f0-9]{40}$/.test(value.data_commit??'') || !Number.isFinite(Date.parse(value.created_at)) || !Array.isArray(value.files) || !value.files.length || value.files.length>100000) throw new Error('Invalid backup manifest');
  const paths = new Set();
  for(const file of value.files) {
    if(typeof file.path!=='string' || !/^(state|snapshots|public|captures)\/[A-Za-z0-9_./-]+\.json$/.test(file.path) || file.path.split('/').some(p=>p==='..'||p==='.'||!p) || paths.has(file.path) || !SHA.test(file.sha256) || !Number.isSafeInteger(file.size) || file.size<0 || file.size>MAX_BYTES) throw new Error('Invalid backup entry');
    paths.add(file.path);
  }
  if(!paths.has('public/index.json') || !paths.has('state/candidates.json')) throw new Error('Backup is missing core data');
  return value;
}
async function authorized(request,env) {
  if(!env.BACKUP_TOKEN || env.BACKUP_TOKEN.length<32) return false;
  const supplied=request.headers.get('authorization')??'';
  return await digest(new TextEncoder().encode(supplied))===await digest(new TextEncoder().encode(`Bearer ${env.BACKUP_TOKEN}`));
}
async function boundedBody(request) {
  if(Number(request.headers.get('content-length')??0)>MAX_BYTES) throw new Error('Object too large');
  const reader=request.body?.getReader(); if(!reader) return new Uint8Array();
  const chunks=[];let size=0;
  while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>MAX_BYTES){await reader.cancel();throw new Error('Object too large');}chunks.push(value);}
  const all=new Uint8Array(size);let offset=0;for(const chunk of chunks){all.set(chunk,offset);offset+=chunk.length;}return all;
}
async function putImmutable(store,key,body,hash) {
  if(await digest(body)!==hash) throw new Error('Checksum mismatch');
  const prior=await store.head(key);
  if(prior && (prior.customMetadata?.sha256!==hash || prior.size!==body.byteLength)) throw new Error('Stored object metadata mismatch');
  if(!prior) await store.put(key,body,{sha256:hash,onlyIf:{etagDoesNotMatch:'*'},customMetadata:{sha256:hash}});
  const stored=await store.get(key);
  if(!stored || await digest(await stored.arrayBuffer())!==hash) throw new Error('Stored object verification failed');
}
export async function handleRequest(request,env) {
  const url=new URL(request.url);
  if(url.pathname==='/health' && request.method==='GET') {
    let state;
    try { state=await stateStore(env).get('monitor/latest.json'); }
    catch { return reply({status:'storage_unavailable',monitor_stale:true,backup_enabled:env.BACKUP_MODE==='r2'},503); }
    const report=state ? await state.json() : {status:'not_initialized'};
    const checked=Date.parse(report.checked_at);
    const stale=!Number.isFinite(checked) || checked>Date.now()+300000 || Date.now()-checked>45*60000;
    return reply({...report,backup_enabled:env.BACKUP_MODE==='r2',monitor_stale:stale},!stale && report.status==='healthy'?200:503);
  }
  if(env.BACKUP_MODE!=='r2') return reply({error:'Independent backup is disabled'},404);
  if(!await authorized(request,env)) return reply({error:'Unauthorized'},401);
  try {
    const match=url.pathname.match(/^\/(objects|manifests)\/([a-f0-9]{64})$/);
    if(match) {
      const [,kind,hash]=match;const key=`${kind}/${hash}`;
      if(request.method==='GET'||request.method==='HEAD') {
        const object=await env.STORE.get(key);if(!object)return reply({error:'Not found'},404);
        return new Response(request.method==='HEAD'?null:object.body,{headers:{'content-type':'application/octet-stream','content-length':String(object.size),'x-content-sha256':object.customMetadata?.sha256??'','cache-control':'no-store'}});
      }
      if(request.method==='PUT') {
        const body=await boundedBody(request);
        if(kind==='manifests') validateManifest(JSON.parse(new TextDecoder().decode(body)));
        await putImmutable(env.STORE,key,body,hash);
        return reply({sha256:hash,size:body.byteLength},201);
      }
    }
    if(url.pathname==='/backup/latest' && request.method==='GET') {
      const latest=await env.STORE.get('backup/latest.json');return latest?reply(await latest.json()):reply({error:'Not found'},404);
    }
    if(url.pathname==='/backup/latest' && request.method==='PUT') {
      const record=JSON.parse(new TextDecoder().decode(await boundedBody(request)));
      if(!SHA.test(record.manifest??'')) throw new Error('Invalid manifest id');
      const object=await env.STORE.get(`manifests/${record.manifest}`);if(!object)throw new Error('Manifest missing');
      const manifest=validateManifest(await object.json());
      // The authenticated uploader has verified every object before declaring completion.
      if(record.verified_count!==manifest.files.length) throw new Error('Backup verification incomplete');
      const previous=await env.STORE.get('backup/latest.json');
      if(previous && Date.parse((await previous.json()).created_at)>Date.parse(manifest.created_at))return reply({error:'Newer backup already recorded'},409);
      const result=await env.STORE.put('backup/latest.json',JSON.stringify({manifest:record.manifest,data_commit:manifest.data_commit,created_at:manifest.created_at,verified_count:record.verified_count,received_at:new Date().toISOString()}),{onlyIf:previous?{etagMatches:previous.etag}:{etagDoesNotMatch:'*'}});
      return result?reply({stored:true}):reply({error:'Concurrent backup update'},409);
    }
    return reply({error:'Not found'},404);
  } catch {return reply({error:'Invalid request or backup verification failed'},400);}
}
export async function githubCredentials(env,now=new Date()) {
  if(!env.GITHUB_APP_ID && !env.GITHUB_INSTALLATION_ID && !env.GITHUB_APP_PRIVATE_KEY) return env;
  if(!/^[0-9]+$/.test(env.GITHUB_APP_ID??'') || !/^[0-9]+$/.test(env.GITHUB_INSTALLATION_ID??'') || !env.GITHUB_APP_PRIVATE_KEY) throw new Error('Incomplete GitHub App configuration');
  const encode = raw => btoa(String.fromCharCode(...raw)).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
  const text = value => encode(new TextEncoder().encode(JSON.stringify(value)));
  const issued=Math.floor(now.getTime()/1000)-60;
  const unsigned=text({alg:'RS256',typ:'JWT'})+'.'+text({iat:issued,exp:issued+600,iss:env.GITHUB_APP_ID});
  const pem=env.GITHUB_APP_PRIVATE_KEY.replace(/-----[^-]+-----/g,'').replace(/\s/g,'');
  const key=await crypto.subtle.importKey('pkcs8',Uint8Array.from(atob(pem),c=>c.charCodeAt(0)),{name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'},false,['sign']);
  const signature=await crypto.subtle.sign('RSASSA-PKCS1-v1_5',key,new TextEncoder().encode(unsigned));
  const response=await fetch('https://api.github.com/app/installations/'+env.GITHUB_INSTALLATION_ID+'/access_tokens',{method:'POST',redirect:'manual',signal:AbortSignal.timeout(15000),headers:{Authorization:'Bearer '+unsigned+'.'+encode(new Uint8Array(signature)),Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2026-03-10','User-Agent':'star-rank-operations'}});
  if(!response.ok)throw new Error('GitHub request failed ('+response.status+')');
  const body=await response.json();
  if(typeof body.token!=='string' || !Number.isFinite(Date.parse(body.expires_at)) || Date.parse(body.expires_at)<=now.getTime()+60000)throw new Error('Invalid installation token');
  return {...env,GITHUB_TOKEN:body.token};
}
async function github(env,path,options={}) {
  if(!/^[\w.-]+\/[\w.-]+$/.test(env.GITHUB_REPOSITORY??''))throw new Error('Invalid repository configuration');
  const response=await fetch(`https://api.github.com/repos/${env.GITHUB_REPOSITORY}${path}`,{...options,redirect:'manual',signal:AbortSignal.timeout(15000),headers:{'Accept':'application/vnd.github+json','X-GitHub-Api-Version':'2026-03-10','User-Agent':'star-rank-operations',...(env.GITHUB_TOKEN?{'Authorization':`Bearer ${env.GITHUB_TOKEN}`} : {}),'Content-Type':'application/json',...options.headers}});
  if(response.status===404 && options.allowMissing)return null;
  if(!response.ok)throw new Error(`GitHub request failed (${response.status})`);
  return response.status===204?null:response.json();
}
async function content(env,path,sha,allowMissing=false) {
  const file=await github(env,`/contents/${path}?ref=${sha}`,{allowMissing});
  if(!file)return null;
  if(file.encoding!=='base64'||typeof file.content!=='string')throw new Error('Unsupported data document');
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(file.content.replace(/\n/g,'')),c=>c.charCodeAt(0))));
}
async function syncIssue(env,reason,now) {
  if(env.ISSUE_ALERTS!=='true')return;
  const title='[开源星榜] 无人值守运行异常';
  const issues=await github(env,'/issues?state=open&per_page=100');
  const existing=issues.find(item=>!item.pull_request && item.title===title);
  if(!reason && existing)await github(env,`/issues/${existing.number}`,{method:'PATCH',body:JSON.stringify({state:'closed'})});
  if(reason && !existing)await github(env,'/issues',{method:'POST',body:JSON.stringify({title,body:`自动检查发现：${reason}\n\n首次检查：${now.toISOString()}。具体状态请查看独立运行器 /health 与 Actions；恢复后自动关闭。`})});
}
export async function monitor(env,now=new Date()) {
  const store=stateStore(env);
  const lease=await store.get('locks/monitor');
  if(lease && (await lease.json()).until>now.getTime())return {skipped:'locked'};
  if(!await store.put('locks/monitor',JSON.stringify({until:now.getTime()+10*60000}),{onlyIf:lease?{etagMatches:lease.etag}:{etagDoesNotMatch:'*'}}))return {skipped:'locked'};
  const backupEnabled=env.BACKUP_MODE==='r2';
  const report={checked_at:now.toISOString(),status:'unhealthy',issues:[],action:null,
    state_backend:env.STATE_DB?'d1':'r2',auto_recovery:env.AUTO_RECOVERY==='true',dispatch_authorized:false,
    backup_enabled:backupEnabled,backup_status:backupEnabled?'unverified':'disabled',
    limitations:backupEnabled?[]:['未启用跨平台完整备份；GitHub 数据分支中的历史不等于独立灾备']};
  try {
    if(!['disabled','r2'].includes(env.BACKUP_MODE)) throw new Error('Invalid backup mode');
    env=await githubCredentials(env,now);
    report.dispatch_authorized=Boolean(env.GITHUB_TOKEN);
    if(report.auto_recovery && !report.dispatch_authorized) report.issues.push('自动恢复已启用，但尚未配置 GitHub 调度授权');
    const ref=await github(env,'/git/ref/heads/star-rank-data');const sha=ref.object.sha;
    const data=await content(env,'public/index.json',sha,true);
    const receipt=await content(env,`captures/${beijingDay(now)}/latest.json`,sha,true);
    let site=null;
    try{const response=await fetch(env.SITE_INDEX,{signal:AbortSignal.timeout(15000),redirect:'manual',cache:'no-store'});if(response.ok)site=await response.json();}catch{}
    const plan=recoveryPlan({data,site,receiptAvailable:SHA.test(receipt?.sha256??''),now});
    report.data_commit=sha;report.snapshot_at=data?.updated_at??null;report.ranking_date=data?.latest_date??null;
    report.sampling=data?.sampling??null;
    report.state_reason=plan.reason;
    // The first half-hour is a normal capture grace period, not a recurring incident.
    const grace=localHour(now)===0 && new Date(now.getTime()+8*3600000).getUTCMinutes()<30;
    const baseline=currentCapture(data,now) && site && same(site,data) && data.latest_date!==yesterday(now) && data.sampling?.consecutive_valid_snapshots===1;
    if(plan.reason && !grace && !baseline)report.issues.push(plan.reason);
    report.warming_up=Boolean(baseline || (grace && plan.reason));
    let backupState=null;
    if(backupEnabled) {
      try {
        const backup=await env.STORE.get('backup/latest.json');backupState=backup?await backup.json():null;
        const age=now.getTime()-Date.parse(backupState?.received_at);
        report.backup_status=!backupState?'missing':!Number.isFinite(age)||age < -300000||age>36*3600000?'stale':'verified';
        if(report.backup_status!=='verified')report.issues.push('独立备份缺失或超过36小时未完成');
      } catch { report.backup_status='unavailable';report.issues.push('独立备份存储不可用'); }
    }
    report.backup_at=backupState?.received_at??null;
    report.backup_commit=backupState?.data_commit??null;
    try {
      const operations=await content(env,'public/operations.json',sha,true);
      report.enrichment=operations?.enrichment??null;
      if(operations && currentCapture(data,now) && plan.mode!=='collect_publish') {
        let published=null;
        try{const response=await fetch(new URL('operations.json',env.SITE_INDEX),{signal:AbortSignal.timeout(15000),redirect:'manual',cache:'no-store'});if(response.ok)published=await response.json();}catch{}
        if(!published || !same(operations,published)) {
          plan.mode='deploy_existing';plan.reason='补全数据已保存，线上业务摘要未同步';
          report.state_reason=plan.reason;report.issues.push(plan.reason);
        }
      }
      for(const [kind,value] of Object.entries(report.enrichment??{})) {
        if(value?.coverage?.pending_count>0 && now.getTime()-Date.parse(value.generated_at)>7*86400000)report.issues.push(kind+' 补全积压超过7天');
      }
    }catch{report.issues.push('无法读取补全运行摘要');}
    try {
    if(backupEnabled && env.AUTO_RECOVERY==='true' && env.GITHUB_TOKEN && (!backupState || now.getTime()-Date.parse(backupState.received_at)>26*3600000)) {
      const key='backup-dispatch/'+beijingDay(now)+'.json';
      const prior=await store.get(key);const attempts=prior?await prior.json():{count:0,last_at:0};
      const runs=await github(env,'/actions/workflows/star-rank-backup.yml/runs?branch='+encodeURIComponent(env.SOURCE_BRANCH??'main')+'&per_page=20');
      if(!runs.workflow_runs.some(run=>run.status!=='completed') && attempts.count<3 && now.getTime()-attempts.last_at>=3600000) {
        await store.put(key,JSON.stringify({count:attempts.count+1,last_at:now.getTime()}));
        await github(env,'/actions/workflows/star-rank-backup.yml/dispatches',{method:'POST',body:JSON.stringify({ref:env.SOURCE_BRANCH??'main'})});
        report.backup_action='dispatched';
      }
    }
    }catch{report.issues.push('独立备份补调度失败');}
    if(plan.mode && env.AUTO_RECOVERY==='true' && env.GITHUB_TOKEN) {
      const historyKey=`recovery/${beijingDay(now)}.json`;const previous=await store.get(historyKey);const history=previous?await previous.json():{count:0,last_at:0};
      const runs=await github(env,`/actions/workflows/star-rank-pages.yml/runs?branch=${encodeURIComponent(env.SOURCE_BRANCH??'main')}&per_page=20`);
      const active=runs.workflow_runs.some(run=>run.status!=='completed');
      if(!active && history.count<3 && now.getTime()-history.last_at>=30*60000) {
        // Reserve an attempt before sending: an uncertain network response must not create an unbounded loop.
        await store.put(historyKey,JSON.stringify({count:history.count+1,last_at:now.getTime(),mode:plan.mode}));
        await github(env,'/actions/workflows/star-rank-pages.yml/dispatches',{method:'POST',body:JSON.stringify({ref:env.SOURCE_BRANCH??'main',inputs:{mode:plan.mode,...(plan.mode==='deploy_existing'?{data_ref:sha}:{})}})});
        report.action=plan.mode;
      }
    }
  }catch(error){report.issues.push(error.message?.startsWith('GitHub request failed')?error.message:'独立检查失败，请查看运行器配置与日志');}
  report.status=report.issues.length?'unhealthy':'healthy';
  await store.put('monitor/latest.json',JSON.stringify(report));
  try{await syncIssue(env,report.issues.join('；')||null,now);}catch{console.error('Incident delivery failed');}
  return report;
}
export default {
  fetch:handleRequest,
  async scheduled(_controller,env,ctx){ctx.waitUntil(monitor(env));}
};
