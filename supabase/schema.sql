-- =====================================================================
--  Vote App — Supabase schema
--  Paste this whole file into Supabase → SQL Editor → Run.
--  It is safe to run again (idempotent) after updates.
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------
-- Admins
-- ---------------------------------------------------------------------
create table if not exists public.admins (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.admins where user_id = auth.uid());
$$;

-- The first signed-in user to call this becomes the admin. After that it
-- only succeeds for users who already are admins.
create or replace function public.claim_admin()
returns boolean language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then return false; end if;
  if exists (select 1 from public.admins where user_id = auth.uid()) then return true; end if;
  lock table public.admins in exclusive mode;
  if exists (select 1 from public.admins) then return false; end if;
  insert into public.admins (user_id) values (auth.uid());
  return true;
end;
$$;

-- ---------------------------------------------------------------------
-- Events
-- ---------------------------------------------------------------------
create table if not exists public.events (
  id                        uuid primary key default gen_random_uuid(),
  slug                      text not null unique,
  title                     text not null default 'New Event',
  subtitle                  text,
  description               text,
  logo_url                  text,
  banner_url                text,
  theme_color               text not null default '#7c3aed',
  status                    text not null default 'draft' check (status in ('draft', 'open', 'closed')),
  starts_at                 timestamptz,
  ends_at                   timestamptz,

  -- how votes work
  voting_mode               text not null default 'simple' check (voting_mode in ('simple', 'criteria')),
  score_max                 int  not null default 10 check (score_max between 2 and 100),
  pricing                   text not null default 'free' check (pricing in ('free', 'paid')),
  price_per_vote            numeric(12, 2) not null default 0,
  currency                  text not null default 'PHP',
  payment_instructions      text,
  payment_qr_url            text,
  require_payment_proof     boolean not null default true,
  max_qty_per_vote          int  not null default 100 check (max_qty_per_vote >= 1),
  max_votes_per_voter       int  not null default 1 check (max_votes_per_voter >= 0),      -- 0 = unlimited
  max_contestants_per_voter int  not null default 1 check (max_contestants_per_voter >= 0), -- 0 = unlimited
  allow_repeat_contestant   boolean not null default false,

  -- voter identity fields
  require_name              boolean not null default true,
  ask_email                 boolean not null default false,
  email_domains             text,  -- e.g. 'ces.edu.ph, deped.gov.ph'; empty = any domain
  ask_phone                 boolean not null default false,
  extra_field_label         text,

  -- anti-cheat
  limit_by_fingerprint      boolean not null default true,
  limit_by_cross_browser    boolean not null default true,
  limit_by_ip               boolean not null default false,
  limit_by_name             boolean not null default false,
  limit_by_contact          boolean not null default true,
  block_bots                boolean not null default true,
  cooldown_seconds          int  not null default 3 check (cooldown_seconds >= 0),

  -- public display
  show_live_results         boolean not null default false,
  show_vote_counts          boolean not null default false,

  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now()
);

create table if not exists public.contestants (
  id          uuid primary key default gen_random_uuid(),
  event_id    uuid not null references public.events (id) on delete cascade,
  number      text,
  name        text not null,
  description text,
  photo_url   text,
  sort_order  int  not null default 0,
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);
create index if not exists contestants_event_idx on public.contestants (event_id, sort_order);

create table if not exists public.criteria (
  id          uuid primary key default gen_random_uuid(),
  event_id    uuid not null references public.events (id) on delete cascade,
  name        text not null,
  description text,
  weight      numeric(6, 2) not null default 0 check (weight >= 0),
  sort_order  int not null default 0,
  created_at  timestamptz not null default now()
);
create index if not exists criteria_event_idx on public.criteria (event_id, sort_order);

