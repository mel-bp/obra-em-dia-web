create or replace function public.latest_project_update_author(p_project_id uuid)
returns table (engineer_name text)
language sql
stable
security definer
set search_path = ''
as $function$
  select coalesce(nullif(btrim(profile.display_name), ''), profile.email)::text
  from public.submissions as submission
  join public.profiles as profile on profile.id = submission.submitted_by
  where submission.project_id = p_project_id
    and public.has_project_access(p_project_id)
    and exists (
      select 1
      from public.submission_items as item
      join public.activities as activity
        on activity.id = item.activity_id
       and activity.project_id = p_project_id
       and activity.is_current = true
      where item.submission_id = submission.id
    )
  order by submission.submitted_at desc
  limit 1;
$function$;

revoke all on function public.latest_project_update_author(uuid) from public, anon;
grant execute on function public.latest_project_update_author(uuid) to authenticated;