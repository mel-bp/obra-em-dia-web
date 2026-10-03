const cfg=window.OBRA_SUPABASE,body=document.querySelector('#schedule-body'),toast=document.querySelector('#toast');
let db=null,user=null,profile=null,projects=[],tasks=[],activeFilter='all',selectedProject=null,originalWorkbook=null,originalFileName='',passwordRecoveryMode=location.hash.includes('type=recovery')||location.hash.includes('type=invite');
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
  const requestedId=preferredId||selectedProject;
  const requested=allProjects.find(p=>p.id===requestedId);
  const canonical=requested&&projects.find(p=>projectNameKey(p.name)===projectNameKey(requested.name));
  const wanted=canonical?.id||projects[0]?.id||'';
  if(wanted){select.value=wanted;await loadProject(wanted)}else{selectedProject=null;tasks=[];render()}
  $('#open-assign-engineer').disabled=!projects.length;
}
$('#project-select').onchange=()=>loadProject($('#project-select').value);
async function loadProject(projectId){selectedProject=projectId;const project=projects.find(p=>p.id===projectId);if(!project){tasks=[];$('#export-button').disabled=true;$('#send-update').disabled=true;$('#open-assign-engineer').disabled=true;render();return}$('#open-assign-engineer').disabled=false;$('#project-name').innerHTML=`<span class="dot"></span> ${esc(project.name)} <small>• ${project.source_file?'cronograma carregado':'obra'}</small>`;$('#export-button').disabled=!project.source_file;$('#send-update').disabled=true;const {data:activities,error}=await db.from('activities').select('*').eq('project_id',projectId).eq('is_current',true).order('sort_order');if(error){notify('Falha ao carregar atividades: '+error.message);return}const {data:progress,error:progressError}=await db.rpc('latest_schedule_progress',{p_project_id:projectId});if(progressError){notify('Falha ao carregar atualizações: '+progressError.message);return}const latest=progress?.length?{id:progress[0].submission_id,submitted_at:progress[0].submitted_at,submitted_by:progress[0].submitted_by}:null;const values=new Map((progress||[]).map(item=>[item.activity_id,Number(item.actual_pct)]));tasks=(activities||[]).map((a,index)=>({id:a.id,sortOrder:a.sort_order,activityId:a.activity_id,wbs:a.wbs||'',name:a.name,summary:a.is_summary,plan:Number(a.planned_pct),actual:values.has(a.id)?values.get(a.id):Number(a.initial_actual_pct),originalActual:values.has(a.id)?values.get(a.id):Number(a.initial_actual_pct),sourceSheet:a.source_sheet,sourceRow:a.source_row,sourceActualColumn:a.source_actual_column}));$('#send-update').disabled=!tasks.some(t=>!t.summary);$('#last-update').textContent=latest?new Date(latest.submitted_at).toLocaleString('pt-BR'):'Nenhum envio ainda';$('#table-help').textContent=latest?'Percentuais do envio mais recente.':'Cronograma original; aguardando a primeira atualização.';render()}
function render(){const q=($('#search')?.value||'').toLowerCase();if(!tasks.length){body.innerHTML='<tr><td colspan="5" class="empty-state">Selecione uma obra para ver as atividades.</td></tr>';['attention-count','late-count','changed-count','all-count'].forEach(id=>$('#'+id).textContent='0');$('#planned-total').textContent='—';$('#actual-total').textContent='—';$('#actual-detail').textContent='aguardando cronograma';$('#actual-bar').style.width='0%';return}const visible=tasks.filter(t=>t.name.toLowerCase().includes(q)&&(activeFilter==='all'||activeFilter==='changed'&&changed(t)||activeFilter==='late'&&!t.summary&&t.actual<t.plan));body.innerHTML=visible.map(t=>{const variation=t.actual-t.plan,late=!t.summary&&variation<0;return `<tr class="${t.summary?'summary-row':''} ${changed(t)?'changed':''}"><td class="task-id" data-label="ID">${esc(t.activityId)}</td><td class="task-cell" data-label="Atividade"><span class="wbs">${esc(t.wbs)}</span>${esc(t.name)}${t.summary?' <span class="summary-label">RESUMO</span>':''}</td><td class="percent" data-label="Planejado">${t.plan}%</td><td data-label="Avanço informado">${t.summary?'<span class="not-editable">Não editável</span>':`<input class="actual-input" aria-label="Avanço de ${esc(t.name)}" type="number" inputmode="decimal" min="0" max="100" step="1" value="${t.actual}" data-id="${esc(t.id)}"/> %`}</td><td class="delta ${late?'negative':variation>0?'positive':''}" data-label="Variação">${variation>0?'+':''}${variation} p.p.</td></tr>`}).join('')||'<tr><td colspan="5" class="empty-state">Nenhuma atividade corresponde ao filtro selecionado.</td></tr>';const leaves=tasks.filter(t=>!t.summary),late=leaves.filter(t=>t.actual<t.plan).length,changes=leaves.filter(changed).length,actual=Math.round(leaves.reduce((s,t)=>s+t.actual,0)/(leaves.length||1)),plan=Math.round(leaves.reduce((s,t)=>s+t.plan,0)/(leaves.length||1));$('#attention-count').textContent=late;$('#late-count').textContent=late;$('#changed-count').textContent=changes;$('#all-count').textContent=tasks.length;$('#actual-total').textContent=actual+'%';$('#planned-total').textContent=plan+'%';$('#actual-bar').style.width=actual+'%';$('#actual-detail').textContent=actual===plan?'em linha com o planejado':`${Math.abs(plan-actual)} pontos ${actual<plan?'abaixo':'acima'} do planejado`}
body.addEventListener('change',e=>{if(!e.target.matches('.actual-input'))return;const t=tasks.find(x=>x.id===e.target.dataset.id);if(!t)return;t.actual=Math.max(0,Math.min(100,Number(e.target.value)||0));render()});
document.querySelectorAll('.filter').forEach(button=>button.onclick=()=>{activeFilter=button.dataset.filter;document.querySelectorAll('.filter').forEach(x=>x.classList.toggle('active',x===button));render()});$('#search').oninput=render;
$('#send-update').onclick=async()=>{if(!selectedProject)return notify('Selecione uma obra antes de enviar.');const items=tasks.filter(t=>!t.summary).map(t=>({activity_id:t.id,actual_pct:t.actual}));const {data,error}=await db.rpc('submit_progress',{target_project:selectedProject,items});if(error)return notify('Não foi possível enviar. '+error.message);tasks.forEach(t=>t.originalActual=t.actual);$('#last-update').textContent=new Date().toLocaleString('pt-BR');$('#table-help').textContent='Atualização enviada e registrada no histórico.';render();notify('Atualização enviada ao planejamento.');};
$('#import-button').onclick=async()=>{
  const button=$('#import-button'),file=$('#schedule-file').files[0],project=projects.find(item=>item.id===selectedProject);
  if(!project)return notify('Selecione o projeto que receberá o cronograma.');
  if(!file)return notify('Selecione um arquivo Excel ou CSV.');
  let phase='Lendo o arquivo';
  button.disabled=true;button.textContent='Importando…';
  try{
    const buffer=await file.arrayBuffer(),wb=XLSX.read(buffer,{type:'array',raw:false,cellDates:true});let parsed=null;
    for(const sheetName of wb.SheetNames){const rows=XLSX.utils.sheet_to_json(wb.Sheets[sheetName],{header:1,defval:'',raw:false});const hi=headerRow(rows);if(hi>=0){parsed={sheetName,rows,headerIndex:hi};break}}
    if(!parsed)throw Error('Não encontrei uma aba com atividades.');
    const headers=parsed.rows[parsed.headerIndex].map(key),cols={id:find(headers,['uniqueid','activityid','taskid','uid','id']),name:find(headers,['nomedetarefa','atividade','taskname','tarefa','task','nome']),wbs:find(headers,['eap','wbs','outline']),summary:find(headers,['resumo','summary']),plan:find(headers,['percentualplanejado','planejado','percentualanterior','anterior','previsto','baseline']),actual:find(headers,['percentualconcluido','percentcomplete','percentualexecutado','executado','realizado','avanco','concluido'])};
    if(cols.name<0)throw Error('Não encontrei a coluna Atividade/Nome da tarefa.');
    if(cols.actual<0)throw Error('Não encontrei a coluna de percentual executado/realizado.');
    const parsedActivities=[];
    parsed.rows.slice(parsed.headerIndex+1).forEach((row,i)=>{const activityName=String(row[cols.name]||'').trim();if(!activityName)return;const actual=percent(row[cols.actual]),plan=cols.plan<0?actual:percent(row[cols.plan]);parsedActivities.push({sort_order:parsedActivities.length,activity_id:String(cols.id<0?parsedActivities.length+1:row[cols.id]||parsedActivities.length+1),wbs:cols.wbs<0?'':String(row[cols.wbs]||''),name:activityName,is_summary:cols.summary>=0&&['sim','s','yes','true','1'].includes(key(row[cols.summary])),planned_pct:plan,initial_actual_pct:actual,source_sheet:parsed.sheetName,source_row:parsed.headerIndex+1+i,source_actual_column:cols.actual})});
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
    notify(parsedActivities.length+' atividades importadas para '+project.name+'. Cronograma substituído; os envios anteriores foram preservados no histórico.');
  }catch(error){console.error(error);notify(phase+': '+(error.message||'falha inesperada.'))}
  finally{button.disabled=false;button.textContent='Importar/atualizar cronograma'}
};

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