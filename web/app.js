'use strict';
const $=id=>document.getElementById(id);
const names={home:['Tổng quan','Quản lý khoảng 10 Page Facebook trong một nơi.'],pages:['Danh sách Page','Tất cả Page local và Page đồng bộ từ Meta.'],groups:['Nhóm Page','Phân loại Page và xem số thành viên.'],connect:['Kết nối Facebook','Kết nối Page có quyền qua Graph API chính thức.'],drafts:['Bài nháp','Soạn và lưu bản nháp, chưa đăng Facebook.'],future:['Sắp triển khai','Xem danh mục chức năng để chọn phạm vi.']};
let state={pages:[],groups:[],drafts:[]},status={};
function node(tag,text,cls){const el=document.createElement(tag);if(text!==undefined)el.textContent=String(text);if(cls)el.className=cls;return el;}
function show(msg,error=false){$('toast').textContent=msg;$('toast').classList.toggle('error',error);}
async function api(route,method='GET',body){
 const opts={method,headers:{}};
 if(method!=='GET'){opts.headers['Content-Type']='application/json';opts.headers['X-ToolPage-Action']='1';opts.body=JSON.stringify(body||{});}
 const response=await fetch(route,opts),obj=await response.json();
 if(!response.ok)throw new Error(obj.error||'HTTP_'+response.status);
 return obj;
}
const select=(options,value,onChange)=>{const s=node('select');for(const [v,label] of options){const o=node('option',label);o.value=String(v);s.append(o);}s.value=String(value??'');s.addEventListener('change',()=>onChange(s.value));return s;};
function renderPages(){
 const groupOptions=[['','Không nhóm'],...state.groups.map(g=>[g.id,g.name])],body=$('page-rows');body.replaceChildren();
 $('page-count').textContent=state.pages.length+' / 10';
 if(!state.pages.length){const tr=node('tr'),td=node('td','Chưa có Page. Thêm local hoặc kết nối Meta.','empty');td.colSpan=4;tr.append(td);body.append(tr);}
 for(const p of state.pages){
  const tr=node('tr');
  const a=node('td'),strong=node('div',p.name,'rowname');a.append(strong,node('small',p.external_id||p.id));
  const origin=node('td');origin.append(node('span',p.origin==='meta'?'META · metadata':'LOCAL · nhãn','tag'));
  const g=node('td');g.append(select(groupOptions,p.group_id||'',async v=>{try{await api('/api/pages/'+encodeURIComponent(p.id)+'/group','PATCH',{group_id:v||null});await reload();show('Đã chuyển nhóm.');}catch(e){show(e.message,true);await reload();}}));
  const actions=node('td'),remove=node('button','Xóa','action danger');remove.type='button';remove.addEventListener('click',()=>erasePage(p));actions.append(remove);
  tr.append(a,origin,g,actions);body.append(tr);
 }
}
function renderGroups(){
 const root=$('group-rows');root.replaceChildren();
 if(!state.groups.length)root.append(node('p','Chưa có nhóm Page.','empty'));
 for(const g of state.groups){
  const row=node('div',undefined,'item itemtop'),desc=node('div'),del=node('button','Xóa nhóm','action danger');
  desc.append(node('strong',g.name),node('p',g.page_count+' Page · Xóa nhóm không xóa Page'));
  del.addEventListener('click',async()=>{if(!confirm('Xóa nhóm '+g.name+'? Page sẽ trở về Không nhóm.'))return;try{await api('/api/groups/'+g.id,'DELETE');await reload();show('Đã xóa nhóm.');}catch(e){show(e.message,true);}});
  row.append(desc,del);root.append(row);
 }
}
function renderDrafts(){
 const options=state.pages.map(p=>[p.id,p.name]);const selectEl=$('draft-page'),old=selectEl.value;
 selectEl.replaceChildren();for(const [val,label] of options){const opt=node('option',label);opt.value=val;selectEl.append(opt);}if(options.some(x=>x[0]===old))selectEl.value=old;
 const root=$('draft-rows');root.replaceChildren();
 if(!state.drafts.length)root.append(node('p','Chưa có bản nháp.','empty'));
 for(const d of state.drafts){
  const item=node('div',undefined,'item'),top=node('div',undefined,'itemtop'),title=node('strong',d.page_name),buttons=node('div'),edit=node('button','Sửa','action'),del=node('button','Xóa','action danger');
  edit.addEventListener('click',async()=>{const value=prompt('Sửa nội dung bản nháp:',d.content);if(value===null)return;try{await api('/api/drafts/'+d.id,'PATCH',{content:value});await reload();show('Đã sửa bản nháp.');}catch(e){show(e.message,true);}});
  del.addEventListener('click',async()=>{if(!confirm('Xóa bản nháp này?'))return;try{await api('/api/drafts/'+d.id,'DELETE');await reload();show('Đã xóa bản nháp.');}catch(e){show(e.message,true);}});
  buttons.append(edit,del);top.append(title,buttons);item.append(top,node('p',d.content),node('span',d.scheduled_at?'Dự kiến: '+new Date(d.scheduled_at).toLocaleString('vi-VN')+' · CHƯA TỰ ĐĂNG':'Bản nháp chưa lên lịch','tag'));root.append(item);
 }
}
function render(){
 $('stat-pages').textContent=state.pages.length;$('stat-groups').textContent=state.groups.length;$('stat-drafts').textContent=state.drafts.length;
 $('meta-chip').textContent=status.meta_configured?'META: ĐÃ CẤU HÌNH':'META: CHƯA CẤU HÌNH';
 $('meta-state').textContent=status.meta_configured?'Đã cấu hình token từ môi trường':'Chưa có Meta user access token';
 $('sync-meta').disabled=!status.meta_configured;
 const home=$('home-pages');home.replaceChildren();
 if(!state.pages.length)home.append(node('p','Chưa có Page nào trong workspace.','empty'));
 for(const p of state.pages.slice(0,6)){const row=node('div',undefined,'checkrow');row.append(node('b','f'),node('div',p.name+(p.origin==='meta'?' · META':' · LOCAL')));home.append(row);}
 renderPages();renderGroups();renderDrafts();
}
async function reload(){const [s,rows]=await Promise.all([api('/api/status'),api('/api/state')]);status=s;state=rows;const q=$('page-search').value.trim().toLocaleLowerCase('vi');if(q)state.pages=rows.pages.filter(p=>p.name.toLocaleLowerCase('vi').includes(q)||p.id.toLowerCase().includes(q));render();}
function changeView(name){
 if(!(name in names))name='home';
 document.querySelectorAll('.view').forEach(el=>el.classList.toggle('hidden',el.id!==name));
 document.querySelectorAll('[data-view]').forEach(el=>el.classList.toggle('active',el.dataset.view===name));
 $('view-title').textContent=names[name][0];$('crumb').textContent=names[name][0].toUpperCase();$('view-subtitle').textContent=names[name][1];show('');
}
async function erasePage(p){if(!confirm('Xóa Page local '+p.name+' khỏi workspace? Không xóa Facebook Page thật.'))return;try{await api('/api/pages/'+encodeURIComponent(p.id),'DELETE');await reload();show('Đã xóa khỏi workspace.');}catch(e){show(e.message,true);}}
document.addEventListener('click',e=>{const btn=e.target.closest('[data-view]');if(btn)changeView(btn.dataset.view);});
$('page-search').addEventListener('input',()=>{const q=$('page-search').value.trim().toLocaleLowerCase('vi');api('/api/state').then(v=>{state.pages=v.pages.filter(p=>p.name.toLocaleLowerCase('vi').includes(q)||p.id.toLowerCase().includes(q));renderPages();}).catch(e=>show(e.message,true));});
$('page-form').addEventListener('submit',async e=>{e.preventDefault();try{await api('/api/pages','POST',{name:$('page-name').value});$('page-name').value='';await reload();show('Đã thêm Page local (chưa kết nối Facebook).');}catch(x){show(x.message,true);}});
$('group-form').addEventListener('submit',async e=>{e.preventDefault();try{await api('/api/groups','POST',{name:$('group-name').value});$('group-name').value='';await reload();show('Đã tạo nhóm.');}catch(x){show(x.message,true);}});
$('draft-form').addEventListener('submit',async e=>{e.preventDefault();const local=$('draft-date').value;const scheduled=local?new Date(local).toISOString():null;try{await api('/api/drafts','POST',{page_id:$('draft-page').value,content:$('draft-content').value,scheduled_at:scheduled});$('draft-content').value='';$('draft-date').value='';await reload();show('Đã lưu bản nháp. Chưa đăng Facebook.');}catch(x){show(x.message,true);}});
$('sync-meta').addEventListener('click',async()=>{if(!confirm('Đồng bộ tên/ID của các Facebook Page bạn có quyền quản lý?'))return;try{const result=await api('/api/meta/sync','POST',{});await reload();show('Đã đồng bộ '+result.synced+' Page, bỏ qua '+result.skipped+'.'+(result.truncated?' Còn Page ngoài trang đầu.':''));}catch(x){show(x.message,true);}});
changeView('home');reload().catch(e=>show('Không kết nối được localhost API: '+e.message,true));