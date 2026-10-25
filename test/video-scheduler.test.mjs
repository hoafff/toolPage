import test from 'node:test';
import assert from 'node:assert/strict';
import {createApp} from '../server.mjs';
import {mkdtempSync,mkdirSync,writeFileSync,utimesSync,rmSync,symlinkSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

async function fixture(t,{env={},fetchImpl=async()=>{throw Error('NETWORK_FORBIDDEN');}}={}){
 const dir=mkdtempSync(path.join(os.tmpdir(),'toolpage-video-'));
 const folder=path.join(dir,'Page01');mkdirSync(folder);
 let time=Date.parse('2026-10-25T00:00:00.000Z');
 const dbPath=path.join(dir,'test.sqlite');
 const app=createApp({dbPath,env,fetchImpl,clock:()=>time});
 await new Promise(ok=>app.server.listen(0,'127.0.0.1',ok));
 t.after(async()=>{await app.close();rmSync(dir,{recursive:true,force:true});});
 const root='http://127.0.0.1:'+app.server.address().port;
 const req=async(route,method='GET',input)=>{
  const res=await fetch(root+route,{method,headers:method==='GET'?{}:{Origin:root,'Content-Type':'application/json','X-ToolPage-Action':'1'},body:method==='GET'?undefined:JSON.stringify(input||{})});
  return {status:res.status,...await res.json()};
 };
 const putFile=(name='clip001.mp4',payload=Buffer.from('FAKE_VIDEO_BYTES'))=>{
  const file=path.join(folder,name);writeFileSync(file,payload);
  const date=new Date(time-90_000);utimesSync(file,date,date);
  return file;
 };
 const advance=iso=>{time=Date.parse(iso);};
 const local=async()=> (await req('/api/pages','POST',{name:'Local test'})).id;
 const meta=async()=>{
  const res=await req('/api/meta/sync','POST',{});
  assert.equal(res.status,200);
  return 'meta-123456';
 };
 const config=async(page_id,options={})=>req('/api/video/config','POST',{page_id,folder,times:['08:00','18:00'],caption:'Bài viết về video',enabled:true,...options});
 return {app,folder,dbPath,req,putFile,advance,local,meta,config};
}

test('Video folder per local Page: times in VN, stable files, queue persistence and no LIVE',async t=>{
 const f=await fixture(t);
 const p=await f.local();
 const saved=await f.config(p);
 assert.equal(saved.status,200);
 assert.deepEqual(saved.times,['08:00','18:00']);
 f.putFile();
 const one=await f.req('/api/video/scan','POST',{});
 assert.equal(one.added,1);
 assert.equal((await f.req('/api/video/scan','POST',{})).added,0);
 const j=(await f.req('/api/video/state')).jobs[0];
 assert.equal(j.file_name,'clip001.mp4');
 assert.equal(j.scheduled_at,'2026-10-25T01:00:00.000Z');
 f.advance('2026-10-25T02:00:00.000Z');
 const tick=await f.req('/api/video/tick','POST',{});
 assert.equal(tick.processed,0);
 assert.equal((await f.req('/api/video/state')).jobs[0].status,'READY');
 assert.equal((await f.req('/api/video/arm','POST',{confirm:true})).error,'VIDEO_LIVE_ENV_DISABLED');
});
test('Validation of directory, slots, unsupported / immature files; cancel stops queue',async t=>{
 const f=await fixture(t);
 const p=await f.local();
 assert.equal((await f.config(p,{folder:'relative/path'})).error,'VIDEO_FOLDER_ABSOLUTE_REQUIRED');
 assert.equal((await f.config(p,{times:['25:00']})).error,'VIDEO_INVALID_LOCAL_TIME');
 assert.equal((await f.config(p,{times:['08:00','08:00']})).error,'VIDEO_DUPLICATE_TIME');
 await f.config(p);
 f.putFile('ready.mp4');
 writeFileSync(path.join(f.folder,'new.mp4'),'still writing');
 writeFileSync(path.join(f.folder,'ignored.txt'),'not a video');
 const scanned=await f.req('/api/video/scan','POST',{});
 assert.equal(scanned.added,1);
 const j=(await f.req('/api/video/state')).jobs[0];
 assert.equal((await f.req('/api/video/jobs/'+j.id+'/cancel','POST',{})).status,200);
 assert.equal((await f.req('/api/video/jobs/'+j.id+'/cancel','POST',{})).status,409);
 assert.equal((await f.req('/api/video/state')).jobs[0].status,'CANCELLED');
});
test('Fail closed: Page tokens required, explicit arm and Meta credentials',async t=>{
 const f=await fixture(t,{env:{TOOLPAGE_LIVE_PUBLISH:'1',TOOLPAGE_META_USER_TOKEN:'synthetic-user'},fetchImpl:async()=>({ok:true,json:async()=>({data:[{id:'123456',name:'Test Page'}]})})});
 const page=await f.meta();await f.config(page);f.putFile();
 await f.req('/api/video/scan','POST',{});
 assert.equal((await f.req('/api/video/arm','POST',{confirm:true})).error,'VIDEO_NO_READY_META_PAGES');
 assert.equal((await f.req('/api/video/state')).jobs[0].status,'READY');
});
test('Official Page video multipart flow: authorized token, single upload, Graph ACK only',async t=>{
 const requests=[];
 const env={TOOLPAGE_LIVE_PUBLISH:'1',TOOLPAGE_META_USER_TOKEN:'synthetic-user',TOOLPAGE_PAGE_TOKEN_123456:'synthetic-page-token',TOOLPAGE_GRAPH_VERSION:'v26.0'};
 const f=await fixture(t,{env,fetchImpl:async(url,opts)=>{
  if(url.includes('/me/accounts'))return {ok:true,json:async()=>({data:[{id:'123456',name:'Authorized Page'}]})};
  requests.push({url,opts});
  const buffers=[];
  for await(const chunk of opts.body) buffers.push(Buffer.from(chunk));
  const upload=Buffer.concat(buffers);
  assert.ok(upload.includes(Buffer.from('FAKE_VIDEO_BYTES')));
  assert.match(upload.toString('utf8'),/name="source"; filename="video.mp4"/);
  assert.match(upload.toString('utf8'),/name="description"/);
  assert.equal(opts.headers.Authorization,'Bearer synthetic-page-token');
  assert.equal(Number(opts.headers['Content-Length']),upload.length);
  return {ok:true,json:async()=>({id:'987654321'})};
 }});
 const page=await f.meta();await f.config(page);f.putFile();
 assert.equal((await f.req('/api/video/scan','POST',{})).added,1);
 f.advance('2026-10-25T01:00:30.000Z');
 assert.equal((await f.req('/api/video/tick','POST',{})).processed,0);
 assert.equal((await f.req('/api/video/arm','POST',{confirm:false})).error,'VIDEO_ARM_CONFIRM_REQUIRED');
 assert.equal((await f.req('/api/video/arm','POST',{confirm:true})).armed,true);
 const tick=await f.req('/api/video/tick','POST',{});
 assert.equal(tick.processed,1);assert.equal(tick.result.status,'SUBMITTED');
 assert.equal(requests.length,1);
 assert.equal(requests[0].url,'https://graph-video.facebook.com/v26.0/123456/videos');
 const job=(await f.req('/api/video/state')).jobs[0];
 assert.equal(job.provider_video_id,'987654321');assert.equal(job.status,'SUBMITTED');
 assert.equal(job.attempt_count,1);
 await f.req('/api/video/tick','POST',{});assert.equal(requests.length,1);
 assert.equal((await f.req('/api/video/jobs/'+job.id+'/cancel','POST',{})).status,409);
 assert.equal((await f.req('/api/pages/'+page,'DELETE',{})).error,'PAGE_HAS_VIDEO_CONFIG_OR_JOBS');
});
test('Unknown network outcome remains UNCERTAIN, not retried automatically',async t=>{
 let uploads=0;
 const env={TOOLPAGE_LIVE_PUBLISH:'1',TOOLPAGE_META_USER_TOKEN:'u',TOOLPAGE_PAGE_TOKEN_123456:'t'};
 const f=await fixture(t,{env,fetchImpl:async(url)=>{
  if(url.includes('/me/accounts'))return {ok:true,json:async()=>({data:[{id:'123456',name:'Owner Page'}]})};
  uploads++;throw new Error('Network disappeared during upload');
 }});
 const page=await f.meta();await f.config(page);f.putFile();await f.req('/api/video/scan','POST',{});
 f.advance('2026-10-25T01:01:00.000Z');
 await f.req('/api/video/arm','POST',{confirm:true});
 const tick=await f.req('/api/video/tick','POST',{});
 assert.equal(tick.result.status,'UNCERTAIN');
 await f.req('/api/video/tick','POST',{});
 assert.equal(uploads,1);
 assert.equal((await f.req('/api/video/state')).jobs[0].error_code,'VIDEO_NO_DEFINITE_META_RESPONSE');
});
test('File changed after scan: definite FAILED without contacting Meta',async t=>{
 let uploads=0;
 const env={TOOLPAGE_LIVE_PUBLISH:'1',TOOLPAGE_META_USER_TOKEN:'u',TOOLPAGE_PAGE_TOKEN_123456:'t'};
 const f=await fixture(t,{env,fetchImpl:async url=>{
  if(url.includes('/me/accounts'))return {ok:true,json:async()=>({data:[{id:'123456',name:'Page'}]})};
  uploads++;throw Error('SHOULD_NOT_PUBLISH');
 }});
 const page=await f.meta();await f.config(page);const file=f.putFile();await f.req('/api/video/scan','POST',{});
 writeFileSync(file,'MODIFIED_VIDEO');
 f.advance('2026-10-25T01:05:00.000Z');
 await f.req('/api/video/arm','POST',{confirm:true});
 const v=await f.req('/api/video/tick','POST',{});
 assert.equal(v.result.status,'FAILED');assert.equal(uploads,0);
});
test('Crash-recovery: UPLOADING is UNCERTAIN and not resubmitted on restart',async t=>{
 const f=await fixture(t);
 const page=await f.local();await f.config(page);f.putFile();await f.req('/api/video/scan','POST',{});
 const id=(await f.req('/api/video/state')).jobs[0].id;
 f.app.db.prepare("UPDATE video_jobs SET status='UPLOADING' WHERE id=?").run(id);
 const second=createApp({dbPath:f.dbPath,clock:()=>Date.parse('2026-10-25T00:00:00Z')});
 assert.equal(second.db.prepare('SELECT status FROM video_jobs WHERE id=?').get(id).status,'UNCERTAIN');
 await new Promise(ok=>second.db.close()||ok());
});
test('Symlink files are never scanned; one Page does not read another folder',async t=>{
 const f=await fixture(t);
 const a=await f.local();await f.config(a);f.putFile('local.mp4');
 const other=path.join(path.dirname(f.folder),'Page02');mkdirSync(other);
 try{symlinkSync(path.join(f.folder,'local.mp4'),path.join(other,'linked.mp4'));}catch{} 
 const b=(await f.req('/api/pages','POST',{name:'Second'})).id;
 await f.config(b,{folder:other});
 assert.equal((await f.req('/api/video/scan','POST',{})).added,1);
 assert.deepEqual((await f.req('/api/video/state')).jobs.map(x=>x.page_id),[a]);
});
