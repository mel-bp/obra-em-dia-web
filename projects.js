const cfg=window.OBRA_SUPABASE;
const $=selector=>document.querySelector(selector);
let db=null,adminProfile=null,projects=[],members=[],profiles=new Map(),projectForEngineerDialog=null;
const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const normalizeName=value=>String(value??'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').trim().replace(/\s+/g,' ').toLocaleLowerCase('pt-BR');
function notify(message){const toast=$('#toast');toast.textContent=message;toast.classList.add('show');setTimeout(()=>toast.classList.remove('show'),4500)}
function showPageMessage(message,isError=false){const target=$('#projects-message');target.textContent=message;target.classList.toggle('error',isError)}
function personName(person,fallback){return person?.display_name||person?.email||fallback||'Nome não informado'}
function membersFor(projectId){return members.filter(member=>member.project_id===projectId)}
function renderProjects(){
  const list=$('#project-list');
  if(!projects.length){list.innerHTML='<div class="projects-empty">Nenhum projeto cadastrado.</div>';return}
  list.innerHTML=projects.map(project=>{
    const projectMembers=membersFor(project.id),creator=profiles.get(project.created_by),creatorLabel=personName(creator,'Administrador não identificado');
    const memberNames=projectMembers.map(member=>{const person=profiles.get(member.user_id);return '<li>'+esc(personName(person,'Engenheiro não identificado'))+(person?.email&&person.email!==person.display_name?'<small>'+esc(person.email)+'</small>':'')+'</li>'}).join('')||'<li class="no-members">Nenhum engenheiro vinculado.</li>';
    const memberChoices=projectMembers.map(member=>{const person=profiles.get(member.user_id);return '<label class="project-member-choice"><input type="checkbox" data-member-selection value="'+esc(member.user_id)+'"><span>'+esc(personName(person,'Engenheiro não identificado'))+(person?.email?'<small>'+esc(person.email)+'</small>':'')+'</span></label>'}).join('')||'<p class="no-members">Este projeto ainda não tem engenheiros vinculados.</p>';
    return '<article class="project-card" data-project-card="'+esc(project.id)+'">'+
      '<div class="project-card-heading"><div><p class="eyebrow">PROJETO</p><h2>'+esc(project.name)+'</h2></div><div class="project-card-actions"><button class="button secondary" type="button" data-action="edit">Editar</button><button class="button danger" type="button" data-action="delete-project">Excluir projeto</button></div></div>'+
      '<p class="project-created-by">Cadastrado por <strong>'+esc(creatorLabel)+'</strong></p>'+
      '<div class="project-engineers"><h3>Engenheiros vinculados</h3><ul class="project-engineer-list">'+memberNames+'</ul></div>'+
      '<section class="project-edit-panel" data-edit-panel hidden>'+
        '<label class="project-name-field">Nome do projeto<input class="project-name-input" type="text" maxlength="180" value="'+esc(project.name)+'"></label>'+
        '<div class="project-edit-actions"><button class="button primary" type="button" data-action="save-name">Salvar alterações</button><button class="button secondary" type="button" data-action="cancel-edit">Cancelar edição</button></div>'+
        '<div class="project-member-management"><h3>Desligar engenheiros deste projeto</h3><p>Selecione uma ou mais pessoas. A conta delas continuará ativa e o acesso aos outros projetos será mantido.</p><div class="project-member-choices">'+memberChoices+'</div><button class="button secondary" type="button" data-action="remove-members"'+(projectMembers.length?'':' disabled')+'>Desligar selecionados</button></div>'+
        '<button class="button secondary" type="button" data-action="add-engineers">Adicionar engenheiros</button>'+
      '</section>'+
    '</article>';
  }).join('');
}
async function loadProjects(){
  showPageMessage('');
  $('#project-list').innerHTML='<div class="projects-empty">Carregando projetos…</div>';
  const {data:projectRows,error:projectError}=await db.from('projects').select('id,name,created_by,created_at').order('name');
  if(projectError){showPageMessage('Não foi possível carregar os projetos: '+projectError.message,true);return}
  projects=projectRows||[];
  const projectIds=projects.map(project=>project.id);
  if(!projectIds.length){members=[];profiles=new Map();renderProjects();return}
  const {data:memberRows,error:memberError}=await db.from('project_members').select('project_id,user_id').in('project_id',projectIds);
  if(memberError){showPageMessage('Não foi possível carregar os engenheiros dos projetos: '+memberError.message,true);return}
  members=memberRows||[];
  const profileIds=[...new Set([...projects.map(project=>project.created_by),...members.map(member=>member.user_id)].filter(Boolean))];
  if(profileIds.length){
    const {data:profileRows,error:profileError}=await db.from('profiles').select('id,email,display_name').in('id',profileIds);
    if(profileError){showPageMessage('Não foi possível carregar os nomes dos responsáveis: '+profileError.message,true);return}
    profiles=new Map((profileRows||[]).map(person=>[person.id,person]));
  }else profiles=new Map();
  renderProjects();
}
async function askForConfirmation(title,copy,confirmLabel){
  const dialog=$('#confirmation-dialog');
  $('#confirmation-title').textContent=title;
  $('#confirmation-copy').textContent=copy;
  $('#confirm-action').textContent=confirmLabel||'Confirmar';
  return new Promise(resolve=>{
    dialog.addEventListener('close',()=>resolve(dialog.returnValue==='confirm'),{once:true});
    dialog.showModal();
  });
}
$('#confirmation-form').addEventListener('submit',event=>{event.preventDefault();$('#confirmation-dialog').close('confirm')});
$('#cancel-confirmation').onclick=()=>$('#confirmation-dialog').close('cancel');
$('#close-confirmation').onclick=()=>$('#confirmation-dialog').close('cancel');
async function saveProjectName(project,card,button){
  const name=card.querySelector('.project-name-input').value.trim();
  if(!name||name.length>180){showPageMessage('Informe um nome de projeto com até 180 caracteres.',true);return}
  if(projects.some(item=>item.id!==project.id&&normalizeName(item.name)===normalizeName(name))){showPageMessage('Já existe um projeto com esse nome.',true);return}
  if(name===project.name){card.querySelector('[data-edit-panel]').hidden=true;return}
  button.disabled=true;
  const {data,error}=await db.from('projects').update({name}).eq('id',project.id).select('id').maybeSingle();
  button.disabled=false;
  if(error||!data){showPageMessage('Não foi possível salvar o projeto: '+(error?.message||'projeto não encontrado.'),true);return}
  await loadProjects();
  notify('Nome do projeto atualizado.');
}
async function removeProjectMembers(project,card,button){
  const userIds=[...card.querySelectorAll('[data-member-selection]:checked')].map(input=>input.value);
  if(!userIds.length){showPageMessage('Selecione pelo menos um engenheiro para desligar deste projeto.',true);return}
  const names=userIds.map(id=>personName(profiles.get(id),'Engenheiro não identificado')).join(', ');
  const confirmed=await askForConfirmation('Desligar engenheiro(s) deste projeto?','Quer desligar '+names+' deste projeto? Essas pessoas deixarão de ter acesso a esta obra. As contas e os vínculos com outros projetos serão mantidos.','DESLIGAR SELECIONADOS');
  if(!confirmed)return;
  button.disabled=true;
  const {error}=await db.from('project_members').delete().eq('project_id',project.id).in('user_id',userIds);
  button.disabled=false;
  if(error){showPageMessage('Não foi possível desligar os engenheiros: '+error.message,true);return}
  await loadProjects();
  notify('Acesso removido para os engenheiros selecionados.');
}
async function collectProjectFiles(projectId){
  const paths=[];let offset=0;
  while(true){
    const {data,error}=await db.storage.from('schedule-files').list(projectId,{limit:100,offset});
    if(error)throw Error('Não foi possível verificar os arquivos do cronograma: '+error.message);
    const batch=data||[];
    batch.forEach(file=>{if(file.name)paths.push(projectId+'/'+file.name)});
    if(batch.length<100)break;
    offset+=batch.length;
  }
  return paths;
}
async function removeProjectFiles(paths){
  for(let offset=0;offset<paths.length;offset+=100){
    const {error}=await db.storage.from('schedule-files').remove(paths.slice(offset,offset+100));
    if(error)throw error;
  }
}
async function deleteProject(project,button){
  const confirmed=await askForConfirmation('Excluir este projeto?','Quer excluir o projeto “'+project.name+'”? Todos os dados associados serão apagados do banco de dados, incluindo cronograma, atividades, vínculos com engenheiros e atualizações.','EXCLUIR PROJETO');
  if(!confirmed)return;
  button.disabled=true;
  try{
    const filePaths=await collectProjectFiles(project.id);
    const {data,error}=await db.from('projects').delete().eq('id',project.id).select('id').maybeSingle();
    if(error)throw error;
    if(!data)throw Error('O projeto não foi encontrado ou não pôde ser excluído.');
    projects=projects.filter(item=>item.id!==project.id);
    members=members.filter(member=>member.project_id!==project.id);
    renderProjects();
    try{
      await removeProjectFiles(filePaths);
      notify('Projeto, dados associados e arquivos do cronograma excluídos.');
    }catch(storageError){
      notify('Projeto e dados do banco excluídos. Não foi possível remover todos os arquivos do cronograma: '+storageError.message);
    }
  }catch(error){
    button.disabled=false;
    showPageMessage('Não foi possível excluir o projeto: '+error.message,true);
  }
}
function updateEngineerRows(){
  const rows=[...$('#add-engineer-rows').querySelectorAll('.engineer-registration-row')];
  rows.forEach((row,index)=>{const remove=row.querySelector('.remove-engineer-row');remove.hidden=rows.length===1;remove.setAttribute('aria-label','Remover engenheiro '+(index+1))});
  $('#add-engineer-row').disabled=rows.length>=25;
}
function addEngineerRow(){
  const row=document.createElement('div');
  row.className='engineer-registration-row';
  row.innerHTML='<label>Nome do engenheiro<input class="add-engineer-name" type="text" maxlength="120" autocomplete="name" required></label><label>E-mail do engenheiro<input class="add-engineer-email" type="email" maxlength="254" autocomplete="email" required></label><button class="button secondary remove-engineer-row" type="button" aria-label="Remover engenheiro">−</button>';
  row.querySelector('.remove-engineer-row').onclick=()=>{row.remove();updateEngineerRows()};
  $('#add-engineer-rows').append(row);
  updateEngineerRows();
}
function openAddEngineers(project){
  projectForEngineerDialog=project;
  $('#add-engineer-project-name').textContent=project.name;
  $('#add-engineer-message').textContent='';
  $('#add-engineer-dialog').showModal();
}
$('#add-engineer-row').onclick=addEngineerRow;
$('#close-add-engineer').onclick=()=>$('#add-engineer-dialog').close();
$('#cancel-add-engineer').onclick=()=>$('#add-engineer-dialog').close();
$('#add-engineer-dialog').addEventListener('close',()=>{
  $('#add-engineer-form').reset();
  $('#add-engineer-rows').querySelectorAll('.engineer-registration-row').forEach((row,index)=>{if(index>0)row.remove()});
  $('#add-engineer-message').textContent='';
  updateEngineerRows();
  projectForEngineerDialog=null;
});
$('#add-engineer-form').addEventListener('submit',async event=>{
  event.preventDefault();
  if(!projectForEngineerDialog)return;
  const button=$('#submit-add-engineers'),message=$('#add-engineer-message');
  const engineers=[...$('#add-engineer-rows').querySelectorAll('.engineer-registration-row')].map(row=>({name:row.querySelector('.add-engineer-name').value.trim(),email:row.querySelector('.add-engineer-email').value.trim().toLowerCase()}));
  const emails=new Set();
  for(const engineer of engineers){
    if(emails.has(engineer.email)){message.textContent='O mesmo e-mail foi informado mais de uma vez.';return}
    emails.add(engineer.email);
  }
  button.disabled=true;message.textContent='Vinculando os engenheiros ao projeto…';
  try{
    const {data,error}=await db.functions.invoke('register-project',{body:{projectId:projectForEngineerDialog.id,engineers}});
    if(error||data?.error){message.textContent=data?.error||error.message||'Não foi possível adicionar os engenheiros.';return}
    const failed=(data.results||[]).filter(item=>item.status==='error');
    await loadProjects();
    if(failed.length){message.textContent='Algumas pessoas não foram adicionadas: '+failed.map(item=>item.name+' ('+item.email+'): '+item.message).join(' ');return}
    $('#add-engineer-dialog').close();
    notify('Engenheiros vinculados ao projeto.');
  }catch(error){message.textContent='Não foi possível adicionar os engenheiros. Tente novamente.'}
  finally{button.disabled=false}
});
$('#project-list').addEventListener('click',async event=>{
  const button=event.target.closest('button[data-action]');
  if(!button)return;
  const card=button.closest('[data-project-card]'),project=projects.find(item=>item.id===card?.dataset.projectCard);
  if(!project)return;
  const action=button.dataset.action;
  if(action==='edit'){const panel=card.querySelector('[data-edit-panel]');panel.hidden=!panel.hidden;return}
  if(action==='cancel-edit'){card.querySelector('[data-edit-panel]').hidden=true;card.querySelector('.project-name-input').value=project.name;return}
  if(action==='save-name'){await saveProjectName(project,card,button);return}
  if(action==='remove-members'){await removeProjectMembers(project,card,button);return}
  if(action==='delete-project'){await deleteProject(project,button);return}
  if(action==='add-engineers')openAddEngineers(project);
});
$('#back-to-app').onclick=()=>{window.location.href='./index.html'};
$('#logout-button').onclick=async()=>{if(db)await db.auth.signOut();window.location.href='./index.html'};
$('#refresh-projects').onclick=()=>loadProjects();
async function start(){
  if(!window.supabase||!cfg?.url||!cfg?.publishableKey){showPageMessage('Não consegui carregar a conexão do Supabase.',true);return}
  db=window.supabase.createClient(cfg.url,cfg.publishableKey);
  db.auth.onAuthStateChange(event=>{if(event==='SIGNED_OUT')window.location.href='./index.html'});
  const {data:{session}}=await db.auth.getSession();
  if(!session){window.location.href='./index.html';return}
  const {data:profile,error}=await db.from('profiles').select('id,email,display_name,role').eq('id',session.user.id).maybeSingle();
  if(error||!profile||profile.role!=='admin'){window.location.href='./index.html';return}
  adminProfile=profile;
  $('#user-label').textContent=profile.display_name||profile.email||'Administrador';
  $('#avatar').textContent=(profile.display_name||profile.email||'A').slice(0,2).toUpperCase();
  await loadProjects();
}
start();
