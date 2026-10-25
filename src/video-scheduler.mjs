import path from 'node:path';
import { createReadStream, existsSync, lstatSync, realpathSync, readdirSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';

const EXT = new Set(['.mp4','.mov','.m4v']);
const LOCAL_OFFSET_MS = 7*60*60*1000; // ToolPage v0.2: fixed Asia/Ho_Chi_Minh (+07:00).
const MAX_FILE_BYTES = 1_000_000_000; // Simple multipart Page video upload, not resumable.
const apiError = (status,code) => Object.assign(new Error(code),{status,code});
const stamp = clock => new Date(clock()).toISOString();
function parsedTimes(input) {
  if (!Array.isArray(input) || !input.length || input.length > 12) throw apiError(400,'VIDEO_TIMES_REQUIRED_1_TO_12');
  const values=input.map(s=>{
    if (typeof s !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(s)) throw apiError(400,'VIDEO_INVALID_LOCAL_TIME');
    return s;
  });
  if (new Set(values).size!==values.length) throw apiError(400,'VIDEO_DUPLICATE_TIME');
  return values.sort();
}
function ensureDir(input) {
  if (typeof input!=='string' || !path.isAbsolute(input) || input.length>1024) throw apiError(400,'VIDEO_FOLDER_ABSOLUTE_REQUIRED');
  const dir=path.resolve(input);
  if (!existsSync(dir)) throw apiError(404,'VIDEO_FOLDER_NOT_FOUND');
  if (lstatSync(dir).isSymbolicLink() || !lstatSync(dir).isDirectory()) throw apiError(400,'VIDEO_FOLDER_NOT_DIRECTORY');
  const canonical=realpathSync(dir);
  // Allow normal Windows junction/real folders only when target is unambiguous.
  if (path.normalize(canonical).toLowerCase()!==path.normalize(dir).toLowerCase()) throw apiError(400,'VIDEO_FOLDER_INDIRECT_PATH');
  return dir;
}
const formatVideoName = name => typeof name==='string' && name.length<=255 &&
  name!=='.' && name!=='..' && !name.includes('/') && !name.includes('\\') &&
  !name.startsWith('.') && EXT.has(path.extname(name).toLowerCase());
function nextTime(times, afterMs) {
  const base=new Date(afterMs+LOCAL_OFFSET_MS);
  for(let day=0;day<370;day++){
    const d=new Date(Date.UTC(base.getUTCFullYear(),base.getUTCMonth(),base.getUTCDate()+day));
    for(const s of times){
      const [h,m]=s.split(':').map(Number);
      const ts=Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate(),h,m)-LOCAL_OFFSET_MS;
      if(ts>afterMs+1000) return new Date(ts).toISOString();
    }
  }
  throw apiError(500,'VIDEO_SLOT_EXHAUSTED');
}
export function createVideoStore({db,clock=Date.now}){
  db.exec("CREATE TABLE IF NOT EXISTS video_folder_configs("+
    "page_id TEXT PRIMARY KEY REFERENCES pages(id) ON DELETE RESTRICT,"+
    "folder_path TEXT NOT NULL, times_json TEXT NOT NULL CHECK(json_valid(times_json)),"+
    "caption TEXT NOT NULL DEFAULT '', enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),"+
    "updated_at TEXT NOT NULL);"+
    "CREATE TABLE IF NOT EXISTS video_jobs("+
    "id INTEGER PRIMARY KEY, page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE RESTRICT,"+
    "file_name TEXT NOT NULL, size_bytes INTEGER NOT NULL, mtime_ms INTEGER NOT NULL,"+
    "scheduled_at TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('READY','UPLOADING','SUBMITTED','UNCERTAIN','FAILED','CANCELLED')),"+
    "attempt_count INTEGER NOT NULL DEFAULT 0, provider_video_id TEXT, error_code TEXT,"+
    "created_at TEXT NOT NULL, updated_at TEXT NOT NULL,"+
    "UNIQUE(page_id,file_name,size_bytes,mtime_ms));"+
    "CREATE INDEX IF NOT EXISTS idx_video_jobs_due ON video_jobs(status,scheduled_at,id);");
  // Any crash during an external upload has an unknown outcome. Never auto-retry it.
  db.prepare("UPDATE video_jobs SET status='UNCERTAIN',error_code='INTERRUPTED_UPLOAD_CHECK_META',updated_at=? WHERE status='UPLOADING'").run(stamp(clock));
  const page = id => {
    const found=db.prepare('SELECT * FROM pages WHERE id=?').get(id);
    if(!found) throw apiError(404,'PAGE_NOT_FOUND');
    return found;
  };
  const config = id => db.prepare('SELECT * FROM video_folder_configs WHERE page_id=?').get(id);
  const configs = () => db.prepare('SELECT c.*,p.name AS page_name,p.origin,p.external_id FROM video_folder_configs c JOIN pages p ON p.id=c.page_id ORDER BY p.name COLLATE NOCASE').all().map(c=>({...c,times:JSON.parse(c.times_json)}));
  const jobs= () => db.prepare("SELECT j.*,p.name AS page_name FROM video_jobs j JOIN pages p ON j.page_id=p.id ORDER BY j.id DESC LIMIT 200").all();
  function save(body){
    page(body.page_id);
    const folder=ensureDir(body.folder);
    const times=parsedTimes(body.times);
    if(typeof body.caption!=='string' || body.caption.length>2000) throw apiError(400,'VIDEO_CAPTION_INVALID');
    if(typeof body.enabled!=='boolean') throw apiError(400,'VIDEO_ENABLED_BOOLEAN_REQUIRED');
    const last=config(body.page_id);
    if(last && last.folder_path!==folder && db.prepare("SELECT 1 FROM video_jobs WHERE page_id=? AND status IN ('READY','UPLOADING','UNCERTAIN') LIMIT 1").get(body.page_id)) {
      throw apiError(409,'VIDEO_FOLDER_HAS_PENDING_JOBS');
    }
    db.prepare("INSERT INTO video_folder_configs(page_id,folder_path,times_json,caption,enabled,updated_at) VALUES(?,?,?,?,?,?) "+
      "ON CONFLICT(page_id) DO UPDATE SET folder_path=excluded.folder_path,times_json=excluded.times_json,caption=excluded.caption,enabled=excluded.enabled,updated_at=excluded.updated_at")
      .run(body.page_id,folder,JSON.stringify(times),body.caption,body.enabled?1:0,stamp(clock));
    return configs().find(x=>x.page_id===body.page_id);
  }
  function scan(){
    let added=0,skipped=0,errors=[];
    for(const cfg of configs().filter(x=>x.enabled===1)){
      let entries;
      try { ensureDir(cfg.folder_path);entries=readdirSync(cfg.folder_path,{withFileTypes:true}); }
      catch {errors.push({page_id:cfg.page_id,error:'VIDEO_FOLDER_UNAVAILABLE'});continue;}
      // Sort stable, never follow nested folder or symlink.
      entries.sort((a,b)=>a.name.localeCompare(b.name,'vi'));
      const pending=db.prepare("SELECT MAX(scheduled_at) t FROM video_jobs WHERE page_id=? AND status='READY'").get(cfg.page_id).t;
      let after=Math.max(clock(),pending?Date.parse(pending):0);
      for(const entry of entries) {
        if(!entry.isFile() || entry.isSymbolicLink() || !formatVideoName(entry.name)) {skipped++;continue;}
        const file=path.join(cfg.folder_path,entry.name);
        let info;
        try{info=lstatSync(file);}catch{skipped++;continue;}
        if(!info.isFile()||info.isSymbolicLink()||info.size===0||info.size>MAX_FILE_BYTES||clock()-info.mtimeMs<30_000){skipped++;continue;}
        if(db.prepare('SELECT 1 FROM video_jobs WHERE page_id=? AND file_name=? AND size_bytes=? AND mtime_ms=?')
          .get(cfg.page_id,entry.name,info.size,Math.floor(info.mtimeMs))){skipped++;continue;}
        const next=nextTime(cfg.times,after);
        const t=stamp(clock);
        try{
          db.prepare("INSERT INTO video_jobs(page_id,file_name,size_bytes,mtime_ms,scheduled_at,status,created_at,updated_at) VALUES(?,?,?,?,?,'READY',?,?)")
            .run(cfg.page_id,entry.name,info.size,Math.floor(info.mtimeMs),next,t,t);
          added++;after=Date.parse(next);
        }catch{skipped++;}
      }
    }
    return {added,skipped,errors};
  }
  function cancel(id) {
    const result=db.prepare("UPDATE video_jobs SET status='CANCELLED',updated_at=? WHERE id=? AND status='READY'").run(stamp(clock),id);
    if(!result.changes)throw apiError(409,'VIDEO_JOB_NOT_CANCELLABLE');
    return {ok:true};
  }
  function claim(){
    const j=db.prepare("SELECT j.*,c.folder_path,c.caption,c.enabled,p.origin,p.external_id FROM video_jobs j JOIN video_folder_configs c ON j.page_id=c.page_id JOIN pages p ON j.page_id=p.id WHERE j.status='READY' AND j.scheduled_at<=? AND c.enabled=1 ORDER BY j.scheduled_at,j.id LIMIT 1").get(stamp(clock));
    if(!j)return null;
    if(j.origin!=='meta'||!j.external_id)return null;
    const changed=db.prepare("UPDATE video_jobs SET status='UPLOADING',attempt_count=attempt_count+1,updated_at=? WHERE id=? AND status='READY'").run(stamp(clock),j.id);
    return changed.changes ? j:null;
  }
  function finish(id,status,videoId=null,error=null){
    if(!['SUBMITTED','UNCERTAIN','FAILED'].includes(status))throw new Error('INVALID_INTERNAL_FINISH');
    db.prepare("UPDATE video_jobs SET status=?,provider_video_id=?,error_code=?,updated_at=? WHERE id=? AND status='UPLOADING'").run(status,videoId,error,stamp(clock),id);
  }
  return {save,scan,cancel,configs,jobs,claim,finish,db,config};
}

