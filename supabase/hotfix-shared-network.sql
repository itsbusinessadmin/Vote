-- Fix: people sharing a Wi-Fi or mobile network, or with the same phone
-- model, were treated as one voter and shown "already voted".
-- Paste into Supabase -> SQL Editor -> New query, then click Run.
-- Safe to run more than once. No votes are changed.

-- 1. Switch off the "same internet connection" rules for every event.
update public.events set limit_by_ip = false, max_voters_per_network = 0;

-- 2. Match voters without any IP rule; phones by their own browser only.
create or replace function public._ip_net(ip text)
returns text language sql immutable as $$
  select case when coalesce(ip, '') like '%:%'
              then array_to_string((string_to_array(ip, ':'))[1:4], ':')
              else array_to_string((string_to_array(coalesce(ip, ''), '.'))[1:3], '.') end;
$$;

create or replace function public._ip_conn(ip text)
returns text language sql immutable as $$
  select case when coalesce(ip, '') like '%:%' then public._ip_net(ip) else coalesce(ip, '') end;
$$;

create or replace function public._matching_voters(
  e public.events, p_fp text, p_tok text, p_ip text, p_name_norm text, p_email text, p_phone text, p_cross text)
returns uuid[] language sql stable security definer set search_path = public as $$
  -- One indexed lookup per rule (an OR across all rules would scan every voter).
  select coalesce(array_agg(distinct id), '{}') from (
    -- same browser is always the same voter
    select id from public.voters where p_tok <> '' and event_id = e.id and device_token = p_tok
    union all
    -- Fingerprint and "same computer" checks: computers only, on the same
    -- internet connection. Phones of one model (and iOS version) produce
    -- identical traits, so on phones these would lump strangers together;
    -- phones are recognised by their browser token instead.
    select id from public.voters where e.limit_by_fingerprint and p_fp <> '' and p_ip <> '' and event_id = e.id and fingerprint = p_fp
      and device_info ->> 'type' = 'Desktop / Laptop' and public._ip_conn(ip) = public._ip_conn(p_ip)
    union all
    -- same computer, different browser
    select id from public.voters where e.limit_by_cross_browser and p_cross <> '' and p_ip <> '' and event_id = e.id and cross_id = p_cross
      and device_info ->> 'type' = 'Desktop / Laptop' and public._ip_conn(ip) = public._ip_conn(p_ip)
    union all
    select id from public.voters where e.limit_by_name and p_name_norm <> '' and event_id = e.id and name_norm = p_name_norm
    union all
    select id from public.voters where e.limit_by_contact and p_email <> '' and event_id = e.id and email = p_email
    union all
    select id from public.voters where e.limit_by_contact and p_phone <> '' and event_id = e.id and phone = p_phone
  ) m;
$$;

revoke all on function public._matching_voters(public.events, text, text, text, text, text, text, text) from public, anon, authenticated;

-- 3. Show the result: limit_by_ip should be false and max_voters_per_network 0.
select slug, limit_by_ip, max_voters_per_network, limit_by_fingerprint, limit_by_cross_browser from public.events;
