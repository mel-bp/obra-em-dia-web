-- Resolve the storage object path, not the project name inside the subquery.
drop policy if exists client_logos_admin_insert on storage.objects;
create policy client_logos_admin_insert on storage.objects
for insert to authenticated
with check (
  bucket_id = 'client-logos'
  and (select public.is_admin())
  and exists (
    select 1 from public.projects p
    where p.id::text = (storage.foldername(storage.objects.name))[1]
  )
);

drop policy if exists client_logos_admin_update on storage.objects;
create policy client_logos_admin_update on storage.objects
for update to authenticated
using (bucket_id = 'client-logos' and (select public.is_admin()))
with check (
  bucket_id = 'client-logos'
  and (select public.is_admin())
  and exists (
    select 1 from public.projects p
    where p.id::text = (storage.foldername(storage.objects.name))[1]
  )
);
