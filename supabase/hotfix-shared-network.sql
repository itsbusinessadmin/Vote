-- Fix: different people were shown "already voted" because they shared an
-- internet connection, a device fingerprint (identical laptops) or a phone
-- model. Voters are now recognised by their own browser only.
-- Paste into Supabase -> SQL Editor -> New query, then click Run.
-- Safe to run more than once. No votes are changed.

-- 1. Switch off every rule that matched voters by network or device traits.
update public.events set limit_by_ip = false, max_voters_per_network = 0, limit_by_cross_browser = false, limit_by_fingerprint = false;

-- 2. The matching rules without network or fingerprint matching.
create or replace function public._matching_voters(
  e public.events, p_fp text, p_tok text, p_ip text, p_name_norm text, p_email text, p_phone text, p_cross text)
returns uuid[] language sql stable security definer set search_path = public as $$
  -- One indexed lookup per rule (an OR across all rules would scan every voter).
  select coalesce(array_agg(distinct id), '{}') from (
    -- same browser is always the same voter
    select id from public.voters where p_tok <> '' and event_id = e.id and device_token = p_tok
    union all
    -- No device-fingerprint or network matching: identical phones and
    -- identical office/school laptops share fingerprints and connections, so
    -- those checks treated different people as one voter.
    select id from public.voters where e.limit_by_name and p_name_norm <> '' and event_id = e.id and name_norm = p_name_norm
    union all
    select id from public.voters where e.limit_by_contact and p_email <> '' and event_id = e.id and email = p_email
    union all
    select id from public.voters where e.limit_by_contact and p_phone <> '' and event_id = e.id and phone = p_phone
  ) m;
$$;

revoke all on function public._matching_voters(public.events, text, text, text, text, text, text, text) from public, anon, authenticated;

-- 3. Show the result: limit_by_ip false, max_voters_per_network 0,
--    limit_by_cross_browser false, limit_by_fingerprint false.
select slug, limit_by_ip, max_voters_per_network, limit_by_cross_browser, limit_by_fingerprint from public.events;
