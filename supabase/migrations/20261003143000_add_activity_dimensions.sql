alter table public.activities
  add column if not exists macro text,
  add column if not exists sector text,
  add column if not exists activity_local text,
  add column if not exists source_macro_column integer,
  add column if not exists source_sector_column integer,
  add column if not exists source_local_column integer;

create or replace function public.replace_project_schedule(
  p_project_id uuid,
  p_source_file text,
  p_activities jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if not coalesce(public.is_admin(), false) then
    raise exception using errcode = '42501', message = 'Apenas administradores podem substituir cronogramas.';
  end if;

  if p_project_id is null or not exists (
    select 1 from public.projects where id = p_project_id
  ) then
    raise exception using errcode = 'P0002', message = 'Projeto não encontrado.';
  end if;

  if coalesce(jsonb_typeof(p_activities), '') <> 'array' or jsonb_array_length(p_activities) = 0 then
    raise exception using errcode = '22023', message = 'O cronograma precisa conter pelo menos uma atividade.';
  end if;

  update public.activities
  set is_current = false
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
    sort_order integer,
    activity_id text,
    wbs text,
    name text,
    is_summary boolean,
    planned_pct numeric,
    initial_actual_pct numeric,
    source_sheet text,
    source_row integer,
    source_actual_column integer,
    macro text,
    sector text,
    activity_local text,
    source_macro_column integer,
    source_sector_column integer,
    source_local_column integer
  );

  update public.projects
  set source_file = p_source_file
  where id = p_project_id;
end;
$function$;

revoke all on function public.replace_project_schedule(uuid, text, jsonb) from public, anon;
grant execute on function public.replace_project_schedule(uuid, text, jsonb) to authenticated;
