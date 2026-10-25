import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createApp} from '../server.mjs';

async function fixture(t,options={}) {
  const dir=mkdtempSync(path.join(os.tmpdir(),'toolpage-test-'));
  const file=path.join(dir,'test.sqlite');
  const app=createApp({dbPath:file,...options});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await app.close();rmSync(dir,{recursive:true,force:true});});
  const port=app.server.address().port,root='http://127.0.0.1:'+port;
  const request=async(endpoint,method='GET',body,extra={})=>{
    const r=await fetch(root+endpoint,{method,headers:method==='GET'?extra:{'Content-Type':'application/json','X-ToolPage-Action':'1',Origin:root,...extra},body:method==='GET'?undefined:JSON.stringify(body||{})});
    return {status:r.status,body:await r.json()};
  };
  return {app,request,root,file};
}
test('Localhost renders interface, healthy SQLite, empty state, no live publish',async t=>{
 const {request,root}=await fixture(t);
 const html=await (await fetch(root+'/')).text();
 assert.match(html,/toolPage/); assert.match(html,/data-view="pages"/);
 const css=await fetch(root+'/style.css');assert.equal(css.status,200);
 assert.equal((await request('/api/health')).body.db,'ok');
 const x=(await request('/api/status')).body;
 assert.equal(x.live_publish,false);assert.equal(x.meta_configured,false);
 const state=(await request('/api/state')).body;assert.deepEqual(state.pages,[]);
});
test('Page+Group membership and drafts persist; delete guard; no Facebook post',async t=>{
 const {request}=await fixture(t);
 const group=(await request('/api/groups','POST',{name:'Nội dung'})).body;
 const page=(await request('/api/pages','POST',{name:'Page 1'})).body;
 assert.equal(page.origin,'local');
 assert.equal((await request('/api/pages/'+page.id+'/group','PATCH',{group_id:group.id})).status,200);
 const draft=await request('/api/drafts','POST',{page_id:page.id,content:'Bài nháp thử',scheduled_at:'2026-11-02T12:00:00Z'});
 assert.equal(draft.status,201);assert.equal(draft.body.published,false);
 assert.equal((await request('/api/pages/'+page.id,'DELETE')).status,409);
 const state=(await request('/api/state')).body;
 assert.equal(state.groups[0].page_count,1);assert.equal(state.pages[0].group_name,'Nội dung');
 assert.equal(state.drafts[0].content,'Bài nháp thử');assert.equal(state.drafts[0].scheduled_at,'2026-11-02T12:00:00.000Z');
 assert.equal((await request('/api/drafts/'+draft.body.id,'PATCH',{content:'Đã sửa'})).status,200);
 assert.equal((await request('/api/drafts/'+draft.body.id,'DELETE')).status,200);
 const snapshot=(await request('/api/state')).body;assert.equal(snapshot.drafts.length,0);
 assert.equal((await request('/api/groups/'+group.id,'DELETE')).status,200);
 assert.equal((await request('/api/state')).body.pages[0].group_id,null);
 assert.equal((await request('/api/pages/'+page.id,'DELETE')).status,200);
});
test('10 Pages maximum; Unicode name filter works',async t=>{
 const {request}=await fixture(t);
 for(let i=0;i<10;i++) assert.equal((await request('/api/pages','POST',{name:i===3?'Cần Thơ':'Page '+i})).status,201);
 assert.equal((await request('/api/pages','POST',{name:'eleventh'})).body.error,'PAGE_LIMIT_10');
 const filtered=(await request('/api/state?q=cần')).body;
 assert.equal(filtered.pages.length,1);assert.equal(filtered.pages[0].name,'Cần Thơ');
});
test('Reject DNS rebinding hosts, cross origin, and missing anti-CSRF header',async t=>{
 const {request,root}=await fixture(t);
 assert.equal((await request('/api/state','GET',undefined,{Host:'attacker.example'})).status,403);
 assert.equal((await request('/api/pages','POST',{name:'evil'},{Origin:'https://attacker.example'})).status,403);
 const r=await fetch(root+'/api/pages',{method:'POST',headers:{'Content-Type':'application/json',Origin:root},body:'{"name":"bad"}'});
 assert.equal(r.status,403);
 assert.equal((await request('/api/state')).body.pages.length,0);
});
test('Meta sync explicitly opt-in; read-only metadata; bearer token never returned',async t=>{
 let calls=0;
 const env={TOOLPAGE_META_USER_TOKEN:'synthetic-private-token',TOOLPAGE_GRAPH_VERSION:'v24.0'};
 const f=await fixture(t,{env,fetchImpl:async(url,opts)=>{
   calls++;assert.match(url,/graph.facebook.com\/v24\.0\/me\/accounts/);
   assert.equal(opts.headers.Authorization,'Bearer synthetic-private-token');
   assert.equal(opts.method,'GET');
   return {ok:true,json:async()=>({data:[{id:'12345',name:'Owned Page',tasks:['CREATE_CONTENT']}]})};
 }});
 const r=await f.request('/api/meta/sync','POST',{});
 assert.equal(r.status,200);assert.equal(calls,1);assert.equal(r.body.synced,1);
 const state=(await f.request('/api/state')).body;
 assert.equal(state.pages[0].external_id,'12345');assert.equal(state.pages[0].origin,'meta');
 assert.ok(!JSON.stringify(state).includes('synthetic-private-token'));
 await f.request('/api/meta/sync','POST',{});
 assert.equal((await f.request('/api/state')).body.pages.length,1);
});
test('Meta sync fails closed if no token; API provides no fake status',async t=>{
 const {request}=await fixture(t);
 const r=await request('/api/meta/sync','POST',{});
 assert.equal(r.status,409);assert.equal(r.body.error,'META_TOKEN_NOT_CONFIGURED');
 assert.equal((await request('/api/state')).body.pages.length,0);
});
test('Reject malformed draft dates and missing Page',async t=>{
 const {request}=await fixture(t);
 const p=(await request('/api/pages','POST',{name:'Valid'})).body;
 assert.equal((await request('/api/drafts','POST',{page_id:p.id,content:'Post',scheduled_at:'2026-02-30T00:00:00Z'})).body.error,'INVALID_UTC_DATE');
 assert.equal((await request('/api/drafts','POST',{page_id:'other',content:'Post'})).status,404);
 assert.equal((await request('/api/state')).body.drafts.length,0);
});