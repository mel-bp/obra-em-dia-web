alter table public.activities
  add column if not exists is_current boolean not null default true;

create index if not exists activities_current_project_order_idx
  on public.activities(project_id, is_current, sort_order);

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
    planned_pct, initial_actual_pct, source_sheet, source_row, source_actual_column, is_current
  )
  select
    p_project_id, row.sort_order, row.activity_id, coalesce(row.wbs, ''),
    row.name, coalesce(row.is_summary, false), coalesce(row.planned_pct, 0),
    coalesce(row.initial_actual_pct, 0), row.source_sheet, row.source_row, row.source_actual_column, true
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
    source_actual_column integer
  );

  update public.projects
  set source_file = p_source_file
  where id = p_project_id;
end;
$function$;

revoke all on function public.replace_project_schedule(uuid, text, jsonb) from public, anon;
grant execute on function public.replace_project_schedule(uuid, text, jsonb) to authenticated;

create or replace function public.latest_schedule_progress(p_project_id uuid)
returns table (
  submission_id uuid,
  submitted_at timestamp with time zone,
  submitted_by uuid,
  activity_id uuid,
  actual_pct numeric
)
language sql
stable
security invoker
set search_path = ''
as $function$
  with latest as (
    select submission.id, submission.submitted_at, submission.submitted_by
    from public.submissions as submission
    where submission.project_id = p_project_id
      and public.has_project_access(p_project_id)
      and exists (
        select 1
        from public.submission_items as item
        join public.activities as activity on activity.id = item.activity_id
        where item.submission_id = submission.id
          and activity.project_id = p_project_id
          and activity.is_current = true
      )
    order by submission.submitted_at desc
    limit 1
  )
  select latest.id, latest.submitted_at, latest.submitted_by, item.activity_id, item.actual_pct
  from latest
  join public.submission_items as item on item.submission_id = latest.id
  join public.activities as activity on activity.id = item.activity_id and activity.is_current = true
  order by activity.sort_order;
$function$;

revoke all on function public.latest_schedule_progress(uuid) from public, anon;
grant execute on function public.latest_schedule_progress(uuid) to authenticated;
