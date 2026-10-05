alter table public.activities
  drop constraint if exists activities_project_id_sort_order_key;

create unique index if not exists activities_current_project_sort_order_key
  on public.activities (project_id, sort_order)
  where is_current = true;