create table if not exists public.voters (
  id            uuid primary key default gen_random_uuid(),
  event_id      uuid not null references public.events (id) on delete cascade,
  name          text,
  name_norm     text,
  email         text,
  phone         text,
  extra         text,
  fingerprint   text,
  cross_id      text,
  device_token  text,
  ip            text,
  user_agent    text,
  device_info   jsonb,
  blocked       boolean not null default false,
  created_at    timestamptz not null default now(),
  last_seen_at  timestamptz not null default now()
);
-- Columns added after the first release (no-ops on fresh installs).
alter table public.events add column if not exists limit_by_cross_browser boolean not null default true;
alter table public.voters add column if not exists cross_id text;
alter table public.events add column if not exists email_domains text;

create index if not exists voters_fp_idx    on public.voters (event_id, fingerprint);
create index if not exists voters_cross_idx on public.voters (event_id, cross_id);
create index if not exists voters_tok_idx   on public.voters (event_id, device_token);
create index if not exists voters_ip_idx    on public.voters (event_id, ip);
create index if not exists voters_name_idx  on public.voters (event_id, name_norm);
create index if not exists voters_email_idx on public.voters (event_id, email);
create index if not exists voters_phone_idx on public.voters (event_id, phone);

create table if not exists public.votes (
  id            uuid primary key default gen_random_uuid(),
  event_id      uuid not null references public.events (id) on delete cascade,
  contestant_id uuid not null references public.contestants (id) on delete cascade,
  voter_id      uuid not null references public.voters (id) on delete cascade,
  quantity      int  not null default 1 check (quantity > 0),
  status        text not null default 'approved' check (status in ('approved', 'pending', 'rejected')),
  amount        numeric(12, 2),
  payment_ref   text,
  proof_path    text,
  scores        jsonb,
  ip            text,
  created_at    timestamptz not null default now(),
  reviewed_at   timestamptz
);
create index if not exists votes_event_idx   on public.votes (event_id, status);
create index if not exists votes_voter_idx   on public.votes (voter_id);
create index if not exists votes_contest_idx on public.votes (contestant_id);

-- Every rejected attempt is logged so the admin can spot cheating.
create table if not exists public.vote_attempts (
  id            uuid primary key default gen_random_uuid(),
  event_id      uuid references public.events (id) on delete cascade,
  contestant_id uuid,
  code          text not null,
  name          text,
  fingerprint   text,
  device_token  text,
  ip            text,
  user_agent    text,
  created_at    timestamptz not null default now()
);
create index if not exists vote_attempts_event_idx on public.vote_attempts (event_id, created_at desc);

create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end;
$$;
drop trigger if exists events_touch on public.events;
create trigger events_touch before update on public.events
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------
alter table public.admins        enable row level security;
alter table public.events        enable row level security;
alter table public.contestants   enable row level security;
alter table public.criteria      enable row level security;
alter table public.voters        enable row level security;
alter table public.votes         enable row level security;
alter table public.vote_attempts enable row level security;

drop policy if exists admins_self on public.admins;
create policy admins_self on public.admins for select using (user_id = auth.uid());

drop policy if exists events_read on public.events;
create policy events_read on public.events for select using (status <> 'draft' or public.is_admin());
drop policy if exists events_admin on public.events;
create policy events_admin on public.events for all using (public.is_admin()) with check (public.is_admin());

drop policy if exists contestants_read on public.contestants;
create policy contestants_read on public.contestants for select using (
  public.is_admin() or exists (select 1 from public.events e where e.id = event_id and e.status <> 'draft'));
drop policy if exists contestants_admin on public.contestants;
create policy contestants_admin on public.contestants for all using (public.is_admin()) with check (public.is_admin());

drop policy if exists criteria_read on public.criteria;
create policy criteria_read on public.criteria for select using (
  public.is_admin() or exists (select 1 from public.events e where e.id = event_id and e.status <> 'draft'));
drop policy if exists criteria_admin on public.criteria;
create policy criteria_admin on public.criteria for all using (public.is_admin()) with check (public.is_admin());

-- Voters, votes and attempts: admin only. The public writes through cast_vote().
drop policy if exists voters_admin on public.voters;
create policy voters_admin on public.voters for all using (public.is_admin()) with check (public.is_admin());
drop policy if exists votes_admin on public.votes;
create policy votes_admin on public.votes for all using (public.is_admin()) with check (public.is_admin());
drop policy if exists attempts_admin on public.vote_attempts;
create policy attempts_admin on public.vote_attempts for all using (public.is_admin()) with check (public.is_admin());

