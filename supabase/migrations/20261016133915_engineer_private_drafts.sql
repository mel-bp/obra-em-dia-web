-- Each engineer's unsubmitted percentages are private to their account and project.
create table public.activity_drafts (
  user_id uuid not null references auth.users(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  activity_id uuid not null references public.activities(id) on delete cascade,
  actual_pct numeric not null check (actual_pct between 0 and 100),
  primary key (user_id, activity_id)
);

create index activity_drafts_user_project_idx
  on public.activity_drafts (user_id, project_id);

alter table public.activity_drafts enable row level security;
revoke all on table public.activity_drafts from public, anon, authenticated;
grant select, insert, update, delete on table public.activity_drafts to authenticated;

create policy "Engineers read only their own drafts"
  on public.activity_drafts for select to authenticated
  using (
    user_id = (select auth.uid())
    and public.has_project_access(project_id)
  );

create policy "Engineers create only valid own drafts"
  on public.activity_drafts for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and public.has_project_access(project_id)
    and exists (
      select 1 from public.activities activity
      where activity.id = activity_drafts.activity_id
        and activity.project_id = activity_drafts.project_id
        and activity.is_current = true
        and activity.is_summary = false
    )
  );

create policy "Engineers update only valid own drafts"
  on public.activity_drafts for update to authenticated
  using (
    user_id = (select auth.uid())
    and public.has_project_access(project_id)
  )
  with check (
    user_id = (select auth.uid())
    and public.has_project_access(project_id)
    and exists (
      select 1 from public.activities activity
      where activity.id = activity_drafts.activity_id
        and activity.project_id = activity_drafts.project_id
        and activity.is_current = true
        and activity.is_summary = false
    )
  );

create policy "Engineers delete only their own drafts"
  on public.activity_drafts for delete to authenticated
  using (
    user_id = (select auth.uid())
    and public.has_project_access(project_id)
  );

-- Submission and draft removal share one transaction. A failed submission
-- therefore leaves the engineer's private work intact.
create function public.submit_progress_with_draft_clear(
  target_project uuid,
  items jsonb
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  new_submission uuid;
begin
  new_submission := public.submit_progress(target_project, items);

  delete from public.activity_drafts
  where project_id = target_project
    and user_id = (select auth.uid());

  return new_submission;
end;
$function$;

revoke all on function public.submit_progress_with_draft_clear(uuid, jsonb) from public, anon;
grant execute on function public.submit_progress_with_draft_clear(uuid, jsonb) to authenticated;