export async function uploadPageVideo({job,pageToken,fetchImpl=globalThis.fetch,version='v26.0'}){
  if(!/^\d{1,40}$/.test(job.external_id||''))throw apiError(409,'VIDEO_NOT_VERIFIED_META_PAGE');
  if(!pageToken)throw apiError(409,'VIDEO_PAGE_TOKEN_REQUIRED');
  const folder=ensureDir(job.folder_path);
  if(!formatVideoName(job.file_name))throw apiError(400,'VIDEO_INVALID_FILE_NAME');
  const file=path.resolve(folder,job.file_name);
  if(path.dirname(file)!==folder)throw apiError(400,'VIDEO_PATH_TRAVERSAL');
  const info=lstatSync(file);
  if(!info.isFile()||info.isSymbolicLink()||info.size!==job.size_bytes||Math.floor(info.mtimeMs)!==job.mtime_ms)throw apiError(409,'VIDEO_FILE_CHANGED');
  if(info.size>MAX_FILE_BYTES)throw apiError(413,'VIDEO_TOO_LARGE_DIRECT_UPLOAD');
  const boundary='toolPage-'+randomUUID().replaceAll('-','');
  const cleanField = str=>String(str).replace(/[\r\n]/g,' ');
  const prefix=Buffer.from('--'+boundary+'\r\nContent-Disposition: form-data; name="published"\r\n\r\ntrue\r\n'+
    '--'+boundary+'\r\nContent-Disposition: form-data; name="description"\r\n\r\n'+cleanField(job.caption||'')+'\r\n'+
    '--'+boundary+'\r\nContent-Disposition: form-data; name="source"; filename="video.mp4"\r\nContent-Type: video/mp4\r\n\r\n');
  const suffix=Buffer.from('\r\n--'+boundary+'--\r\n');
  async function* stream(){yield prefix;for await(const chunk of createReadStream(file))yield chunk;yield suffix;}
  let response;
  try {
    response=await fetchImpl('https://graph-video.facebook.com/'+version+'/'+job.external_id+'/videos',{
      method:'POST',headers:{Authorization:'Bearer '+pageToken,'Content-Type':'multipart/form-data; boundary='+boundary,'Content-Length':String(prefix.length+info.size+suffix.length)},
      body:Readable.toWeb(Readable.from(stream())),duplex:'half',redirect:'error',signal:AbortSignal.timeout(30*60*1000)
    });
  }catch{
    // No response means that Meta may still have received the video.
    return {status:'UNCERTAIN',error:'VIDEO_NO_DEFINITE_META_RESPONSE'};
  }
  if(!response.ok) {
    // Do not auto retry even a definite rejection: Meta may return ambiguous errors.
    return {status:'FAILED',error:'VIDEO_META_HTTP_'+response.status};
  }
  let data;
  try {data=await response.json();}catch{return {status:'UNCERTAIN',error:'VIDEO_META_INVALID_ACK'};}
  if(!data||!(/^\d+$/.test(String(data.id||''))))return {status:'UNCERTAIN',error:'VIDEO_META_MISSING_ID'};
  // ACK is not a proof the asynchronous processing ended / that the video is visible.
  return {status:'SUBMITTED',videoId:String(data.id)};
}
export function createVideoAutomation({store,env=process.env,fetchImpl=globalThis.fetch,clock=Date.now}={}){
  let armed=false,busy=false, timer=null;
  const ready=()=>env.TOOLPAGE_LIVE_PUBLISH==='1';
  const tokenFor=externalId=>{
    const key='TOOLPAGE_PAGE_TOKEN_'+externalId;
    return env[key]||null;
  };
  const status=()=>({armed,live_opt_in:ready(),active:busy,configured_tokens:store.configs().filter(x=>x.origin==='meta'&&Boolean(tokenFor(x.external_id))).length});
  function arm(body){
    if(body?.confirm!==true)throw apiError(400,'VIDEO_ARM_CONFIRM_REQUIRED');
    if(!ready())throw apiError(409,'VIDEO_LIVE_ENV_DISABLED');
    if(!store.configs().some(x=>x.enabled===1&&x.origin==='meta'&&tokenFor(x.external_id)))throw apiError(409,'VIDEO_NO_READY_META_PAGES');
    armed=true;return status();
  }
  function disarm(){armed=false;return status();}
  async function tick(){
    if(busy)return {busy:true};busy=true;
    try{
      const scan=store.scan();
      if(!armed || !ready())return {scan,processed:0,armed};
      // Never claim a job if no usable page token (prevents blocking other due Pages).
      const due=store.db.prepare("SELECT j.id,j.page_id,p.external_id FROM video_jobs j JOIN pages p ON j.page_id=p.id JOIN video_folder_configs c ON c.page_id=j.page_id WHERE j.status='READY' AND j.scheduled_at<=? AND c.enabled=1 AND p.origin='meta' ORDER BY j.scheduled_at,j.id LIMIT 100").all(new Date(clock()).toISOString());
      const target=due.find(x=>tokenFor(x.external_id));
      if(!target)return {scan,processed:0,armed};
      const chosen=store.db.prepare("SELECT j.*,c.folder_path,c.caption,p.external_id,p.origin FROM video_jobs j JOIN video_folder_configs c ON j.page_id=c.page_id JOIN pages p ON j.page_id=p.id WHERE j.id=?").get(target.id);
      const updated=store.db.prepare("UPDATE video_jobs SET status='UPLOADING',attempt_count=attempt_count+1,updated_at=? WHERE id=? AND status='READY'").run(new Date(clock()).toISOString(),target.id);
      if(!updated.changes)return {scan,processed:0,armed};
      let result;
      try{
        result=await uploadPageVideo({job:chosen,pageToken:tokenFor(chosen.external_id),fetchImpl,version:/^v\d{2}\.\d$/.test(env.TOOLPAGE_GRAPH_VERSION||'')?env.TOOLPAGE_GRAPH_VERSION:'v26.0'});
      }catch(e){
        // Before fetch, file validation errors are definite. Else conservative uncertain.
        const certain=e.code?.startsWith('VIDEO_FILE_')||e.code==='VIDEO_FOLDER_NOT_FOUND'||e.code==='VIDEO_FOLDER_INDIRECT_PATH'||e.code==='VIDEO_INVALID_FILE_NAME';
        result={status:certain?'FAILED':'UNCERTAIN',error:certain?e.code:'VIDEO_UPLOAD_OUTCOME_UNKNOWN'};
      }
      store.finish(chosen.id,result.status,result.videoId??null,result.error??null);
      return {scan,processed:1,result:{id:chosen.id,status:result.status,error:result.error??null}};
    }finally{busy=false;}
  }
  function start(){
    if(timer)return;
    timer=setInterval(()=>{tick().catch(()=>{});},30_000);
    timer.unref?.();
    // Initial scan is permitted; live is never armed on restart.
    tick().catch(()=>{});
  }
  function stop(){if(timer){clearInterval(timer);timer=null;}armed=false;}
  return {status,arm,disarm,tick,start,stop};
}
