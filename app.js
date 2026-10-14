const cfg=window.OBRA_SUPABASE,body=document.querySelector('#schedule-body'),toast=document.querySelector('#toast');
let db=null,user=null,profile=null,projects=[],tasks=[],submissions=[],submissionProjectNames=new Map(),activeFilter='all',selectedProject=null,latestUpdateProjectId=null,originalWorkbook=null,originalFileName='',scheduleMetadataCache=new Map(),plannedFinishDate='',passwordRecoveryMode=location.hash.includes('type=recovery')||location.hash.includes('type=invite'),projectLoadId=0,authLoadId=0,submissionLoadId=0,xlsxPromise=null,pendingSubmission=null,notificationProjectId=new URLSearchParams(location.search).get('project');
let logoLoadId=0;
const VAPID_PUBLIC_KEY='BBtoMj-PNwjcJaxWmYzToLm8nmAS61dqZorAnEL2ZhkMOQy4GV98M7BfHAiPrch4Y1Iuor50c8Ksy-rCZ09j5SU';
const $=selector=>document.querySelector(selector),pendingChange=t=>!t.summary&&t.actual!==t.originalActual,submittedChange=t=>!t.summary&&t.originalActual!==t.initialActual,changed=t=>submittedChange(t)||pendingChange(t);
const esc=v=>String(v??'').replace(/[&<>\'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
function notify(message){toast.textContent=message;toast.classList.add('show');setTimeout(()=>toast.classList.remove('show'),4000)}
async function functionErrorMessage(error,fallback){const context=error?.context;if(context&&typeof context.json==='function'){try{const response=await context.json();if(typeof response?.error==='string'&&response.error)return response.error;if(typeof response?.message==='string'&&response.message)return response.message}catch{}}return error?.message||fallback}
const PAGE_SIZE=1000;
const PAGE_BATCH_SIZE=4;
async function fetchAllRows(queryPage){
  const rows=[];
  for(let from=0;;){
    const batchSize=from<PAGE_SIZE*2?1:PAGE_BATCH_SIZE;
    const offsets=Array.from({length:batchSize},(_,index)=>from+index*PAGE_SIZE);
    const results=await Promise.all(offsets.map(offset=>queryPage(offset,offset+PAGE_SIZE-1)));
    for(const {data,error} of results){
      if(error)return {data:null,error};
      const page=data||[];
      rows.push(...page);
      if(page.length<PAGE_SIZE)return {data:rows,error:null};
    }
    from+=batchSize*PAGE_SIZE;
  }
}
function loadXlsx(){
  if(window.XLSX)return Promise.resolve(window.XLSX);
  if(!xlsxPromise)xlsxPromise=new Promise((resolve,reject)=>{
    const script=document.createElement('script');
    script.src='https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';
    script.onload=()=>window.XLSX?resolve(window.XLSX):reject(Error('Biblioteca de planilhas indisponível.'));
    script.onerror=()=>reject(Error('Não foi possível carregar a biblioteca de planilhas.'));
    document.head.append(script);
  }).catch(error=>{xlsxPromise=null;throw error});
  return xlsxPromise;
}
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
function showSessionRetry(message){$('#session-loading-message').textContent=message;$('#retry-session').hidden=false;$('#session-loading').hidden=false;$('#login-screen').hidden=true;$('#app-main').hidden=true;$('#logout-button').hidden=true;$('#notification-bell').hidden=true;closeNotificationPanel()}
$('#retry-session').onclick=async()=>{
  const button=$('#retry-session');button.disabled=true;$('#session-loading-message').textContent='Restaurando sua sessão…';
  try{
    const {data,error}=await db.auth.getSession();
    if(error)throw error;
    if(data?.session?.user)await enterApp(data.session.user);
    else{$('#session-loading').hidden=true;$('#login-screen').hidden=false}
  }catch(error){console.error('Falha ao restaurar sessão:',error);showSessionRetry('A conexão falhou. Confira a internet e tente novamente.')}
  finally{button.disabled=false}
};
async function start(){
  if(!window.supabase||!cfg?.url||!cfg?.publishableKey){$('#session-loading').hidden=true;$('#login-screen').hidden=false;setLoginMessage('Não consegui carregar a conexão do Supabase. Atualize a página ou confira a configuração.');return}
  db=window.supabase.createClient(cfg.url,cfg.publishableKey,{auth:{persistSession:true,autoRefreshToken:true}});
  if(passwordRecoveryMode){$('#session-loading').hidden=true;$('#login-screen').hidden=false;setLoginView('recovery')}
  db.auth.onAuthStateChange((event,session)=>{
    if(event==='PASSWORD_RECOVERY'){passwordRecoveryMode=true;$('#session-loading').hidden=true;$('#login-screen').hidden=false;setLoginView('recovery');return}
    if(passwordRecoveryMode)return;
    if((event==='INITIAL_SESSION'||event==='SIGNED_IN'||event==='TOKEN_REFRESHED')&&session?.user){
      const loadId=authLoadId;
      setTimeout(()=>{if(!passwordRecoveryMode&&loadId===authLoadId)void enterApp(session.user)},0);
    }
    else if(event==='SIGNED_OUT')leaveApp();
  });
  try{
    const {data,error}=await db.auth.getSession();
    if(passwordRecoveryMode)return;
    if(data?.session?.user)await enterApp(data.session.user);
    else if(!user){if(error)showSessionRetry('A conexão falhou. Confira a internet e tente novamente.');else{$('#session-loading').hidden=true;$('#login-screen').hidden=false}}
  }catch(error){console.error('Falha ao restaurar sessão:',error);if(!user)showSessionRetry('A conexão falhou. Confira a internet e tente novamente.')}
}
async function enterApp(authUser){if(user?.id===authUser.id)return;const loadId=++authLoadId;user=authUser;const {data:p,error}=await db.from('profiles').select('id,email,display_name,role').eq('id',authUser.id).maybeSingle();if(loadId!==authLoadId)return;if(error){user=null;profile=null;projects=[];tasks=[];selectedProject=null;showSessionRetry('Não foi possível carregar os dados da conta. Confira a internet e tente novamente.');return}if(!p){leaveApp();setLoginMessage('Perfil não encontrado. Confirme seu cadastro no Supabase.');return}profile=p;$('#session-loading').hidden=true;$('#login-screen').hidden=true;$('#app-main').hidden=false;$('#logout-button').hidden=false;$('#notification-bell').hidden=p.role!=='admin';closeNotificationPanel();$('#avatar').textContent=(p.display_name||p.email||'?').slice(0,2).toUpperCase();$('#user-label').textContent=p.display_name||p.email;$('#role-label').textContent=p.role==='admin'?'Planejamento':'Engenheiro';$('#admin-tools').hidden=p.role!=='admin';$('#open-assign-engineer').hidden=p.role!=='admin';$('#admin-submissions').hidden=p.role!=='admin';$('#engineer-panel').hidden=p.role==='admin';$('#export-button').hidden=p.role!=='admin';await loadProjects();if(p.role==='admin'&&loadId===authLoadId){await loadSubmissions();void refreshPushStatus()} }
function leaveApp(){authLoadId++;projectLoadId++;submissionLoadId++;if($('#update-review-dialog').open)$('#update-review-dialog').close();user=null;profile=null;projects=[];tasks=[];submissions=[];submissionProjectNames=new Map();selectedProject=null;latestUpdateProjectId=null;showProjectLogo(null);$('#admin-submissions').open=false;$('#submission-list').textContent='';$('#session-loading').hidden=true;$('#app-main').hidden=true;$('#login-screen').hidden=false;$('#logout-button').hidden=true;$('#notification-bell').hidden=true;closeNotificationPanel();$('#project-select').innerHTML='<option value="">Selecione uma obra</option>';if(!passwordRecoveryMode)setLoginView('login');render()}
function closeNotificationPanel(){$('#admin-notification-setup').hidden=true;$('#notification-bell').setAttribute('aria-expanded','false')}
$('#notification-bell').onclick=()=>{if(profile?.role!=='admin')return;const panel=$('#admin-notification-setup');panel.hidden=!panel.hidden;$('#notification-bell').setAttribute('aria-expanded',String(!panel.hidden));if(!panel.hidden)void refreshPushStatus()};
document.addEventListener('click',event=>{if(!$('#admin-notification-setup').hidden&&!$('#admin-notification-setup').contains(event.target)&&!$('#notification-bell').contains(event.target))closeNotificationPanel()});
document.addEventListener('keydown',event=>{if(event.key==='Escape'&&!$('#admin-notification-setup').hidden){closeNotificationPanel();$('#notification-bell').focus()}});
function pushSupported(){return 'serviceWorker' in navigator&&'PushManager' in window&&'Notification' in window}
function vapidKeyBytes(value){const base64=value.replace(/-/g,'+').replace(/_/g,'/').padEnd(Math.ceil(value.length/4)*4,'=');return Uint8Array.from(atob(base64),char=>char.charCodeAt(0))}
async function refreshPushStatus(){
  if(profile?.role!=='admin')return;
  const accountId=profile.id,button=$('#push-button'),status=$('#push-status');
  if(!pushSupported()){button.disabled=true;button.textContent='Notificações indisponíveis';status.textContent='Este navegador não oferece notificações para o aplicativo.';return}
  if(Notification.permission==='denied'){button.disabled=true;button.textContent='Notificações bloqueadas';status.textContent='Libere as notificações nas configurações do celular e abra o aplicativo novamente.';return}
  button.disabled=true;button.textContent='Verificando notificações…';
  try{
    const registration=await navigator.serviceWorker.ready;
    const subscription=await registration.pushManager.getSubscription();
    if(profile?.id!==accountId)return;
    let enabled=false;
    if(subscription){
      const {data,error}=await db.from('push_subscriptions').select('id').eq('user_id',accountId).eq('endpoint',subscription.endpoint).maybeSingle();
      if(error)throw error;
      enabled=!!data;
    }
    if(profile?.id!==accountId)return;
    button.dataset.enabled=String(enabled);
    button.textContent=enabled?'Desativar notificações':'Ativar notificações';
    status.textContent=enabled?'Este celular receberá avisos quando um engenheiro atualizar uma obra.':'Ative e permita os avisos quando o celular solicitar.';
    button.disabled=false;
  }catch(error){console.error('Falha ao verificar notificações:',error);button.textContent='Tentar novamente';status.textContent='Não foi possível verificar as notificações agora.';button.disabled=false}
}
async function removePushSubscription(){
  if(!pushSupported()||!db||!user)return;
  try{
    const registration=await navigator.serviceWorker.ready;
    const subscription=await registration.pushManager.getSubscription();
    if(!subscription)return;
    const {error}=await db.from('push_subscriptions').delete().eq('user_id',user.id).eq('endpoint',subscription.endpoint);
    const unsubscribed=await subscription.unsubscribe();
    if(error||!unsubscribed)throw error||Error('Não foi possível cancelar a inscrição neste aparelho.');
  }catch(error){console.error('Falha ao desativar notificações:',error);throw error}
}
async function configurePush(){
  const button=$('#push-button'),status=$('#push-status');
  if(button.disabled||profile?.role!=='admin')return;
  button.disabled=true;
  try{
    if(button.dataset.enabled==='true'){
      await removePushSubscription();
      notify('Notificações desativadas neste celular.');
    }else{
      const permission=await Notification.requestPermission();
      if(permission!=='granted'){status.textContent='Permissão negada. Libere as notificações nas configurações do celular.';return}
      const registration=await navigator.serviceWorker.ready;
      const subscription=await registration.pushManager.getSubscription()||await registration.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:vapidKeyBytes(VAPID_PUBLIC_KEY)});
      const keys=subscription.toJSON().keys;
      if(!keys?.p256dh||!keys?.auth)throw Error('Chaves de inscrição ausentes.');
      const {error}=await db.from('push_subscriptions').upsert({user_id:user.id,endpoint:subscription.endpoint,p256dh:keys.p256dh,auth_key:keys.auth},{onConflict:'endpoint'});
      if(error)throw error;
      notify('Notificações ativadas neste celular.');
    }
  }catch(error){console.error('Falha ao configurar notificações:',error);status.textContent='Não foi possível configurar as notificações. Tente novamente.'}
  finally{if(profile?.role==='admin')await refreshPushStatus()}
}
$('#push-button').onclick=configurePush;
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'&&profile?.role==='admin')void refreshPushStatus()});
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
  passwordRecoveryMode=false;history.replaceState(null,'',location.pathname+location.search);await db.auth.signOut({scope:'local'});$('#new-password').value='';$('#confirm-password').value='';
  setLoginView('login');setLoginMessage('Senha definida com sucesso. Entre com sua nova senha.',false);
});
$('#logout-button').onclick=async()=>{let pushCleanupFailed=false;if(profile?.role==='admin'){try{await removePushSubscription()}catch{pushCleanupFailed=true}}await db.auth.signOut({scope:'local'});notify(pushCleanupFailed?'Você saiu, mas não foi possível desativar os avisos neste celular.':'Você saiu do app.')};

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
    if(error||data?.error){message.textContent=data?.error||await functionErrorMessage(error,'Não foi possível cadastrar o projeto.');return}
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
  const loadId=authLoadId;
  const {data,error}=await db.from('projects').select('id,name,logo_file,source_file,created_at').order('name');
  if(loadId!==authLoadId)return;
  if(error){notify('Não consegui carregar as obras. '+error.message);return}
  const allProjects=data||[];
  projects=uniqueProjects(allProjects);
  const select=$('#project-select');
  select.innerHTML='<option value="">Selecione uma obra</option>'+projects.map(p=>'<option value="'+esc(p.id)+'">'+esc(p.name)+'</option>').join('');
  const importSelect=$('#import-project-select');
  if(importSelect)importSelect.innerHTML='<option value="">Selecione uma obra</option>'+projects.map(p=>'<option value="'+esc(p.id)+'">'+esc(p.name)+'</option>').join('');
  const requestedId=preferredId||notificationProjectId||selectedProject;
  notificationProjectId=null;
  const requested=allProjects.find(p=>p.id===requestedId);
  const canonical=requested&&projects.find(p=>projectNameKey(p.name)===projectNameKey(requested.name));
  const wanted=canonical?.id||projects[0]?.id||'';
  if(wanted){select.value=wanted;await loadProject(wanted)}else{
    ++projectLoadId;selectedProject=null;latestUpdateProjectId=null;tasks=[];plannedFinishDate='';
    showProjectLogo(null);
    $('#project-name').innerHTML='<span class="dot"></span> Nenhuma obra selecionada';
    $('#table-help').textContent='Cadastre uma obra ou aguarde ser incluído como responsável.';
    $('#export-button').disabled=true;$('#send-update').disabled=true;
    populateDimensionFilters();render();
  }
  $('#open-assign-engineer').disabled=!projects.length;
}
$('#project-select').onchange=()=>loadProject($('#project-select').value);
async function showProjectLogo(project){
  const requestId=++logoLoadId,slot=$('#project-logo-slot'),image=$('#project-logo');
  slot.hidden=true;
  image.removeAttribute('src');
  image.alt='';
  if(!project?.logo_file||!db)return;
  try{
    const {data,error}=await db.storage.from('client-logos').createSignedUrl(project.logo_file,3600);
    if(requestId!==logoLoadId||selectedProject!==project.id)return;
    if(error||!data?.signedUrl)throw error||Error('URL da logo indisponível.');
    image.alt='Logo do projeto '+project.name;
    image.onerror=()=>{if(requestId===logoLoadId)slot.hidden=true};
    image.src=data.signedUrl;
    slot.hidden=false;
  }catch(error){if(requestId===logoLoadId)console.warn('Não foi possível carregar a logo do projeto:',error)}
}
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
    const XLSX=await loadXlsx();
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
async function loadProject(projectId){
  const loadId=++projectLoadId;
  selectedProject=projectId;
  latestUpdateProjectId=null;
  const project=projects.find(p=>p.id===projectId);
  if(!project){showProjectLogo(null);tasks=[];plannedFinishDate='';populateDimensionFilters();$('#export-button').disabled=true;$('#send-update').disabled=true;$('#open-assign-engineer').disabled=true;render();return}
  void showProjectLogo(project);
  $('#open-assign-engineer').disabled=false;
  $('#project-name').innerHTML=`<span class="dot"></span> ${esc(project.name)} <small>• ${project.source_file?'cronograma carregado':'obra'}</small>`;
  $('#export-button').disabled=true;
  $('#send-update').disabled=true;
  tasks=[];
  plannedFinishDate='';
  populateDimensionFilters();
  render();
  $('#table-help').textContent='Carregando atividades…';
  body.innerHTML='<tr><td colspan="6" class="empty-state">Carregando atividades…</td></tr>';
  const [activityResult,progressResult]=await Promise.all([
    fetchAllRows((from,to)=>db.from('activities').select('id,sort_order,activity_id,wbs,name,is_summary,planned_pct,initial_actual_pct,source_sheet,source_row,source_actual_column,macro,sector,activity_local,source_macro_column,source_sector_column,source_local_column').eq('project_id',projectId).eq('is_current',true).order('sort_order').order('id').range(from,to)),
    fetchAllRows((from,to)=>db.rpc('latest_schedule_progress',{p_project_id:projectId}).order('activity_id').range(from,to))
  ]);
  if(loadId!==projectLoadId)return;
  const loadError=activityResult.error?'Falha ao carregar atividades: '+activityResult.error.message:progressResult.error?'Falha ao carregar atualizações: '+progressResult.error.message:'';
  if(loadError){$('#table-help').textContent='Não foi possível carregar o cronograma.';body.innerHTML='<tr><td colspan="6" class="empty-state">'+esc(loadError)+'</td></tr>';notify(loadError);return}
  const activities=activityResult.data||[],progress=progressResult.data||[];
  const latest=progress.length?{id:progress[0].submission_id,submitted_at:progress[0].submitted_at,submitted_by:progress[0].submitted_by}:null;
  latestUpdateProjectId=latest?projectId:null;
  $('#export-button').disabled=!project.source_file||!latest;
  const values=new Map(progress.map(item=>[item.activity_id,Number(item.actual_pct)]));
  plannedFinishDate='';
  tasks=activities.map(a=>{
    const actual=values.has(a.id)?values.get(a.id):Number(a.initial_actual_pct);
    return {id:a.id,sortOrder:a.sort_order,activityId:a.activity_id,wbs:a.wbs||'',name:a.name,summary:a.is_summary,plan:Number(a.planned_pct),initialActual:Number(a.initial_actual_pct),actual,originalActual:actual,sourceSheet:a.source_sheet,sourceRow:a.source_row,sourceActualColumn:a.source_actual_column,macro:a.macro??'',sector:a.sector??'',local:a.activity_local??'',sourceMacroColumn:a.source_macro_column,sourceSectorColumn:a.source_sector_column,sourceLocalColumn:a.source_local_column};
  });
  populateDimensionFilters();
  $('#send-update').disabled=!tasks.some(t=>!t.summary);
  $('#last-update').textContent=latest?new Date(latest.submitted_at).toLocaleDateString('pt-BR'):'Nenhum envio ainda';
  $('#last-update-engineer').textContent='';
  $('#last-update-engineer').hidden=!latest;
  $('#table-help').textContent=latest?'Percentuais do envio mais recente.':'Cronograma original; aguardando a primeira atualização.';
  render();
  if(latest)void db.rpc('latest_project_update_author',{p_project_id:projectId}).then(({data:authorRows,error})=>{
    if(loadId!==projectLoadId)return;
    if(error){if(latest.submitted_by!==profile?.id)console.warn('Não foi possível carregar o nome do responsável pela última atualização.',error.message);}
    $('#last-update-engineer').textContent=!error?authorRows?.[0]?.engineer_name||'Nome não informado':latest.submitted_by===profile?.id?profile.display_name||profile.email||'Nome não informado':'';
  });
  if(project.source_file&&activities.length)void recoverScheduleMetadata(projectId,project.source_file,activities).then(metadata=>{
    if(loadId!==projectLoadId)return;
    plannedFinishDate=metadata.plannedFinish;
    let dimensionsChanged=false;
    for(const task of tasks){
      const recovered=metadata.dimensions.get(task.id);
      if(!recovered)continue;
      for(const [field,source] of [['macro','sourceMacroColumn'],['sector','sourceSectorColumn'],['local','sourceLocalColumn']]){
        if(!task[field]&&recovered[field]){task[field]=recovered[field];dimensionsChanged=true}
        if(task[source]==null&&recovered[source]!=null){task[source]=recovered[source];dimensionsChanged=true}
      }
    }
    if(dimensionsChanged){populateDimensionFilters();render()}
    else $('#planned-finish').textContent=plannedFinishDate||'—';
  });
}
function normalizeDimensionValue(value){return String(value??'').trim().replace(/\s+/g,' ')}
const dimensionFilterDefinitions=[
  {key:'macro',id:'filter-macro',all:'Todas as macros'},
  {key:'sector',id:'filter-sector',all:'Todos os setores'},
  {key:'local',id:'filter-local',all:'Todos os locais'}
];
const ROW_BATCH_SIZE=200;
let renderVersion=0;
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
  const version=++renderVersion;
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
  const hasMacro=dimensions.some(column=>column.key==='macro'),hasSector=dimensions.some(column=>column.key==='sector'),hasLocal=dimensions.some(column=>column.key==='local');
  const rowHtml=task=>{
    const name=esc(task.name)+(task.summary?' <span class="summary-label">RESUMO</span>':'');
    const cells=['<td class="activity-cell" data-label="ID"><span class="task-id">'+esc(task.activityId)+'</span><span class="activity-name-inline">'+name+'</span></td>'];
    if(hasMacro)cells.push('<td data-label="MACRO">'+esc(task.macro)+'</td>');
    if(hasSector)cells.push('<td data-label="SETOR">'+esc(task.sector)+'</td>');
    if(hasLocal)cells.push('<td data-label="LOCAL">'+esc(task.local)+'</td>');
    cells.push('<td class="percent" data-label="% ANTERIOR">'+task.plan+'%</td>');
    cells.push('<td data-label="% NOVO DIGITÁVEL">'+(task.summary?'<span class="not-editable">Não editável</span>':'<input class="actual-input" aria-label="Novo avanço de '+esc(task.name)+'" type="number" inputmode="decimal" min="0" max="100" step="1" value="'+task.actual+'" data-id="'+esc(task.id)+'"/> %')+'</td>');
    return '<tr class="'+(task.summary?'summary-row':'')+' '+(changed(task)?'changed':'')+'">'+cells.join('')+'</tr>';
  };
  body.innerHTML=visible.length?visible.slice(0,ROW_BATCH_SIZE).map(rowHtml).join(''):'<tr><td colspan="'+columnCount+'" class="empty-state">Nenhuma atividade corresponde ao filtro selecionado.</td></tr>';
  const appendRows=from=>{
    if(version!==renderVersion||from>=visible.length)return;
    body.insertAdjacentHTML('beforeend',visible.slice(from,from+ROW_BATCH_SIZE).map(rowHtml).join(''));
    requestAnimationFrame(()=>appendRows(from+ROW_BATCH_SIZE));
  };
  if(visible.length>ROW_BATCH_SIZE)requestAnimationFrame(()=>appendRows(ROW_BATCH_SIZE));
  const changes=tasks.filter(task=>!task.summary&&changed(task)).length,globalActivity=tasks.find(task=>Number(String(task.activityId).trim())===1),globalPercent=globalActivity?Math.round(Number(globalActivity.plan)):null;
  $('#changed-count').textContent=changes;$('#all-count').textContent=tasks.length;
  $('#planned-total').textContent=globalPercent===null?'—':globalPercent+'%';$('#global-bar').style.width=globalPercent===null?'0%':Math.max(0,Math.min(100,globalPercent))+'%';
  $('#planned-finish').textContent=plannedFinishDate||'—';
}
body.addEventListener('change',e=>{if(!e.target.matches('.actual-input'))return;const t=tasks.find(x=>x.id===e.target.dataset.id);if(!t)return;t.actual=Math.max(0,Math.min(100,Number(e.target.value)||0));e.target.value=t.actual;if(activeFilter==='changed'){render();return}e.target.closest('tr')?.classList.toggle('changed',changed(t));$('#changed-count').textContent=tasks.filter(task=>changed(task)).length});
document.querySelectorAll('.filter').forEach(button=>button.onclick=()=>{activeFilter=button.dataset.filter;document.querySelectorAll('.filter').forEach(x=>x.classList.toggle('active',x===button));render()});$('#search').oninput=render;document.querySelectorAll('.schedule-dimension-filters select').forEach(select=>select.onchange=render);
const updateReviewDialog=$('#update-review-dialog');
function closeUpdateReview(){pendingSubmission=null;if(updateReviewDialog.open)updateReviewDialog.close()}
$('#close-update-review').onclick=closeUpdateReview;
$('#cancel-update-review').onclick=closeUpdateReview;
updateReviewDialog.addEventListener('close',()=>{if(updateReviewDialog.open)return;pendingSubmission=null;$('#update-review-message').textContent=''});
updateReviewDialog.addEventListener('cancel',event=>{if($('#confirm-update').disabled)event.preventDefault()});
$('#send-update').onclick=()=>{
  if(!selectedProject)return notify('Selecione uma obra antes de enviar.');
  if(document.activeElement?.matches('.actual-input'))document.activeElement.blur();
  const changes=tasks.filter(pendingChange);
  if(!changes.length)return notify('Altere o avanço de pelo menos uma atividade antes de enviar.');
  const project=projects.find(p=>p.id===selectedProject);
  pendingSubmission={projectId:selectedProject,items:tasks.filter(task=>!task.summary).map(task=>({activity_id:task.id,actual_pct:task.actual}))};
  $('#update-review-intro').textContent='Confira os avanços da obra '+(project?.name||'selecionada')+' antes de enviar ao planejamento.';
  $('#update-review-count').textContent=changes.length+' '+(changes.length===1?'atividade alterada':'atividades alteradas');
  $('#update-review-list').innerHTML=changes.map(task=>'<li class="update-review-item"><div><span class="update-review-id">Atividade '+esc(task.activityId)+'</span><strong>'+esc(task.name)+'</strong></div><span class="update-review-values">'+esc(task.originalActual)+'% <span aria-hidden="true">→</span> <b>'+esc(task.actual)+'%</b></span></li>').join('');
  $('#update-review-message').textContent='';
  updateReviewDialog.showModal();
};
$('#update-review-form').addEventListener('submit',async event=>{
  event.preventDefault();
  if(!pendingSubmission||$('#confirm-update').disabled)return;
  const submission=pendingSubmission,button=$('#confirm-update'),message=$('#update-review-message');
  button.disabled=true;
  button.textContent='Enviando…';
  $('#cancel-update-review').disabled=true;
  $('#close-update-review').disabled=true;
  message.textContent='';
  try{
    const {error}=await db.rpc('submit_progress',{target_project:submission.projectId,items:submission.items});
    if(error){message.textContent='Não foi possível enviar. '+error.message;return}
    tasks.forEach(task=>task.originalActual=task.actual);
    latestUpdateProjectId=submission.projectId;
    $('#export-button').disabled=!projects.find(project=>project.id===submission.projectId)?.source_file;
    $('#last-update').textContent=new Date().toLocaleDateString('pt-BR');
    $('#last-update-engineer').textContent=profile?.display_name||profile?.email||'Nome não informado';
    $('#last-update-engineer').hidden=false;
    $('#table-help').textContent='Atualização enviada e registrada no histórico.';
    render();
    closeUpdateReview();
    notify('Atualização enviada ao planejamento.');
  }catch(error){
    message.textContent='Não foi possível enviar. '+(error?.message||'Tente novamente.');
  }finally{
    button.disabled=false;
    button.textContent='Confirmar envio';
    $('#cancel-update-review').disabled=false;
    $('#close-update-review').disabled=false;
  }
});
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
    const XLSX=await loadXlsx();
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
    if(error||data?.error){message.textContent=data?.error||await functionErrorMessage(error,'Não foi possível atribuir os engenheiros.');return}
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