-- ---------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------
create or replace function public._client_ip()
returns text language plpgsql stable as $$
declare h json;
begin
  h := nullif(current_setting('request.headers', true), '')::json;
  if h is null then return ''; end if;
  return trim(split_part(coalesce(h ->> 'cf-connecting-ip', h ->> 'x-forwarded-for', h ->> 'x-real-ip', ''), ',', 1));
end;
$$;

create or replace function public._norm(t text)
returns text language sql immutable as $$
  select regexp_replace(lower(trim(coalesce(t, ''))), '[^a-z0-9]+', '', 'g');
$$;

create or replace function public._norm_phone(t text)
returns text language sql immutable as $$
  select right(regexp_replace(coalesce(t, ''), '[^0-9]+', '', 'g'), 10);
$$;

-- The household/office network an address belongs to. IPv6 devices rotate
-- their last 64 bits for privacy, so compare the /64 prefix only.
create or replace function public._ip_net(ip text)
returns text language sql immutable as $$
  select case when coalesce(ip, '') like '%:%'
              then array_to_string((string_to_array(ip, ':'))[1:4], ':')
              else coalesce(ip, '') end;
$$;

-- All voter rows in this event that count as "the same person" under the
-- event's anti-cheat rules.
drop function if exists public._matching_voters(public.events, text, text, text, text, text, text);
create or replace function public._matching_voters(
  e public.events, p_fp text, p_tok text, p_ip text, p_name_norm text, p_email text, p_phone text, p_cross text)
returns uuid[] language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(v.id), '{}')
  from public.voters v
  where v.event_id = e.id and (
       (p_tok <> '' and v.device_token = p_tok)  -- same browser is always the same voter
    or (e.limit_by_fingerprint and p_fp <> '' and v.fingerprint = p_fp)
    -- same computer, different browser: identical hardware traits on the same network
    or (e.limit_by_cross_browser and p_cross <> '' and p_ip <> ''
        and v.cross_id = p_cross and public._ip_net(v.ip) = public._ip_net(p_ip))
    or (e.limit_by_ip and p_ip <> '' and v.ip = p_ip)
    or (e.limit_by_name and p_name_norm <> '' and v.name_norm = p_name_norm)
    or (e.limit_by_contact and p_email <> '' and v.email = p_email)
    or (e.limit_by_contact and p_phone <> '' and v.phone = p_phone)
  );
$$;

