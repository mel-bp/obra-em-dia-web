-- Each project belongs to one or more responsible administrators.
create table public.project_admins (
  project_id uuid not null references public.projects(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  primary key (project_id, user_id)
);
create index project_admins_user_id_idx on public.project_admins(user_id);
alter table public.project_admins enable row level security;
revoke all on public.project_admins from anon, authenticated;
grant select on public.project_admins to authenticated;

-- Existing projects initially remain with the administrator who created them.
insert into public.project_admins(project_id, user_id)
select project.id, project.created_by
from public.projects as project
join public.profiles as creator on creator.id = project.created_by and creator.role = 'admin';

create or replace function public.assign_project_creator()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.profiles where id = new.created_by and role = 'admin') then
    raise exception using errcode = '42501', message = 'O criador do projeto precisa ser administrador.';
  end if;
  insert into public.project_admins(project_id, user_id) values (new.id, new.created_by);
  return new;
end;
$$;
revoke all on function public.assign_project_creator() from public, anon, authenticated;
create trigger assign_project_creator_after_insert
after insert on public.projects for each row execute function public.assign_project_creator();

create schema if not exists private;
revoke all on schema private from public, anon;
grant usage on schema private to authenticated;
create or replace function private.is_project_admin(target_project uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.project_admins pa
    join public.profiles profile on profile.id = pa.user_id
    where pa.project_id = target_project
      and pa.user_id = (select auth.uid())
      and profile.role = 'admin'
  );
$$;
revoke all on function private.is_project_admin(uuid) from public, anon;
grant execute on function private.is_project_admin(uuid) to authenticated;

create policy project_admins_read on public.project_admins
for select to authenticated using (private.is_project_admin(project_id));

