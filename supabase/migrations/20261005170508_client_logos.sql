alter table public.projects add column if not exists logo_file text;

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('client-logos','client-logos',false,5242880,array['image/png','image/jpeg','image/webp'])
on conflict(id) do update set
  name=excluded.name,
  public=false,
  file_size_limit=excluded.file_size_limit,
  allowed_mime_types=excluded.allowed_mime_types;

drop policy if exists client_logos_read on storage.objects;
create policy client_logos_read on storage.objects
for select to authenticated
using(bucket_id='client-logos' and (select public.has_project_access(((storage.foldername(name))[1])::uuid)));

drop policy if exists client_logos_admin_insert on storage.objects;
create policy client_logos_admin_insert on storage.objects
for insert to authenticated
with check(bucket_id='client-logos' and (select public.is_admin()) and exists(select 1 from public.projects p where p.id::text=(storage.foldername(name))[1]));

drop policy if exists client_logos_admin_update on storage.objects;
create policy client_logos_admin_update on storage.objects
for update to authenticated
using(bucket_id='client-logos' and (select public.is_admin()))
with check(bucket_id='client-logos' and (select public.is_admin()) and exists(select 1 from public.projects p where p.id::text=(storage.foldername(name))[1]));

drop policy if exists client_logos_admin_delete on storage.objects;
create policy client_logos_admin_delete on storage.objects
for delete to authenticated
using(bucket_id='client-logos' and (select public.is_admin()));
