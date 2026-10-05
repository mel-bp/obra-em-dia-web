const cfg=window.OBRA_SUPABASE,body=document.querySelector('#schedule-body'),toast=document.querySelector('#toast');
let db=null,user=null,profile=null,projects=[],tasks=[],activeFilter='all',selectedProject=null,originalWorkbook=null,originalFileName='',scheduleMetadataCache=new Map(),plannedFinishDate='',passwordRecoveryMode=location.hash.includes('type=recovery')||location.hash.includes('type=invite');
const $=selector=>document.querySelector(selector),changed=t=>!t.summary&&t.actual!==t.originalActual;
const esc=v=>String(v??'').replace(/[&<>\'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
function notify(message){toast.textContent=message;toast.classList.add('show');setTimeout(()=>toast.classList.remove('show'),4000)}
function key(value){return String(value??'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9%]/g,'')}
function projectNameKey(name){return String(name??'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').trim().replace(/\s+/g,' ').toLocaleLowerCase('pt-BR')}
function uniqueProjects(rows){
  const byName=new Map();
  for(const project of rows||[]){
    const name=projectNameKey(project.name),current=byName.get(name);
    const projectHasSchedule=Boolean(project.source_file),currentHasSchedule=Boolean(current?.source_file);
    const projectDate=Date.parse(project.created_at||'')||0,currentDate=Date.parse(current?.created_at||'')||0;
    if(!current||(projectHasSchedule&&!currentHasSchedule)||(projectHasSchedule===currentHasSchedule&&projectDate>currentDate))byName.set(name,project);
  }
  return [...byName.values()].sort((a,b)=>String(a.name||'').localeCompare(String(b.name||''),'pt-BR',{sensitivity:'base'}));
}
function find(headers,names){return headers.findIndex(h=>names.some(n=>h===n||h.includes(n)))}
function percent(value){if(value===undefined||value===null||value==='')return 0;const raw=String(value).trim(),hasPercent=raw.includes('%'),source=raw.replace('%',''),normalized=source.includes(',')?source.replace(/\./g,'').replace(',','.'):source,n=Number(normalized);if(!Number.isFinite(n))return 0;return Math.round(Math.max(0,Math.min(100,!hasPercent&&n>=0&&n<=1?n*100:n)))}
function headerRow(rows){let best={index:-1,score:0};rows.slice(0,30).forEach((row,index)=>{const h=row.map(key),score=['atividade','tarefa','task','nome','eap','wbs','id','resumo','planejado','previsto','concluido','realizado','avanco'].filter(word=>h.some(x=>x.includes(word))).length;if(score>best.score)best={index,score}});return best.score?best.index:-1}
function setLoginMessage(text,isError=true){$('#login-message').textContent=text;$('#login-message').style.color=isError?'var(--red)':'var(--teal)'}
function setRecoveryMessage(text,isError=true){const target=passwordRecoveryMode?'#password-message':'#forgot-message';$(target).textContent=text;$(target).style.color=isError?'var(--red)':'var(--teal)'}
function setLoginView(view){
  $('#login-form').hidden=view!=='login';
  $('#forgot-password-form').hidden=view!=='forgot';
  $('#password-recovery-form').hidden=view!=='recovery';
  if(view==='forgot'){$('#forgot-email').value=$('#login-email').value;setRecoveryMessage('')}
  if(view==='recovery')setRecoveryMessage('');
}
async function start(){
  if(!window.supabase||!cfg?.url||!cfg?.publishableKey){setLoginMessage('Não consegui carregar a conexão do Supabase. Atualize a página ou confira a configuração.');return}
  db=window.supabase.createClient(cfg.url,cfg.publishableKey);
  if(passwordRecoveryMode)setLoginView('recovery');
  db.auth.onAuthStateChange((event,session)=>{
    if(event==='PASSWORD_RECOVERY'){passwordRecoveryMode=true;setLoginView('recovery');return}
    if(passwordRecoveryMode)return;
    if(event==='SIGNED_IN'&&session?.user)void enterApp(session.user);
    else if(event==='SIGNED_OUT')leaveApp();
  });
  const {data:{session}}=await db.auth.getSession();
  if(session&&!passwordRecoveryMode)await enterApp(session.user);
}
async function enterApp(authUser){user=authUser;const {data:p,error}=await db.from('profiles').select('id,email,display_name,role').eq('id',user.id).maybeSingle();if(error||!p){leaveApp();setLoginMessage('Perfil não encontrado. Execute schema.sql e confirme seu perfil no Supabase.');return}profile=p;$('#login-screen').hidden=true;$('#app-main').hidden=false;$('#logout-button').hidden=false;$('#avatar').textContent=(p.display_name||p.email||'?').slice(0,2).toUpperCase();$('#user-label').textContent=p.display_name||p.email;$('#role-label').textContent=p.role==='admin'?'Planejamento':'Engenheiro';$('#admin-tools').hidden=p.role!=='admin';$('#open-assign-engineer').hidden=p.role!=='admin';$('#admin-submissions').hidden=p.role!=='admin';$('#engineer-panel').hidden=p.role==='admin';$('#export-button').hidden=p.role!=='admin';await loadProjects();if(p.role==='admin')await loadSubmissions() }
function leaveApp(){user=null;profile=null;projects=[];tasks=[];selectedProject=null;$('#app-main').hidden=true;$('#login-screen').hidden=false;$('#logout-button').hidden=true;$('#project-select').innerHTML='<option value="">Selecione uma obra</option>';if(!passwordRecoveryMode)setLoginView('login');render()}
$('#login-form').addEventListener('submit',async e=>{
  e.preventDefault();
  if(!db){setLoginMessage('A conexão de autenticação não foi inicializada. Atualize a página e tente novamente.');return}
  const button=$('#login-form button[type="submit"]');button.disabled=true;setLoginMessage('Entrando…',false);
  try{
    const {error}=await db.auth.signInWithPassword({email:$('#login-email').value.trim(),password:$('#login-password').value});
    if(error){
      const code=String(error.code||'').toLowerCase(),message=String(error.message||'').toLowerCase();
      console.warn('Falha de autenticação Supabase:',code||'sem código');
      if(code==='over_request_rate_limit'||code==='too_many_requests')setLoginMessage('Muitas tentativas de acesso. Aguarde alguns minutos e tente novamente.');
      else if(code==='email_not_confirmed')setLoginMessage('A conta ainda não foi ativada. Abra o link de convite recebido por e-mail ou solicite um novo convite ao administrador.');
      else if(message.includes('failed to fetch')||message.includes('networkerror')||message.includes('fetch failed'))setLoginMessage('Não foi possível conectar ao serviço de autenticação. Verifique sua conexão e tente novamente.');
      else setLoginMessage('Não foi possível entrar. Confira o e-mail e a senha ou use “Esqueci minha senha” para redefinir o acesso.');
    }
  }catch(error){console.error('Erro inesperado no login:',error);setLoginMessage('Não foi possível conectar ao serviço de autenticação. Tente novamente.');}
  finally{button.disabled=false}
});
$('#show-forgot-password').onclick=()=>setLoginView('forgot');
$('#back-to-login').onclick=()=>setLoginView('login');
$('#forgot-password-form').addEventListener('submit',async e=>{
  e.preventDefault();const button=$('#send-reset-link');button.disabled=true;setRecoveryMessage('Enviando instruções…',false);
  const {error}=await db.auth.resetPasswordForEmail($('#forgot-email').value.trim(),{redirectTo:window.location.origin+window.location.pathname});
  button.disabled=false;
  if(error){setRecoveryMessage('Não foi possível enviar o e-mail agora. Tente novamente em alguns minutos.');return}
  setRecoveryMessage('Se esse e-mail estiver cadastrado, você receberá um link para redefinir a senha. Verifique também a caixa de spam.',false);
});
$('#password-recovery-form').addEventListener('submit',async e=>{
  e.preventDefault();const password=$('#new-password').value,confirmation=$('#confirm-password').value;
  if(password!==confirmation){setRecoveryMessage('As senhas não coincidem.');return}
  if(password.length<6){setRecoveryMessage('Use uma senha com pelo menos 6 caracteres.');return}
  const button=$('#save-new-password');button.disabled=true;setRecoveryMessage('Salvando nova senha…',false);
  const {error}=await db.auth.updateUser({password});
  button.disabled=false;
  if(error){setRecoveryMessage('Não foi possível atualizar a senha. Solicite um novo link e tente novamente.');return}
  passwordRecoveryMode=false;await db.auth.signOut();$('#new-password').value='';$('#confirm-password').value='';
  setLoginView('login');setLoginMessage('Senha definida com sucesso. Entre com sua nova senha.',false);
});
$('#logout-button').onclick=async()=>{await db.auth.signOut();notify('Você saiu do app.')};

function updateEngineerRowButtons(){
  const rows=[...$('#engineer-registration-rows').querySelectorAll('.engineer-registration-row')];
  rows.forEach((row,index)=>{const button=row.querySelector('.remove-engineer-row');button.hidden=rows.length===1;button.setAttribute('aria-label','Remover engenheiro '+(index+1))});
}
function addEngineerRegistrationRow(){
  const row=document.createElement('div');
  row.className='engineer-registration-row';
  row.innerHTML='<label>Nome do engenheiro<input class="registration-engineer-name" type="text" maxlength="120" autocomplete="name" required></label><label>E-mail do engenheiro<input class="registration-engineer-email" type="email" maxlength="254" autocomplete="email" required></label><button class="button secondary remove-engineer-row" type="button" aria-label="Remover engenheiro">−</button>';
  row.querySelector('.remove-engineer-row').onclick=()=>{row.remove();updateEngineerRowButtons()};
  $('#engineer-registration-rows').append(row);
  updateEngineerRowButtons();
}
$('#open-project-registration').onclick=()=>{$('#project-registration-message').textContent='';$('#project-registration-dialog').showModal()};
$('#open-project-list').onclick=()=>{window.location.href='./projects.html'};
$('#close-project-registration').onclick=()=>$('#project-registration-dialog').close();
$('#cancel-project-registration').onclick=()=>$('#project-registration-dialog').close();
$('#add-engineer-row').onclick=addEngineerRegistrationRow;
$('#project-registration-dialog').addEventListener('close',()=>{
  $('#project-registration-form').reset();
  $('#engineer-registration-rows').querySelectorAll('.engineer-registration-row').forEach((row,index)=>{if(index>0)row.remove()});
  updateEngineerRowButtons();
  $('#project-registration-message').textContent='';
});
$('#project-registration-form').addEventListener('submit',async event=>{
  event.preventDefault();
  const form=$('#project-registration-form'),button=$('#register-project-button'),message=$('#project-registration-message');
  const name=$('#registration-project-name').value.trim();
  const engineers=[...$('#engineer-registration-rows').querySelectorAll('.engineer-registration-row')].map(row=>({name:row.querySelector('.registration-engineer-name').value.trim(),email:row.querySelector('.registration-engineer-email').value.trim().toLowerCase()}));
  const emails=new Set();
  for(const engineer of engineers){
    if(emails.has(engineer.email)){message.textContent='O mesmo e-mail foi informado mais de uma vez.';return}
    emails.add(engineer.email);
  }
  button.disabled=true;button.textContent='Cadastrando…';message.textContent='Cadastrando o projeto e vinculando os engenheiros…';
  try{
    const {data,error}=await db.functions.invoke('register-project',{body:{name,engineers}});
    if(error||data?.error){message.textContent=data?.error||error.message||'Não foi possível cadastrar o projeto.';return}
    const results=data.results||[],failed=results.filter(item=>item.status==='error'),invited=results.filter(item=>item.status==='invited').length,associated=results.filter(item=>item.status==='associated').length;
    await loadProjects(data.projectId);
    const summary=(data.created?'Projeto cadastrado.':'Projeto já existente; engenheiros vinculados a ele.')+' '+invited+' convite(s) enviado(s), '+associated+' conta(s) existente(s) vinculada(s).';
    if(failed.length){
      message.textContent=summary+' Pendências: '+failed.map(item=>item.name+' ('+item.email+'): '+item.message).join(' ');
      notify('Projeto salvo. Confira as pendências de convite na janela.');
      return;
    }
    $('#project-registration-dialog').close();
    notify(summary);
  }catch(error){
    console.error('Falha ao cadastrar projeto:',error);
    message.textContent='Não foi possível concluir o cadastro. Tente novamente.';
  }finally{
    button.disabled=false;button.textContent='CADASTRO REALIZADO';
  }
});

async function loadProjects(preferredId){
  const {data,error}=await db.from('projects').select('id,name,source_file,created_at').order('name');
  if(error){notify('Não consegui carregar as obras. '+error.message);return}
  const allProjects=data||[];
  projects=uniqueProjects(allProjects);
  const select=$('#project-select');
  select.innerHTML='<option value="">Selecione uma obra</option>'+projects.map(p=>'<option value="'+esc(p.id)+'">'+esc(p.name)+'</option>').join('');
  const importSelect=$('#import-project-select');
  if(importSelect)importSelect.innerHTML='<option value="">Selecione uma obra</option>'+projects.map(p=>'<option value="'+esc(p.id)+'">'+esc(p.name)+'</option>').join('');
  const requestedId=preferredId||selectedProject;
  const requested=allProjects.find(p=>p.id===requestedId);
  const canonical=requested&&projects.find(p=>projectNameKey(p.name)===projectNameKey(requested.name));
  const wanted=canonical?.id||projects[0]?.id||'';
  if(wanted){select.value=wanted;await loadProject(wanted)}else{selectedProject=null;tasks=[];render()}
  $('#open-assign-engineer').disabled=!projects.length;
}
$('#project-select').onchange=()=>loadProject($('#project-select').value);
function scheduleDateText(value){
  if(value instanceof Date&&!Number.isNaN(value.getTime()))return value.toLocaleDateString('pt-BR',{timeZone:'UTC'});
  const text=String(value??'').trim(),iso=text.match(/^(\d{4})-(\d{2})-(\d{2})(?:$|[T\s])/);
  if(iso)return iso[3]+'/'+iso[2]+'/'+iso[1];
  const br=text.match(/^(\d{1,2})[/.](\d{1,2})[/.](\d{2,4})(?=$|\s)/);
  if(br)return br[1].padStart(2,'0')+'/'+br[2].padStart(2,'0')+'/'+br[3];
  const time=text.search(/\s+\d{1,2}:\d{2}(?::\d{2})?\b/);
  return time>=0?text.slice(0,time).trim():text;
}
async function recoverScheduleMetadata(projectId,sourceFile,activities){
  const empty={dimensions:new Map(),plannedFinish:''};
  if(!projectId||!sourceFile||!(activities||[]).length)return empty;
  const cacheKey=projectId+'/'+sourceFile;
  if(scheduleMetadataCache.has(cacheKey))return scheduleMetadataCache.get(cacheKey);
  const metadata={dimensions:new Map(),plannedFinish:''};
  try{
    const {data:file,error}=await db.storage.from('schedule-files').download(cacheKey);
    if(error||!file)throw error||Error('Arquivo original indisponível.');
    const workbook=XLSX.read(await file.arrayBuffer(),{type:'array',raw:false,cellDates:true});
    const sheetNames=[...new Set((activities||[]).map(activity=>activity.source_sheet).filter(Boolean))];
    for(const sheetName of sheetNames){
      const worksheet=workbook.Sheets[sheetName];
      if(!worksheet)continue;
      const rows=XLSX.utils.sheet_to_json(worksheet,{header:1,defval:'',raw:false});
      const headingIndex=headerRow(rows);
      if(headingIndex<0)continue;
      const headers=rows[headingIndex].map(key);
      const columns={
        macro:find(headers,['macro']),
        sector:find(headers,['setor','sector']),
        local:find(headers,['local','location']),
        finish:find(headers,['termino','finish','enddate'])
      };
      for(const activity of (activities||[]).filter(item=>item.source_sheet===sheetName)){
        const sourceIndex=Number(activity.source_row);
        if(!Number.isInteger(sourceIndex)||sourceIndex<0)continue;
        const row=rows[sourceIndex];
        if(!row)continue;
        if(columns.finish>=0&&Number(activity.activity_id)===1){
          metadata.plannedFinish=scheduleDateText(row[columns.finish]);
        }
        if(columns.macro<0&&columns.sector<0&&columns.local<0)continue;
        metadata.dimensions.set(activity.id,{
          macro:columns.macro<0?'':String(row[columns.macro]??'').trim(),
          sector:columns.sector<0?'':String(row[columns.sector]??'').trim(),
          local:columns.local<0?'':String(row[columns.local]??'').trim(),
          sourceMacroColumn:columns.macro<0?null:columns.macro,
          sourceSectorColumn:columns.sector<0?null:columns.sector,
          sourceLocalColumn:columns.local<0?null:columns.local
        });
      }
    }
    scheduleMetadataCache.set(cacheKey,metadata);
    return metadata;
  }catch(error){
    console.warn('Não foi possível ler os dados do cronograma original.',error?.message||'');
    return metadata;
  }
}
async function loadProject(projectId){selectedProject=projectId;const project=projects.find(p=>p.id===projectId);if(!project){tasks=[];populateDimensionFilters();$('#export-button').disabled=true;$('#send-update').disabled=true;$('#open-assign-engineer').disabled=true;render();return}$('#open-assign-engineer').disabled=false;$('#project-name').innerHTML=`<span class="dot"></span> ${esc(project.name)} <small>• ${project.source_file?'cronograma carregado':'obra'}</small>`;$('#export-button').disabled=!project.source_file;$('#send-update').disabled=true;const {data:activities,error}=await db.from('activities').select('*').eq('project_id',projectId).eq('is_current',true).order('sort_order');if(error){notify('Falha ao carregar atividades: '+error.message);return}const {data:progress,error:progressError}=await db.rpc('latest_schedule_progress',{p_project_id:projectId});if(progressError){notify('Falha ao carregar atualizações: '+progressError.message);return}const latest=progress?.length?{id:progress[0].submission_id,submitted_at:progress[0].submitted_at,submitted_by:progress[0].submitted_by}:null;const values=new Map((progress||[]).map(item=>[item.activity_id,Number(item.actual_pct)]));const scheduleMetadata=await recoverScheduleMetadata(projectId,project.source_file,activities||[]);const recoveredDimensions=scheduleMetadata.dimensions;plannedFinishDate=scheduleMetadata.plannedFinish;
tasks=(activities||[]).map(a=>{
  const recovered=recoveredDimensions.get(a.id)||{};
  return {id:a.id,sortOrder:a.sort_order,activityId:a.activity_id,wbs:a.wbs||'',name:a.name,summary:a.is_summary,plan:Number(a.planned_pct),actual:values.has(a.id)?values.get(a.id):Number(a.initial_actual_pct),originalActual:values.has(a.id)?values.get(a.id):Number(a.initial_actual_pct),sourceSheet:a.source_sheet,sourceRow:a.source_row,sourceActualColumn:a.source_actual_column,macro:a.macro??recovered.macro??'',sector:a.sector??recovered.sector??'',local:a.activity_local??recovered.local??'',sourceMacroColumn:a.source_macro_column??recovered.sourceMacroColumn,sourceSectorColumn:a.source_sector_column??recovered.sourceSectorColumn,sourceLocalColumn:a.source_local_column??recovered.sourceLocalColumn}
});
populateDimensionFilters();
$('#send-update').disabled=!tasks.some(t=>!t.summary);let lastUpdateName='';if(latest){const {data:authorRows,error:authorError}=await db.rpc('latest_project_update_author',{p_project_id:projectId});if(!authorError)lastUpdateName=authorRows?.[0]?.engineer_name||'Nome não informado';else if(latest.submitted_by===profile?.id)lastUpdateName=profile.display_name||profile.email||'Nome não informado';else console.warn('Não foi possível carregar o nome do responsável pela última atualização.',authorError.message)}$('#last-update').textContent=latest?new Date(latest.submitted_at).toLocaleDateString('pt-BR'):'Nenhum envio ainda';$('#last-update-engineer').textContent=lastUpdateName;$('#last-update-engineer').hidden=!latest;$('#table-help').textContent=latest?'Percentuais do envio mais recente.':'Cronograma original; aguardando a primeira atualização.';render()}
function normalizeDimensionValue(value){return String(value??'').trim().replace(/\s+/g,' ')}
const dimensionFilterDefinitions=[
  {key:'macro',id:'filter-macro',all:'Todas as macros'},
  {key:'sector',id:'filter-sector',all:'Todos os setores'},
  {key:'local',id:'filter-local',all:'Todos os locais'}
];
function populateDimensionFilters(){
  dimensionFilterDefinitions.forEach(filter=>{
    const select=$('#'+filter.id);
    if(!select)return;
    const unique=new Map();
    tasks.map(task=>normalizeDimensionValue(task[filter.key])).filter(Boolean).forEach(value=>{
      const key=value.toLocaleLowerCase('pt-BR');
      if(!unique.has(key))unique.set(key,value);
    });
    const options=[...unique.values()].sort((a,b)=>a.localeCompare(b,'pt-BR',{numeric:true,sensitivity:'base'}));
    select.innerHTML='<option value="">'+filter.all+'</option>'+options.map(value=>'<option value="'+esc(value)+'">'+esc(value)+'</option>').join('');
    select.disabled=options.length===0;
  });
}
function render(){
  const q=($('#search')?.value||'').toLowerCase();
  const selectedDimensions=Object.fromEntries(dimensionFilterDefinitions.map(filter=>[filter.key,normalizeDimensionValue($('#'+filter.id)?.value).toLocaleLowerCase('pt-BR')]));
  const dimensions=[
    {key:'macro',label:'MACRO',source:'sourceMacroColumn'},
    {key:'sector',label:'SETOR',source:'sourceSectorColumn'},
    {key:'local',label:'LOCAL',source:'sourceLocalColumn'}
  ].filter(column=>tasks.some(task=>task[column.source]!==null&&task[column.source]!==undefined));
  const columnCount=3+dimensions.length;
  const head=$('#schedule-head');
  if(head)head.innerHTML='<th>ID</th>'+dimensions.map(column=>'<th>'+column.label+'</th>').join('')+'<th>% ANTERIOR</th><th>% NOVO DIGITÁVEL</th>';
  if(!tasks.length){
    body.innerHTML='<tr><td colspan="'+columnCount+'" class="empty-state">Selecione uma obra para ver as atividades.</td></tr>';
    ['changed-count','all-count'].forEach(id=>$('#'+id).textContent='0');
    $('#planned-total').textContent='—';$('#global-bar').style.width='0%';$('#planned-finish').textContent='—';$('#last-update').textContent='Nenhum envio ainda';$('#last-update-engineer').textContent='';$('#last-update-engineer').hidden=true;
    return;
  }
  const visible=tasks.filter(task=>task.name.toLowerCase().includes(q)&&dimensionFilterDefinitions.every(filter=>!selectedDimensions[filter.key]||normalizeDimensionValue(task[filter.key]).toLocaleLowerCase('pt-BR')===selectedDimensions[filter.key])&&(activeFilter==='all'||activeFilter==='changed'&&changed(task)));
  body.innerHTML=visible.map(task=>{
    
    const name=esc(task.name)+(task.summary?' <span class="summary-label">RESUMO</span>':'');
    const cells=['<td class="activity-cell" data-label="ID"><span class="task-id">'+esc(task.activityId)+'</span><span class="activity-name-inline">'+name+'</span></td>'];
    if(dimensions.some(column=>column.key==='macro'))cells.push('<td data-label="MACRO">'+esc(task.macro)+'</td>');
    if(dimensions.some(column=>column.key==='sector'))cells.push('<td data-label="SETOR">'+esc(task.sector)+'</td>');
    if(dimensions.some(column=>column.key==='local'))cells.push('<td data-label="LOCAL">'+esc(task.local)+'</td>');
    cells.push('<td class="percent" data-label="% ANTERIOR">'+task.plan+'%</td>');
    cells.push('<td data-label="% NOVO DIGITÁVEL">'+(task.summary?'<span class="not-editable">Não editável</span>':'<input class="actual-input" aria-label="Novo avanço de '+esc(task.name)+'" type="number" inputmode="decimal" min="0" max="100" step="1" value="'+task.actual+'" data-id="'+esc(task.id)+'"/> %')+'</td>');
    return '<tr class="'+(task.summary?'summary-row':'')+' '+(changed(task)?'changed':'')+'">'+cells.join('')+'</tr>';
  }).join('')||'<tr><td colspan="'+columnCount+'" class="empty-state">Nenhuma atividade corresponde ao filtro selecionado.</td></tr>';
  const changes=tasks.filter(task=>!task.summary&&changed(task)).length,globalActivity=tasks.find(task=>Number(String(task.activityId).trim())===1),globalPercent=globalActivity?Math.round(Number(globalActivity.plan)):null;
  $('#changed-count').textContent=changes;$('#all-count').textContent=tasks.length;
  $('#planned-total').textContent=globalPercent===null?'—':globalPercent+'%';$('#global-bar').style.width=globalPercent===null?'0%':Math.max(0,Math.min(100,globalPercent))+'%';
  $('#planned-finish').textContent=plannedFinishDate||'—';
}
body.addEventListener('change',e=>{if(!e.target.matches('.actual-input'))return;const t=tasks.find(x=>x.id===e.target.dataset.id);if(!t)return;t.actual=Math.max(0,Math.min(100,Number(e.target.value)||0));render()});
document.querySelectorAll('.filter').forEach(button=>button.onclick=()=>{activeFilter=button.dataset.filter;document.querySelectorAll('.filter').forEach(x=>x.classList.toggle('active',x===button));render()});$('#search').oninput=render;document.querySelectorAll('.schedule-dimension-filters select').forEach(select=>select.onchange=render);
$('#send-update').onclick=async()=>{if(!selectedProject)return notify('Selecione uma obra antes de enviar.');const items=tasks.filter(t=>!t.summary).map(t=>({activity_id:t.id,actual_pct:t.actual}));const {data,error}=await db.rpc('submit_progress',{target_project:selectedProject,items});if(error)return notify('Não foi possível enviar. '+error.message);tasks.forEach(t=>t.originalActual=t.actual);$('#last-update').textContent=new Date().toLocaleDateString('pt-BR');$('#last-update-engineer').textContent=profile?.display_name||profile?.email||'Nome não informado';$('#last-update-engineer').hidden=false;$('#table-help').textContent='Atualização enviada e registrada no histórico.';render();notify('Atualização enviada ao planejamento.');};
function openScheduleImportDialog(){
  if(!projects.length)return notify('Cadastre uma obra antes de importar um cronograma.');
  const select=$('#import-project-select');
  const currentProject=projects.find(project=>project.id===selectedProject);
  select.value=currentProject?.id||projects[0].id;
  const file=$('#schedule-file').files[0];
  $('#schedule-import-file-context').textContent=file?'Arquivo selecionado: '+file.name:'Nenhum arquivo selecionado. Escolha um arquivo Excel ou CSV antes de confirmar.';
  $('#schedule-import-message').textContent='';
  $('#schedule-import-dialog').showModal();
}
$('#import-button').onclick=openScheduleImportDialog;
$('#close-schedule-import').onclick=()=>$('#schedule-import-dialog').close();
$('#cancel-schedule-import').onclick=()=>$('#schedule-import-dialog').close();
$('#schedule-import-form').addEventListener('submit',async event=>{
  event.preventDefault();
  const button=$('#confirm-schedule-import'),cancel=$('#cancel-schedule-import'),file=$('#schedule-file').files[0],project=projects.find(item=>item.id===$('#import-project-select').value),message=$('#schedule-import-message');
  if(!project){message.textContent='Selecione a obra que receberá este cronograma.';return}
  if(!file){message.textContent='Selecione um arquivo Excel ou CSV antes de confirmar.';return}
  let phase='Lendo o arquivo';
  button.disabled=true;cancel.disabled=true;$('#close-schedule-import').disabled=true;button.textContent='Importando…';message.textContent='Importando o cronograma para '+project.name+'…';
  try{
    const buffer=await file.arrayBuffer(),wb=XLSX.read(buffer,{type:'array',raw:false,cellDates:true});let parsed=null;
    for(const sheetName of wb.SheetNames){const rows=XLSX.utils.sheet_to_json(wb.Sheets[sheetName],{header:1,defval:'',raw:false});const hi=headerRow(rows);if(hi>=0){parsed={sheetName,rows,headerIndex:hi};break}}
    if(!parsed)throw Error('Não encontrei uma aba com atividades.');
    const headers=parsed.rows[parsed.headerIndex].map(key),cols={id:find(headers,['uniqueid','activityid','taskid','uid','id']),name:find(headers,['nomedetarefa','atividade','taskname','tarefa','task','nome']),wbs:find(headers,['eap','wbs','outline']),macro:find(headers,['macro']),sector:find(headers,['setor']),local:find(headers,['local']),summary:find(headers,['resumo','summary']),plan:find(headers,['percentualplanejado','planejado','percentualanterior','anterior','previsto','baseline']),actual:find(headers,['percentualconcluido','percentcomplete','percentualexecutado','executado','realizado','avanco','concluido'])};
    if(cols.name<0)throw Error('Não encontrei a coluna Atividade/Nome da tarefa.');
    if(cols.actual<0)throw Error('Não encontrei a coluna de percentual executado/realizado.');
    const parsedActivities=[];
    parsed.rows.slice(parsed.headerIndex+1).forEach((row,i)=>{const activityName=String(row[cols.name]||'').trim();if(!activityName)return;const actual=percent(row[cols.actual]),plan=cols.plan<0?actual:percent(row[cols.plan]);parsedActivities.push({sort_order:parsedActivities.length,activity_id:String(cols.id<0?parsedActivities.length+1:row[cols.id]||parsedActivities.length+1),wbs:cols.wbs<0?'':String(row[cols.wbs]||''),name:activityName,is_summary:cols.summary>=0&&['sim','s','yes','true','1'].includes(key(row[cols.summary])),planned_pct:plan,initial_actual_pct:actual,source_sheet:parsed.sheetName,source_row:parsed.headerIndex+1+i,source_actual_column:cols.actual,macro:cols.macro<0?'':String(row[cols.macro]??'').trim(),sector:cols.sector<0?'':String(row[cols.sector]??'').trim(),activity_local:cols.local<0?'':String(row[cols.local]??'').trim(),source_macro_column:cols.macro<0?null:cols.macro,source_sector_column:cols.sector<0?null:cols.sector,source_local_column:cols.local<0?null:cols.local})});
    if(!parsedActivities.length)throw Error('Não encontrei atividades abaixo do cabeçalho.');
    phase='Enviando o arquivo original ao armazenamento';
    const safeName=file.name.replace(/[\\/:*?"<>|]/g,'_'),storedFileName=Date.now()+'-'+safeName,path=project.id+'/'+storedFileName;
    const {error:uploadError}=await db.storage.from('schedule-files').upload(path,file,{contentType:file.type||'application/octet-stream',upsert:true});
    if(uploadError)throw uploadError;
    phase='Substituindo o cronograma do projeto';
    const {error:replaceError}=await db.rpc('replace_project_schedule',{p_project_id:project.id,p_source_file:storedFileName,p_activities:parsedActivities});
    if(replaceError){await db.storage.from('schedule-files').remove([path]);throw replaceError}
    $('#schedule-file').value='';
    await loadProjects(project.id);
    $('#schedule-import-dialog').close();
    notify(parsedActivities.length+' atividades importadas para '+project.name+'. Cronograma substituído; os envios anteriores foram preservados no histórico.');
  }catch(error){
    console.error(error);
    const detail=phase+': '+(error.message||'falha inesperada.');
    message.textContent=detail;
    notify(detail);
  }finally{
    button.disabled=false;cancel.disabled=false;$('#close-schedule-import').disabled=false;button.textContent='IMPORTAR CRONOGRAMA';
  }
});

function updateAssignmentRowButtons(){
  const rows=[...$('#assignment-engineer-rows').querySelectorAll('.engineer-registration-row')];
  rows.forEach((row,index)=>{const button=row.querySelector('.remove-engineer-row');button.hidden=rows.length===1;button.setAttribute('aria-label','Remover engenheiro '+(index+1))});
  $('#add-assignment-engineer').disabled=rows.length>=25;
}
function addAssignmentEngineerRow(){
  const row=document.createElement('div');
  row.className='engineer-registration-row';
  row.innerHTML='<label>Nome do engenheiro<input class="registration-engineer-name" type="text" maxlength="120" autocomplete="name" required></label><label>E-mail do engenheiro<input class="registration-engineer-email" type="email" maxlength="254" autocomplete="email" required></label><button class="button secondary remove-engineer-row" type="button" aria-label="Remover engenheiro">−</button>';
  row.querySelector('.remove-engineer-row').onclick=()=>{row.remove();updateAssignmentRowButtons()};
  $('#assignment-engineer-rows').append(row);
  updateAssignmentRowButtons();
}
$('#open-assign-engineer').onclick=()=>{
  const project=projects.find(item=>item.id===selectedProject);
  if(!project)return notify('Selecione uma obra antes de atribuir engenheiros.');
  $('#assignment-project-name').textContent=project.name;
  $('#assignment-engineer-message').textContent='';
  $('#engineer-assignment-dialog').showModal();
};
$('#close-engineer-assignment').onclick=()=>$('#engineer-assignment-dialog').close();
$('#cancel-engineer-assignment').onclick=()=>$('#engineer-assignment-dialog').close();
$('#add-assignment-engineer').onclick=addAssignmentEngineerRow;
$('#engineer-assignment-dialog').addEventListener('close',()=>{
  $('#engineer-assignment-form').reset();
  $('#assignment-engineer-rows').querySelectorAll('.engineer-registration-row').forEach((row,index)=>{if(index>0)row.remove()});
  updateAssignmentRowButtons();
  $('#assignment-engineer-message').textContent='';
});
$('#engineer-assignment-form').addEventListener('submit',async event=>{
  event.preventDefault();
  if(!selectedProject)return notify('Selecione uma obra antes de atribuir engenheiros.');
  const button=$('#assign-engineers-submit'),message=$('#assignment-engineer-message');
  const engineers=[...$('#assignment-engineer-rows').querySelectorAll('.engineer-registration-row')].map(row=>({name:row.querySelector('.registration-engineer-name').value.trim(),email:row.querySelector('.registration-engineer-email').value.trim().toLowerCase()}));
  const emails=new Set();
  for(const engineer of engineers){
    if(emails.has(engineer.email)){message.textContent='O mesmo e-mail foi informado mais de uma vez.';return}
    emails.add(engineer.email);
  }
  button.disabled=true;button.textContent='Atribuindo…';message.textContent='Vinculando engenheiros à obra…';
  try{
    const {data,error}=await db.functions.invoke('register-project',{body:{projectId:selectedProject,engineers}});
    if(error||data?.error){message.textContent=data?.error||error.message||'Não foi possível atribuir os engenheiros.';return}
    const results=data.results||[],failed=results.filter(item=>item.status==='error'),invited=results.filter(item=>item.status==='invited').length,associated=results.filter(item=>item.status==='associated').length;
    await loadProjects(selectedProject);
    if(failed.length){
      message.textContent=invited+' convite(s) enviado(s), '+associated+' conta(s) existente(s) vinculada(s). Pendências: '+failed.map(item=>item.name+' ('+item.email+'): '+item.message).join(' ');
      notify('Atribuição parcial. Confira as pendências na janela.');
      return;
    }
    $('#engineer-assignment-dialog').close();
    notify(invited+' convite(s) enviado(s), '+associated+' conta(s) existente(s) vinculada(s) à obra.');
  }catch(error){
    console.error('Falha ao atribuir engenheiros:',error);
    message.textContent='Não foi possível concluir a atribuição. Tente novamente.';
  }finally{
    button.disabled=false;button.textContent='ATRIBUIR ENGENHEIRO';
  }
});

async function loadSubmissions(){const {data:s,error}=await db.from('submissions').select('id,project_id,submitted_by,submitted_at').order('submitted_at',{ascending:false}).limit(20);if(error){$('#submission-list').textContent=error.message;return}if(!s?.length){$('#submission-list').textContent='Nenhuma atualização recebida ainda.';return}const projectIds=[...new Set(s.map(x=>x.project_id))],userIds=[...new Set(s.map(x=>x.submitted_by))];const [{data:p},{data:u}]=await Promise.all([db.from('projects').select('id,name').in('id',projectIds),db.from('profiles').select('id,email,display_name').in('id',userIds)]);const pm=new Map((p||[]).map(x=>[x.id,x.name])),um=new Map((u||[]).map(x=>[x.id,x.display_name||x.email]));$('#submission-list').innerHTML=s.map(x=>`<div class="submission-row"><span><b>${esc(pm.get(x.project_id)||'Obra')}</b><br><small>${esc(um.get(x.submitted_by)||'Engenheiro')}</small></span><small>${new Date(x.submitted_at).toLocaleString('pt-BR')}</small></div>`).join('')}
$('#export-button').onclick=async()=>{if(!selectedProject)return notify('Selecione uma obra para exportar.');const project=projects.find(p=>p.id===selectedProject);if(!project)return;if(!project.source_file)return notify('Este projeto ainda não tem cronograma para exportar.');const path=`${project.id}/${project.source_file}`;const {data:file,error}=await db.storage.from('schedule-files').download(path);if(error)return notify('Falha ao baixar o original. '+error.message);try{const wb=XLSX.read(await file.arrayBuffer(),{type:'array',raw:false,cellDates:true});for(const t of tasks){if(t.summary||t.sourceActualColumn===null||t.sourceActualColumn===undefined)continue;const ws=wb.Sheets[t.sourceSheet];if(!ws)continue;const addr=XLSX.utils.encode_cell({r:t.sourceRow,c:t.sourceActualColumn});const cell=ws[addr]||{};const fraction=(String(cell.z||'').includes('%')||(typeof cell.v==='number'&&cell.v>=0&&cell.v<=1));ws[addr]={...cell,t:'n',v:fraction?t.actual/100:t.actual}}XLSX.writeFile(wb,`${project.name.replace(/[\\/:*?"<>|]/g,'_')}_atualizado.xlsx`);notify('Excel atualizado baixado.')}catch(e){notify('Falha ao gerar o Excel. '+e.message)}};
window.addEventListener('focus',()=>{if(profile?.role==='admin')loadSubmissions()});setInterval(()=>{if(profile?.role==='admin')loadSubmissions()},60000);
render();start();