-- ---------------------------------------------------------------------
-- Public: cast a vote
--   p_voter = { name, email, phone, extra, fingerprint, device_token,
--               user_agent, device_info, webdriver }
-- Returns { ok, code, message?, status?, remaining? }
-- ---------------------------------------------------------------------
create or replace function public.cast_vote(
  p_event_id      uuid,
  p_contestant_id uuid,
  p_voter         jsonb,
  p_quantity      int   default 1,
  p_scores        jsonb default null,
  p_payment_ref   text  default null,
  p_proof_path    text  default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  e          public.events;
  v_ip       text := public._client_ip();
  v_fp       text := left(coalesce(p_voter ->> 'fingerprint', ''), 128);
  v_cross    text := left(coalesce(p_voter ->> 'cross_id', ''), 128);
  v_tok      text := left(coalesce(p_voter ->> 'device_token', ''), 128);
  v_name     text := left(trim(coalesce(p_voter ->> 'name', '')), 80);
  v_norm     text;
  v_email    text := left(lower(trim(coalesce(p_voter ->> 'email', ''))), 120);
  v_phone    text := public._norm_phone(p_voter ->> 'phone');
  v_extra    text := left(trim(coalesce(p_voter ->> 'extra', '')), 120);
  v_ua       text := left(coalesce(p_voter ->> 'user_agent', ''), 400);
  v_qty      int  := coalesce(p_quantity, 1);
  v_ids      uuid[];
  v_voter_id uuid;
  v_used     int;
  v_distinct int;
  v_last     timestamptz;
  v_status   text;
  v_scores   jsonb := null;
  v_score    numeric;
  c          record;
  v_code     text := null;
  v_msg      text := null;
begin
  v_norm := public._norm(v_name);

  select * into e from public.events where id = p_event_id;
  if not found or e.status = 'draft' then
    return jsonb_build_object('ok', false, 'code', 'EVENT_NOT_FOUND', 'message', 'This event does not exist.');
  end if;

  -- One vote at a time per event, so two quick taps can't both slip past the limits.
  perform pg_advisory_xact_lock(hashtext(e.id::text));

  if e.status <> 'open' or (e.ends_at is not null and now() > e.ends_at) then
    v_code := 'VOTING_CLOSED'; v_msg := 'Voting is closed.';
  elsif e.starts_at is not null and now() < e.starts_at then
    v_code := 'NOT_STARTED'; v_msg := 'Voting has not started yet.';
  elsif not exists (select 1 from public.contestants where id = p_contestant_id and event_id = e.id and active) then
    v_code := 'BAD_CONTESTANT'; v_msg := 'That contestant is not available.';
  elsif length(v_fp) < 16 or length(v_tok) < 16 or length(v_cross) < 16 then
    v_code := 'NO_DEVICE'; v_msg := 'Your browser could not be verified. Please enable JavaScript and storage, then reload.';
  elsif e.block_bots and coalesce((p_voter ->> 'webdriver')::boolean, false) then
    v_code := 'BOT'; v_msg := 'Automated browsers are not allowed to vote.';
  elsif e.require_name and length(v_norm) < 2 then
    v_code := 'NAME_REQUIRED'; v_msg := 'Please enter your name.';
  elsif e.ask_email and v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    v_code := 'EMAIL_REQUIRED'; v_msg := 'Please enter a valid email.';
  elsif e.ask_email and coalesce(trim(e.email_domains), '') <> '' and not exists (
          -- the exact domain, or a subdomain of it (students.school.edu for school.edu)
          select 1 from unnest(string_to_array(e.email_domains, ',')) d
           where trim(both ' @' from lower(d)) <> ''
             and (split_part(v_email, '@', 2) = trim(both ' @' from lower(d))
                  or split_part(v_email, '@', 2) like '%.' || trim(both ' @' from lower(d)))) then
    v_code := 'EMAIL_DOMAIN';
    v_msg := 'Only these email addresses are accepted: ' || (
      select string_agg('@' || trim(both ' @' from lower(d)), ', ')
        from unnest(string_to_array(e.email_domains, ',')) d where trim(both ' @' from d) <> '') || '.';
  elsif e.ask_phone and length(v_phone) < 7 then
    v_code := 'PHONE_REQUIRED'; v_msg := 'Please enter a valid phone number.';
  elsif coalesce(e.extra_field_label, '') <> '' and v_extra = '' then
    v_code := 'EXTRA_REQUIRED'; v_msg := 'Please fill in ' || e.extra_field_label || '.';
  end if;

  if v_code is null then
    if e.pricing = 'free' then
      v_qty := 1;
    elsif v_qty < 1 or v_qty > e.max_qty_per_vote then
      v_code := 'BAD_QUANTITY'; v_msg := 'Choose between 1 and ' || e.max_qty_per_vote || ' votes.';
    elsif e.require_payment_proof and coalesce(trim(p_payment_ref), '') = '' and coalesce(p_proof_path, '') = '' then
      v_code := 'PAYMENT_REQUIRED'; v_msg := 'Please enter your payment reference number or upload a receipt.';
    end if;
  end if;

  -- Criteria scores
  if v_code is null and e.voting_mode = 'criteria' then
    v_scores := '{}'::jsonb;
    for c in select id, name from public.criteria where event_id = e.id loop
      begin
        v_score := (p_scores ->> c.id::text)::numeric;
      exception when others then v_score := null;
      end;
      if v_score is null or v_score < 1 or v_score > e.score_max then
        v_code := 'BAD_SCORE'; v_msg := 'Please rate "' || c.name || '" from 1 to ' || e.score_max || '.';
        exit;
      end if;
      v_scores := v_scores || jsonb_build_object(c.id::text, round(v_score, 2));
    end loop;
  end if;

  -- Anti-cheat limits
  if v_code is null then
    v_ids := public._matching_voters(e, v_fp, v_tok, v_ip, v_norm, v_email, v_phone, v_cross);

    if exists (select 1 from public.voters where id = any (v_ids) and blocked) then
      v_code := 'BLOCKED'; v_msg := 'This device or voter has been blocked by the organizer.';
    else
      select coalesce(sum(quantity), 0), count(distinct contestant_id), max(created_at)
        into v_used, v_distinct, v_last
        from public.votes where voter_id = any (v_ids) and status <> 'rejected';

      if e.cooldown_seconds > 0 and v_last is not null and now() - v_last < make_interval(secs => e.cooldown_seconds) then
        v_code := 'TOO_FAST'; v_msg := 'Please wait a few seconds before voting again.';
      elsif e.max_votes_per_voter > 0 and v_used + v_qty > e.max_votes_per_voter then
        v_code := 'LIMIT_REACHED';
        v_msg := case when v_used >= e.max_votes_per_voter
                      then 'You have already used all your votes on this device.'
                      else 'You only have ' || (e.max_votes_per_voter - v_used) || ' vote(s) left.' end;
      elsif not e.allow_repeat_contestant and exists (
              select 1 from public.votes where voter_id = any (v_ids) and contestant_id = p_contestant_id and status <> 'rejected') then
        v_code := 'ALREADY_VOTED'; v_msg := 'You have already voted for this contestant.';
      elsif e.max_contestants_per_voter > 0 and v_distinct >= e.max_contestants_per_voter and not exists (
              select 1 from public.votes where voter_id = any (v_ids) and contestant_id = p_contestant_id and status <> 'rejected') then
        v_code := 'CONTESTANT_LIMIT';
        v_msg := 'You can only vote for ' || e.max_contestants_per_voter || ' contestant(s).';
      end if;
    end if;
  end if;

  if v_code is not null then
    insert into public.vote_attempts (event_id, contestant_id, code, name, fingerprint, device_token, ip, user_agent)
    values (e.id, p_contestant_id, v_code, nullif(v_name, ''), v_fp, v_tok, v_ip, v_ua);
    return jsonb_build_object('ok', false, 'code', v_code, 'message', v_msg);
  end if;

  -- Find this browser's voter row, or create it.
  select id into v_voter_id from public.voters
   where event_id = e.id and device_token = v_tok
   order by created_at limit 1;

  if v_voter_id is null then
    insert into public.voters (event_id, name, name_norm, email, phone, extra, fingerprint, cross_id, device_token, ip, user_agent, device_info)
    values (e.id, nullif(v_name, ''), nullif(v_norm, ''), nullif(v_email, ''), nullif(v_phone, ''), nullif(v_extra, ''),
            v_fp, nullif(v_cross, ''), v_tok, v_ip, v_ua, p_voter -> 'device_info')
    returning id into v_voter_id;
  else
    update public.voters set
      name = coalesce(nullif(v_name, ''), name), name_norm = coalesce(nullif(v_norm, ''), name_norm),
      email = coalesce(nullif(v_email, ''), email), phone = coalesce(nullif(v_phone, ''), phone),
      extra = coalesce(nullif(v_extra, ''), extra), ip = v_ip, fingerprint = v_fp,
      cross_id = coalesce(nullif(v_cross, ''), cross_id), last_seen_at = now()
    where id = v_voter_id;
  end if;

  v_status := case when e.pricing = 'paid' then 'pending' else 'approved' end;

  insert into public.votes (event_id, contestant_id, voter_id, quantity, status, amount, payment_ref, proof_path, scores, ip)
  values (e.id, p_contestant_id, v_voter_id, v_qty, v_status,
          case when e.pricing = 'paid' then v_qty * e.price_per_vote end,
          nullif(left(trim(coalesce(p_payment_ref, '')), 120), ''), nullif(p_proof_path, ''), v_scores, v_ip);

  return jsonb_build_object(
    'ok', true, 'code', 'OK', 'status', v_status,
    'remaining', case when e.max_votes_per_voter > 0 then e.max_votes_per_voter - v_used - v_qty end);
end;
$$;

-- ---------------------------------------------------------------------
-- Public: what has this device already done in this event?
-- ---------------------------------------------------------------------
create or replace function public.my_vote_status(p_event_id uuid, p_voter jsonb)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  e     public.events;
  v_ids uuid[];
  v_used int;
begin
  select * into e from public.events where id = p_event_id and status <> 'draft';
  if not found then return null; end if;

  v_ids := public._matching_voters(
    e,
    left(coalesce(p_voter ->> 'fingerprint', ''), 128),
    left(coalesce(p_voter ->> 'device_token', ''), 128),
    public._client_ip(),
    public._norm(p_voter ->> 'name'),
    left(lower(trim(coalesce(p_voter ->> 'email', ''))), 120),
    public._norm_phone(p_voter ->> 'phone'),
    left(coalesce(p_voter ->> 'cross_id', ''), 128));

  select coalesce(sum(quantity), 0) into v_used
    from public.votes where voter_id = any (v_ids) and status <> 'rejected';

  return jsonb_build_object(
    'used', v_used,
    'remaining', case when e.max_votes_per_voter > 0 then greatest(e.max_votes_per_voter - v_used, 0) end,
    'blocked', exists (select 1 from public.voters where id = any (v_ids) and blocked),
    'votes', coalesce((
      select jsonb_agg(jsonb_build_object('contestant_id', contestant_id, 'quantity', q, 'status', s))
      from (select contestant_id, sum(quantity) q,
                   case when bool_or(status = 'approved') then 'approved' else 'pending' end s
              from public.votes where voter_id = any (v_ids) and status <> 'rejected'
             group by contestant_id) t), '[]'::jsonb));
end;
$$;

-- ---------------------------------------------------------------------
-- Standings. Public only when the event shows live results.
--   votes   = approved vote count (quantity summed)
--   pending = unapproved paid votes
--   score   = criteria mode: weighted average, 0–100
-- ---------------------------------------------------------------------
create or replace function public.get_results(p_event_id uuid)
returns table (
  contestant_id uuid, number text, name text, photo_url text, sort_order int,
  votes bigint, pending bigint, voters bigint, score numeric, breakdown jsonb)
language plpgsql stable security definer set search_path = public as $$
declare
  e public.events;
  v_total numeric;
begin
  select * into e from public.events where id = p_event_id;
  if not found then return; end if;
  if not public.is_admin() and (e.status = 'draft' or not e.show_live_results) then return; end if;

  select nullif(sum(weight), 0) into v_total from public.criteria where event_id = e.id;

  return query
  with per_vote as (
    select v.id, v.contestant_id, v.voter_id, v.quantity, v.status,
           (select sum((s.value)::numeric * cr.weight)
              from jsonb_each_text(coalesce(v.scores, '{}'::jsonb)) s
              join public.criteria cr on cr.id::text = s.key and cr.event_id = e.id) / v_total
             / e.score_max * 100 as pct
      from public.votes v where v.event_id = e.id and v.status <> 'rejected'
  ),
  per_criterion as (
    select v.contestant_id, s.key as criterion_id,
           round(sum((s.value)::numeric * v.quantity) / nullif(sum(v.quantity), 0), 2) as avg
      from public.votes v, jsonb_each_text(coalesce(v.scores, '{}'::jsonb)) s
     where v.event_id = e.id and v.status = 'approved'
     group by v.contestant_id, s.key
  )
  select c.id, c.number, c.name, c.photo_url, c.sort_order,
         coalesce(sum(pv.quantity) filter (where pv.status = 'approved'), 0)::bigint,
         coalesce(sum(pv.quantity) filter (where pv.status = 'pending'), 0)::bigint,
         count(distinct pv.voter_id) filter (where pv.status = 'approved')::bigint,
         round(sum(pv.pct * pv.quantity) filter (where pv.status = 'approved')
               / nullif(sum(pv.quantity) filter (where pv.status = 'approved' and pv.pct is not null), 0), 2),
         (select jsonb_object_agg(pc.criterion_id, pc.avg) from per_criterion pc where pc.contestant_id = c.id)
    from public.contestants c
    left join per_vote pv on pv.contestant_id = c.id
   where c.event_id = e.id and c.active
   group by c.id
   order by c.sort_order, c.created_at;
end;
$$;

-- ---------------------------------------------------------------------
-- Admin: wipe all votes of an event (keeps contestants and settings).
-- ---------------------------------------------------------------------
create or replace function public.reset_event_votes(p_event_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'not authorized'; end if;
  delete from public.votes where event_id = p_event_id;
  delete from public.voters where event_id = p_event_id;
  delete from public.vote_attempts where event_id = p_event_id;
end;
$$;

-- Function permissions
revoke all on function public._matching_voters(public.events, text, text, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.cast_vote(uuid, uuid, jsonb, int, jsonb, text, text) to anon, authenticated;
grant execute on function public.my_vote_status(uuid, jsonb) to anon, authenticated;
grant execute on function public.get_results(uuid) to anon, authenticated;
grant execute on function public.claim_admin() to authenticated;
grant execute on function public.reset_event_votes(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- Storage
--   assets : logos, banners, contestant photos, payment QR (public)
--   proofs : payment receipts uploaded by voters (admin-only read)
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('assets', 'assets', true, 5242880, array['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/svg+xml'])
on conflict (id) do update set public = excluded.public, file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('proofs', 'proofs', false, 3145728, array['image/png', 'image/jpeg', 'image/webp'])
on conflict (id) do update set public = excluded.public, file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "assets admin write" on storage.objects;
create policy "assets admin write" on storage.objects for all to authenticated
  using (bucket_id = 'assets' and public.is_admin())
  with check (bucket_id = 'assets' and public.is_admin());

drop policy if exists "proofs public upload" on storage.objects;
create policy "proofs public upload" on storage.objects for insert to anon, authenticated
  with check (bucket_id = 'proofs');

drop policy if exists "proofs admin read" on storage.objects;
create policy "proofs admin read" on storage.objects for select to authenticated
  using (bucket_id = 'proofs' and public.is_admin());

drop policy if exists "proofs admin delete" on storage.objects;
create policy "proofs admin delete" on storage.objects for delete to authenticated
  using (bucket_id = 'proofs' and public.is_admin());

-- ---------------------------------------------------------------------
-- Admin login helpers (password-only sign-in + remembered devices)
-- ---------------------------------------------------------------------
create or replace function public.admin_exists()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.admins);
$$;
grant execute on function public.admin_exists() to anon, authenticated;

create table if not exists public.admin_devices (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users (id) on delete cascade,
  device_token text not null,
  fingerprint  text,
  device_info  jsonb,
  ip           text,
  first_seen   timestamptz not null default now(),
  last_seen    timestamptz not null default now(),
  unique (user_id, device_token)
);
alter table public.admin_devices enable row level security;
drop policy if exists admin_devices_admin on public.admin_devices;
create policy admin_devices_admin on public.admin_devices for all using (public.is_admin()) with check (public.is_admin());

-- Records the device the admin is signed in on.
create or replace function public.touch_admin_device(p_device jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then return; end if;
  insert into public.admin_devices (user_id, device_token, fingerprint, device_info, ip)
  values (auth.uid(), left(p_device ->> 'device_token', 128), left(p_device ->> 'fingerprint', 128),
          p_device -> 'device_info', public._client_ip())
  on conflict (user_id, device_token) do update
    set last_seen = now(), ip = excluded.ip, fingerprint = excluded.fingerprint, device_info = excluded.device_info;
end;
$$;
grant execute on function public.touch_admin_device(jsonb) to authenticated;