create or replace function public.has_project_access(target_project uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select private.is_project_admin(target_project)
    or exists (
      select 1 from public.project_members pm
      where pm.project_id = target_project and pm.user_id = (select auth.uid())
    );
$$;

-- Replacing the whole set keeps at least one administrator and lets the
-- current administrator transfer a project away from their own account.
create or replace function public.set_project_admins(p_project_id uuid, p_user_ids uuid[])
returns void language plpgsql security definer set search_path = '' as $$
declare
  responsible_ids uuid[];
begin
  if p_project_id is null or p_user_ids is null or cardinality(p_user_ids) = 0
     or array_position(p_user_ids, null) is not null then
    raise exception using errcode = '22023', message = 'Selecione pelo menos um administrador responsável.';
  end if;

  perform 1 from public.projects where id = p_project_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'Projeto não encontrado.';
  end if;
  if not coalesce(private.is_project_admin(p_project_id), false) then
    raise exception using errcode = '42501', message = 'Você não é responsável por este projeto.';
  end if;

  select array_agg(distinct id) into responsible_ids
  from unnest(p_user_ids) as requested(id);
  if (select count(*) from public.profiles where id = any(responsible_ids) and role = 'admin')
     <> cardinality(responsible_ids) then
    raise exception using errcode = '22023', message = 'Selecione apenas contas de administrador ativas.';
  end if;

  insert into public.project_admins(project_id, user_id)
  select p_project_id, id from unnest(responsible_ids) as selected(id)
  on conflict do nothing;
  delete from public.project_admins
  where project_id = p_project_id and not (user_id = any(responsible_ids));
end;
$$;
revoke all on function public.set_project_admins(uuid, uuid[]) from public, anon;
grant execute on function public.set_project_admins(uuid, uuid[]) to authenticated;

drop policy if exists projects_admin_update on public.projects;
create policy projects_admin_update on public.projects
for update to authenticated
using (private.is_project_admin(id))
with check (private.is_project_admin(id));
drop policy if exists projects_admin_delete on public.projects;
create policy projects_admin_delete on public.projects
for delete to authenticated using (private.is_project_admin(id));
revoke update on public.projects from authenticated;
grant update(name, logo_file) on public.projects to authenticated;

drop policy if exists members_read on public.project_members;
create policy members_read on public.project_members
for select to authenticated
using (user_id = (select auth.uid()) or private.is_project_admin(project_id));
drop policy if exists members_admin_insert on public.project_members;
create policy members_admin_insert on public.project_members
for insert to authenticated
with check (private.is_project_admin(project_id) and assigned_by = (select auth.uid()));
drop policy if exists members_admin_delete on public.project_members;
create policy members_admin_delete on public.project_members
for delete to authenticated using (private.is_project_admin(project_id));

drop policy if exists activities_admin_insert on public.activities;
create policy activities_admin_insert on public.activities
for insert to authenticated with check (private.is_project_admin(project_id));
drop policy if exists activities_admin_update on public.activities;
create policy activities_admin_update on public.activities
for update to authenticated
using (private.is_project_admin(project_id))
with check (private.is_project_admin(project_id));
drop policy if exists activities_admin_delete on public.activities;
create policy activities_admin_delete on public.activities
for delete to authenticated using (private.is_project_admin(project_id));

drop policy if exists schedule_files_admin_insert on storage.objects;
create policy schedule_files_admin_insert on storage.objects
for insert to authenticated
with check (bucket_id = 'schedule-files' and exists (
  select 1 from public.projects p
  where p.id::text = (storage.foldername(storage.objects.name))[1]
    and private.is_project_admin(p.id)
));
drop policy if exists schedule_files_admin_update on storage.objects;
create policy schedule_files_admin_update on storage.objects
for update to authenticated
using (bucket_id = 'schedule-files' and exists (
  select 1 from public.projects p
  where p.id::text = (storage.foldername(storage.objects.name))[1]
    and private.is_project_admin(p.id)
))
with check (bucket_id = 'schedule-files' and exists (
  select 1 from public.projects p
  where p.id::text = (storage.foldername(storage.objects.name))[1]
    and private.is_project_admin(p.id)
));
drop policy if exists schedule_files_admin_delete on storage.objects;
create policy schedule_files_admin_delete on storage.objects
for delete to authenticated
using (bucket_id = 'schedule-files' and exists (
  select 1 from public.projects p
  where p.id::text = (storage.foldername(storage.objects.name))[1]
    and private.is_project_admin(p.id)
));

drop policy if exists client_logos_admin_insert on storage.objects;
create policy client_logos_admin_insert on storage.objects
for insert to authenticated
with check (bucket_id = 'client-logos' and exists (
  select 1 from public.projects p
  where p.id::text = (storage.foldername(storage.objects.name))[1]
    and private.is_project_admin(p.id)
));
drop policy if exists client_logos_admin_update on storage.objects;
create policy client_logos_admin_update on storage.objects
for update to authenticated
using (bucket_id = 'client-logos' and exists (
  select 1 from public.projects p
  where p.id::text = (storage.foldername(storage.objects.name))[1]
    and private.is_project_admin(p.id)
))
with check (bucket_id = 'client-logos' and exists (
  select 1 from public.projects p
  where p.id::text = (storage.foldername(storage.objects.name))[1]
    and private.is_project_admin(p.id)
));
drop policy if exists client_logos_admin_delete on storage.objects;
create policy client_logos_admin_delete on storage.objects
for delete to authenticated
using (bucket_id = 'client-logos' and exists (
  select 1 from public.projects p
  where p.id::text = (storage.foldername(storage.objects.name))[1]
    and private.is_project_admin(p.id)
));

create or replace function public.replace_project_schedule(p_project_id uuid, p_source_file text, p_activities jsonb)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not coalesce(private.is_project_admin(p_project_id), false) then
    raise exception using errcode = '42501', message = 'Apenas os administradores responsáveis podem substituir cronogramas.';
  end if;
  if p_project_id is null or not exists (select 1 from public.projects where id = p_project_id) then
    raise exception using errcode = 'P0002', message = 'Projeto não encontrado.';
  end if;
  if coalesce(jsonb_typeof(p_activities), '') <> 'array' or jsonb_array_length(p_activities) = 0 then
    raise exception using errcode = '22023', message = 'O cronograma precisa conter pelo menos uma atividade.';
  end if;

  update public.activities set is_current = false
  where project_id = p_project_id and is_current = true;
  insert into public.activities (
    project_id, sort_order, activity_id, wbs, name, is_summary,
    planned_pct, initial_actual_pct, source_sheet, source_row, source_actual_column,
    macro, sector, activity_local, source_macro_column, source_sector_column, source_local_column, is_current
  )
  select
    p_project_id, row.sort_order, row.activity_id, coalesce(row.wbs, ''),
    row.name, coalesce(row.is_summary, false), coalesce(row.planned_pct, 0),
    coalesce(row.initial_actual_pct, 0), row.source_sheet, row.source_row, row.source_actual_column,
    row.macro, row.sector, row.activity_local, row.source_macro_column, row.source_sector_column, row.source_local_column, true
  from jsonb_to_recordset(p_activities) as row(
    sort_order integer, activity_id text, wbs text, name text, is_summary boolean,
    planned_pct numeric, initial_actual_pct numeric, source_sheet text,
    source_row integer, source_actual_column integer, macro text, sector text,
    activity_local text, source_macro_column integer, source_sector_column integer,
    source_local_column integer
  );
  update public.projects set source_file = p_source_file where id = p_project_id;
end;
$$;