async function loadSubmissions(){
  const loadId=++submissionLoadId;
  const {data:rows,error}=await fetchAllRows((from,to)=>db.from('submissions')
    .select('id,project_id,submitted_by,submitted_at')
    .order('submitted_at',{ascending:false}).order('id').range(from,to));
  if(loadId!==submissionLoadId)return;
  if(error){$('#submission-list').textContent='Não foi possível carregar as atualizações: '+error.message;return}
  submissions=rows||[];
  if(!submissions.length){submissionProjectNames=new Map();$('#submission-list').textContent='Nenhuma atualização recebida ainda.';return}
  const projectIds=[...new Set(submissions.map(item=>item.project_id))];
  const userIds=[...new Set(submissions.map(item=>item.submitted_by))];
  const [{data:projectRows,error:projectError},{data:people,error:peopleError}]=await Promise.all([
    db.from('projects').select('id,name').in('id',projectIds),
    db.from('profiles').select('id,email,display_name').in('id',userIds)
  ]);
  if(loadId!==submissionLoadId)return;
  if(projectError||peopleError){$('#submission-list').textContent='Não foi possível carregar os detalhes das atualizações.';return}
  const names=new Map((projectRows||[]).map(item=>[item.id,item.name]));
  submissionProjectNames=names;
  const authors=new Map((people||[]).map(item=>[item.id,item.display_name||item.email]));
  $('#submission-list').innerHTML=submissions.map(item=>`<div class="submission-row">
    <div class="submission-info"><strong>${esc(names.get(item.project_id)||'Obra')}</strong><small>${esc(authors.get(item.submitted_by)||'Engenheiro')}</small></div>
    <div class="submission-actions"><time datetime="${esc(item.submitted_at)}">${esc(new Date(item.submitted_at).toLocaleString('pt-BR'))}</time><button class="button secondary submission-export" type="button" data-submission-id="${esc(item.id)}" aria-label="Baixar Excel da atualização de ${esc(names.get(item.project_id)||'Obra')} em ${esc(new Date(item.submitted_at).toLocaleString('pt-BR'))}">Baixar Excel</button></div>
  </div>`).join('');
}
async function downloadSubmissionExcel(submission,button){
  button.disabled=true;
  button.textContent='Gerando Excel…';
  try{
    const {data:firstItem,error:firstError}=await db.from('submission_items').select('activity_id')
      .eq('submission_id',submission.id).order('activity_id').limit(1).maybeSingle();
    if(firstError||!firstItem)throw firstError||Error('Esta atualização não tem atividades para exportar.');
    const {data:reference,error:referenceError}=await db.from('activities').select('project_id,source_file')
      .eq('id',firstItem.activity_id).maybeSingle();
    if(referenceError||!reference||reference.project_id!==submission.project_id||!reference.source_file)
      throw referenceError||Error('Não encontrei o cronograma original desta atualização.');
    const sourceFile=reference.source_file;
    const [itemsResult,activitiesResult,fileResult]=await Promise.all([
      fetchAllRows((from,to)=>db.from('submission_items').select('activity_id,actual_pct')
        .eq('submission_id',submission.id).order('activity_id').range(from,to)),
      fetchAllRows((from,to)=>db.from('activities')
        .select('id,is_summary,initial_actual_pct,source_sheet,source_row,source_actual_column,sort_order')
        .eq('project_id',submission.project_id).eq('source_file',sourceFile)
        .order('sort_order').order('id').range(from,to)),
      db.storage.from('schedule-files').download(`${submission.project_id}/${sourceFile}`)
    ]);
    if(itemsResult.error)throw itemsResult.error;
    if(activitiesResult.error)throw activitiesResult.error;
    if(fileResult.error||!fileResult.data)throw fileResult.error||Error('O arquivo original não está disponível.');
    const values=new Map((itemsResult.data||[]).map(item=>[item.activity_id,Number(item.actual_pct)]));
    const activities=activitiesResult.data||[];
    if(!activities.length)throw Error('Não encontrei as atividades deste cronograma.');
    if(activities.some(activity=>!activity.is_summary&&!values.has(activity.id))||values.size!==activities.filter(activity=>!activity.is_summary).length)
      throw Error('Os dados desta atualização estão incompletos para gerar o Excel.');
    const exportTasks=activities.map(activity=>({
      sourceSheet:activity.source_sheet,sourceRow:activity.source_row,sourceActualColumn:activity.source_actual_column,
      summary:activity.is_summary,initialActual:Number(activity.initial_actual_pct),
      originalActual:activity.is_summary?Number(activity.initial_actual_pct):values.get(activity.id)
    }));
    const XLSX=await loadXlsx();
    const workbook=XLSX.read(await fileResult.data.arrayBuffer(),{type:'array',raw:false,cellDates:true});
    updateExportWorkbook(XLSX,workbook,exportTasks);
    const projectName=submissionProjectNames.get(submission.project_id)||'Obra';
    const timestamp=new Date(submission.submitted_at).toISOString().slice(0,19).replace(/[:T]/g,'-');
    XLSX.writeFile(workbook,`${projectName.replace(/[\\/:*?"<>|]/g,'_')}_atualizacao_${timestamp}UTC_${submission.id.slice(0,8)}.xlsx`);
    notify('Excel desta atualização baixado.');
  }catch(error){notify('Não foi possível baixar o Excel desta atualização. '+(error?.message||'Tente novamente.'))}
  finally{button.disabled=false;button.textContent='Baixar Excel'}
}
$('#submission-list').addEventListener('click',event=>{
  const button=event.target.closest('button[data-submission-id]');
  if(!button||button.disabled||profile?.role!=='admin')return;
  const submission=submissions.find(item=>item.id===button.dataset.submissionId);
  if(submission)void downloadSubmissionExcel(submission,button);
});
function updateExportWorkbook(XLSX,workbook,scheduleTasks){
  const tasksBySheet=new Map();
  for(const task of scheduleTasks){
    const row=Number(task.sourceRow),column=Number(task.sourceActualColumn),value=Number(task.originalActual);
    const sheet=workbook.Sheets[task.sourceSheet];
    if(!sheet||task.sourceRow==null||task.sourceActualColumn==null||!Number.isInteger(row)||!Number.isInteger(column)||row<0||column<0)throw Error('Uma atividade não tem posição válida no cronograma original.');
    if(!Number.isFinite(value))throw Error('Uma atividade tem percentual inválido para exportação.');
    const address=XLSX.utils.encode_cell({r:row,c:column}),original=sheet[address];
    sheet[address]={t:'n',v:value/100,z:'0%'};
    if(original?.s!==undefined)sheet[address].s=original.s;
    if(!tasksBySheet.has(task.sourceSheet))tasksBySheet.set(task.sourceSheet,[]);
    tasksBySheet.get(task.sourceSheet).push(task);
  }
  for(const [sheetName,sheetTasks] of tasksBySheet){
    const sheet=workbook.Sheets[sheetName],range=XLSX.utils.decode_range(sheet['!ref']);
    const rows=XLSX.utils.sheet_to_json(sheet,{header:1,defval:'',raw:false});
    const headerIndex=headerRow(rows);
    if(headerIndex<0)throw Error('Não encontrei o cabeçalho das atividades na aba '+sheetName+'.');
    const headerRowIndex=range.s.r+headerIndex;
    let alteredColumn=-1;
    for(let column=range.s.c;column<=range.e.c;column++){
      if(key(sheet[XLSX.utils.encode_cell({r:headerRowIndex,c:column})]?.v)==='alterada'){alteredColumn=column;break}
    }
    if(alteredColumn<0)alteredColumn=++range.e.c;
    const headerAddress=XLSX.utils.encode_cell({r:headerRowIndex,c:alteredColumn});
    const adjacentHeader=sheet[XLSX.utils.encode_cell({r:headerRowIndex,c:alteredColumn-1})];
    sheet[headerAddress]={t:'s',v:'Alterada'};
    if(adjacentHeader?.s!==undefined)sheet[headerAddress].s=adjacentHeader.s;
    for(const task of sheetTasks){
      const row=Number(task.sourceRow),address=XLSX.utils.encode_cell({r:row,c:alteredColumn});
      sheet[address]={t:'s',v:submittedChange(task)?'sim':'não'};
      range.e.r=Math.max(range.e.r,row);
    }
    sheet['!ref']=XLSX.utils.encode_range(range);
  }
}
$('#export-button').onclick=async()=>{
  if(!selectedProject)return notify('Selecione uma obra para exportar.');
  if(latestUpdateProjectId!==selectedProject)return notify('Aguarde uma atualização do engenheiro desta obra para baixar o Excel atualizado.');
  const project=projects.find(p=>p.id===selectedProject);
  if(!project)return;
  if(!project.source_file)return notify('Este projeto ainda não tem cronograma para exportar.');
  const exportTasks=tasks.slice();
  const path=`${project.id}/${project.source_file}`;
  const {data:file,error}=await db.storage.from('schedule-files').download(path);
  if(error)return notify('Falha ao baixar o original. '+error.message);
  try{
    const XLSX=await loadXlsx(),workbook=XLSX.read(await file.arrayBuffer(),{type:'array',raw:false,cellDates:true});
    updateExportWorkbook(XLSX,workbook,exportTasks);
    XLSX.writeFile(workbook,`${project.name.replace(/[\\/:*?"<>|]/g,'_')}_atualizado.xlsx`);
    notify('Excel atualizado baixado.');
  }catch(error){notify('Falha ao gerar o Excel. '+error.message)}
};
window.addEventListener('focus',()=>{if(profile?.role==='admin')loadSubmissions()});setInterval(()=>{if(profile?.role==='admin')loadSubmissions()},60000);
render();start();
