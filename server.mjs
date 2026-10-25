import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import {createVideoStore,createVideoAutomation} from './src/video-scheduler.mjs';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const staticPaths = new Map([
  ['/', ['web/index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['web/app.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['web/style.css', 'text/css; charset=utf-8']]
]);
const now = () => new Date().toISOString();
const err = (status, code) => Object.assign(new Error(code), { status, code });
const json = (res, status, data) => {
  res.writeHead(status, {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
  res.end(JSON.stringify(data));
};
const numeric = (v) => Number.isSafeInteger(Number(v)) && Number(v) > 0 ? Number(v) : null;
function schema(db) {
  db.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;" +
    "CREATE TABLE IF NOT EXISTS groups(id INTEGER PRIMARY KEY,name TEXT NOT NULL UNIQUE COLLATE NOCASE,created_at TEXT NOT NULL);" +
    "CREATE TABLE IF NOT EXISTS pages(id TEXT PRIMARY KEY,name TEXT NOT NULL,external_id TEXT UNIQUE,group_id INTEGER REFERENCES groups(id) ON DELETE SET NULL,origin TEXT NOT NULL CHECK(origin IN ('local','meta')),created_at TEXT NOT NULL);" +
    "CREATE TABLE IF NOT EXISTS drafts(id INTEGER PRIMARY KEY,page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE RESTRICT,content TEXT NOT NULL,scheduled_at TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);");
}
async function readPayload(req) {
  if (!String(req.headers['content-type']||'').toLowerCase().startsWith('application/json')) throw err(415,'JSON_REQUIRED');
  if (req.headers['x-toolpage-action'] !== '1') throw err(403,'ACTION_HEADER_REQUIRED');
  let buffer = '';
  for await (const chunk of req) {
    buffer += chunk;
    if (Buffer.byteLength(buffer) > 65536) throw err(413,'BODY_TOO_LARGE');
  }
  let data;
  try { data = JSON.parse(buffer); } catch { throw err(400,'INVALID_JSON'); }
  if (!data || Array.isArray(data) || typeof data !== 'object') throw err(400,'INVALID_OBJECT');
  return data;
}
const cleanName = (x) => {
  if (typeof x !== 'string' || !x.trim() || x.trim().length > 160) throw err(400,'INVALID_NAME');
  return x.trim();
};
const cleanContent = (x) => {
  if (typeof x !== 'string' || !x.trim() || x.length > 10000) throw err(400,'INVALID_CONTENT');
  return x.trim();
};
const dateInput = (v) => {
  if (v === null || v === '' || v === undefined) return null;
  if (typeof v !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(v) || !Number.isFinite(Date.parse(v))) throw err(400,'INVALID_UTC_DATE');
  const t = new Date(v).toISOString();
  if (t.slice(0,10) !== v.slice(0,10)) throw err(400,'INVALID_UTC_DATE');
  return t;
};
const countPages = db => db.prepare('SELECT COUNT(*) n FROM pages').get().n;
const publicPages = db => db.prepare("SELECT p.*,g.name AS group_name FROM pages p LEFT JOIN groups g ON p.group_id=g.id ORDER BY p.name COLLATE NOCASE,p.id").all();
const rows = db => ({
  pages: publicPages(db),
  groups: db.prepare('SELECT g.id,g.name,COUNT(p.id) AS page_count FROM groups g LEFT JOIN pages p ON p.group_id=g.id GROUP BY g.id ORDER BY g.name COLLATE NOCASE').all(),
  drafts: db.prepare('SELECT d.*,p.name AS page_name FROM drafts d JOIN pages p ON p.id=d.page_id ORDER BY d.id DESC').all()
});

export function createApp({ dbPath=':memory:', env=process.env, fetchImpl=globalThis.fetch, clock=Date.now }={}) {
  if (dbPath !== ':memory:') mkdirSync(path.dirname(path.resolve(dbPath)),{recursive:true});
  const db = new DatabaseSync(dbPath);
  schema(db);
  const videoStore=createVideoStore({db,clock});
  const videoAutomation=createVideoAutomation({store:videoStore,env,fetchImpl,clock});
  const graphVersion = /^v\d{2}\.\d$/.test(env.TOOLPAGE_GRAPH_VERSION || '') ? env.TOOLPAGE_GRAPH_VERSION : 'v26.0';
  async function syncMeta() {
    const token = env.TOOLPAGE_META_USER_TOKEN;
    if (!token) throw err(409,'META_TOKEN_NOT_CONFIGURED');
    const url = new URL('https://graph.facebook.com/' + graphVersion + '/me/accounts');
    url.searchParams.set('fields','id,name,tasks');
    url.searchParams.set('limit','100');
    let resp;
    try {
      resp = await fetchImpl(url.toString(),{
        method:'GET',headers:{Authorization:'Bearer '+token,Accept:'application/json'},
        signal:AbortSignal.timeout(12000),redirect:'error'
      });
    } catch { throw err(502,'META_UNREACHABLE'); }
    if (!resp.ok) throw err(502,'META_AUTH_OR_PERMISSIONS_FAILED');
    let data;
    try { data=await resp.json(); } catch { throw err(502,'META_INVALID_RESPONSE'); }
    if (!Array.isArray(data?.data)) throw err(502,'META_INVALID_RESPONSE');
    const upsert=db.prepare("INSERT INTO pages(id,name,external_id,group_id,origin,created_at) VALUES(?,?,?,NULL,'meta',?) ON CONFLICT(external_id) DO UPDATE SET name=excluded.name");
    let synced=0,skipped=0;
    for(const p of data.data) {
      if (!p || !/^\d{1,40}$/.test(String(p.id)) || typeof p.name !== 'string') {skipped++;continue;}
      const externalId=String(p.id);
      if (!db.prepare('SELECT 1 FROM pages WHERE external_id=?').get(externalId) && countPages(db)>=10) {skipped++;continue;}
      upsert.run('meta-'+externalId,cleanName(p.name),externalId,now());
      synced++;
    }
    return {synced,skipped,truncated:Boolean(data.paging?.next),note:'Chỉ đồng bộ metadata Page; chưa bật quyền đăng bài.'};
  }
  async function handler(req,res) {
    try {
      const address=server.address();
      const port=typeof address === 'object' && address ? address.port : 0;
      const validHosts=new Set(['127.0.0.1:'+port,'localhost:'+port]);
      if (!validHosts.has(req.headers.host)) throw err(403,'LOCALHOST_ONLY');
      const origins=new Set(['http://127.0.0.1:'+port,'http://localhost:'+port]);
      if (req.headers.origin && !origins.has(req.headers.origin)) throw err(403,'CROSS_ORIGIN_DENIED');
      const url=new URL(req.url,'http://127.0.0.1:'+port);
      if (req.method==='GET' && staticPaths.has(url.pathname)) {
        const [file,mime]=staticPaths.get(url.pathname);
        const src=readFileSync(path.join(here,file));
        res.writeHead(200,{'Content-Type':mime,'X-Content-Type-Options':'nosniff','Cache-Control':'no-store','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"});
        return res.end(src);
      }
      if (req.method==='GET' && url.pathname==='/api/status') return json(res,200,{ok:true,mode:'LOCAL_ONLY',page_limit:10,meta_configured:!!env.TOOLPAGE_META_USER_TOKEN,live_publish:videoAutomation.status().armed && env.TOOLPAGE_LIVE_PUBLISH==='1',video_automation:videoAutomation.status()});
      if (req.method==='GET' && url.pathname==='/api/state') {
        const state=rows(db);
        const q=(url.searchParams.get('q')||'').trim().toLocaleLowerCase('vi');
        if(q) state.pages=state.pages.filter(p=>p.name.toLocaleLowerCase('vi').includes(q) || p.id.toLowerCase().includes(q));
        return json(res,200,state);
      }
      if (req.method==='GET' && url.pathname==='/api/video/state') return json(res,200,{configs:videoStore.configs(),jobs:videoStore.jobs(),worker:videoAutomation.status()});
      if (req.method==='GET' && url.pathname==='/api/health') return json(res,200,{ok:true,db:db.prepare('PRAGMA integrity_check').get().integrity_check});
      if (!['POST','PATCH','DELETE'].includes(req.method)) throw err(404,'NOT_FOUND');
      const input=await readPayload(req);
      if (req.method==='POST' && url.pathname==='/api/video/config') return json(res,200,videoStore.save(input));
      if (req.method==='POST' && url.pathname==='/api/video/scan') return json(res,200,videoStore.scan());
      if (req.method==='POST' && url.pathname==='/api/video/arm') return json(res,200,videoAutomation.arm(input));
      if (req.method==='POST' && url.pathname==='/api/video/disarm') return json(res,200,videoAutomation.disarm());
      if (req.method==='POST' && url.pathname==='/api/video/tick') return json(res,200,await videoAutomation.tick());
      const videoCancel=/^\/api\/video\/jobs\/(\d+)\/cancel$/.exec(url.pathname);
      if (req.method==='POST' && videoCancel) return json(res,200,videoStore.cancel(Number(videoCancel[1])));
      if (req.method==='POST' && url.pathname==='/api/meta/sync') return json(res,200,await syncMeta());
      if (req.method==='POST' && url.pathname==='/api/groups') {
        const name=cleanName(input.name);
        if(db.prepare('SELECT 1 FROM groups WHERE name=? COLLATE NOCASE').get(name)) throw err(409,'GROUP_EXISTS');
        const result=db.prepare('INSERT INTO groups(name,created_at) VALUES(?,?)').run(name,now());
        return json(res,201,{id:Number(result.lastInsertRowid),name});
      }
      const groupId=/^\/api\/groups\/(\d+)$/.exec(url.pathname);
      if(req.method==='DELETE' && groupId) {
        const id=numeric(groupId[1]);
        if(!db.prepare('SELECT 1 FROM groups WHERE id=?').get(id)) throw err(404,'GROUP_NOT_FOUND');
        db.prepare('DELETE FROM groups WHERE id=?').run(id);
        return json(res,200,{ok:true});
      }
      if (req.method==='POST' && url.pathname==='/api/pages') {
        if(countPages(db)>=10) throw err(409,'PAGE_LIMIT_10');
        const name=cleanName(input.name);
        const id='local-'+randomUUID();
        db.prepare("INSERT INTO pages(id,name,external_id,group_id,origin,created_at) VALUES(?,?,NULL,NULL,'local',?)").run(id,name,now());
        return json(res,201,{id,name,origin:'local'});
      }
      const member=/^\/api\/pages\/([^/]+)\/group$/.exec(url.pathname);
      if(req.method==='PATCH' && member) {
        const pageId=decodeURIComponent(member[1]);
        if(!db.prepare('SELECT 1 FROM pages WHERE id=?').get(pageId)) throw err(404,'PAGE_NOT_FOUND');
        let groupId=null;
        if(input.group_id !== null && input.group_id !== '' && input.group_id !== undefined) {
          groupId=numeric(input.group_id);
          if(!groupId || !db.prepare('SELECT 1 FROM groups WHERE id=?').get(groupId)) throw err(404,'GROUP_NOT_FOUND');
        }
        db.prepare('UPDATE pages SET group_id=? WHERE id=?').run(groupId,pageId);
        return json(res,200,{ok:true});
      }
      const page=/^\/api\/pages\/([^/]+)$/.exec(url.pathname);
      if(req.method==='DELETE' && page) {
        const id=decodeURIComponent(page[1]);
        if(!db.prepare('SELECT 1 FROM pages WHERE id=?').get(id)) throw err(404,'PAGE_NOT_FOUND');
        if(db.prepare('SELECT 1 FROM drafts WHERE page_id=? LIMIT 1').get(id)) throw err(409,'PAGE_HAS_DRAFTS');
        if(videoStore.config(id) || db.prepare('SELECT 1 FROM video_jobs WHERE page_id=? LIMIT 1').get(id)) throw err(409,'PAGE_HAS_VIDEO_CONFIG_OR_JOBS');
        db.prepare('DELETE FROM pages WHERE id=?').run(id);
        return json(res,200,{ok:true});
      }
      if(req.method==='POST' && url.pathname==='/api/drafts') {
        const pageId=String(input.page_id||'');
        if(!db.prepare('SELECT 1 FROM pages WHERE id=?').get(pageId)) throw err(404,'PAGE_NOT_FOUND');
        const content=cleanContent(input.content);
        const scheduled_at=dateInput(input.scheduled_at);
        const stamp=now();
        const r=db.prepare('INSERT INTO drafts(page_id,content,scheduled_at,created_at,updated_at) VALUES(?,?,?,?,?)').run(pageId,content,scheduled_at,stamp,stamp);
        return json(res,201,{id:Number(r.lastInsertRowid),status:'draft',published:false});
      }
      const draft=/^\/api\/drafts\/(\d+)$/.exec(url.pathname);
      if(draft && ['PATCH','DELETE'].includes(req.method)) {
        const id=numeric(draft[1]),old=db.prepare('SELECT * FROM drafts WHERE id=?').get(id);
        if(!old) throw err(404,'DRAFT_NOT_FOUND');
        if(req.method==='DELETE') {db.prepare('DELETE FROM drafts WHERE id=?').run(id);return json(res,200,{ok:true});}
        const content='content' in input?cleanContent(input.content):old.content;
        const scheduled='scheduled_at' in input?dateInput(input.scheduled_at):old.scheduled_at;
        db.prepare('UPDATE drafts SET content=?,scheduled_at=?,updated_at=? WHERE id=?').run(content,scheduled,now(),id);
        return json(res,200,{ok:true});
      }
      throw err(404,'NOT_FOUND');
    } catch (e) {
      const status=e.status||500;
      json(res,status,{error:status===500?'INTERNAL_ERROR':e.code||'REQUEST_FAILED'});
    }
  }
  const server=createServer(handler);
  return {server,db,videoStore,videoAutomation,close:()=>new Promise(resolve=>{videoAutomation.stop();server.close(()=>{db.close();resolve();});})};
}
if (process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const file=process.env.TOOLPAGE_DB || path.join(here,'data','toolpage.sqlite');
  const app=createApp({dbPath:file});
  const port=Number(process.env.TOOLPAGE_PORT||3210);
  if(!Number.isInteger(port) || port<1024 || port>65535) throw new Error('PORT_MUST_BE_1024_TO_65535');
  app.server.listen(port,'127.0.0.1',()=>{app.videoAutomation.start();console.log('toolPage: http://127.0.0.1:'+port+' (video folder scan active; LIVE requires per-session arming)');});
}