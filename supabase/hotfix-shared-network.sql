-- Emergency switch: turns OFF the device and network anti-cheat checks
-- (same IP, max voters per connection, same computer / other browser, device
-- fingerprint) for EVERY event, if people are being shown "already voted"
-- by mistake. Normally you turn these on or off per event in the admin:
-- Voting rules -> Anti-cheat. They are off by default.
-- Paste into Supabase -> SQL Editor -> New query, then click Run.
-- Safe to run more than once. No votes are changed. It does not change the
-- matching rules, so you can turn the checks back on in the admin later.

-- 1. Switch off every rule that matched voters by network or device traits.
update public.events set limit_by_ip = false, max_voters_per_network = 0, limit_by_cross_browser = false, limit_by_fingerprint = false;

-- 2. Show the result: limit_by_ip false, max_voters_per_network 0,
--    limit_by_cross_browser false, limit_by_fingerprint false.
select slug, limit_by_ip, max_voters_per_network, limit_by_cross_browser, limit_by_fingerprint from public.events;
