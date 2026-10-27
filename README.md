# Vote: a free voting web app for talent shows and events

Two pages:

| Page | Who | What it does |
|---|---|---|
| `index.html?e=<event>` (or just your site's address for the event whose link name is blank) | Audience | See the logo, rules and judging criteria, then vote. Works on phones. |
| `admin.html` | You | Manage everything: branding, contestants, criteria, voting rules, anti-cheat, payments, voters and screenshots. |

It costs **₱0 / $0** to run. Static files are hosted on GitHub Pages (or Netlify/Vercel/Cloudflare Pages), and
the database, admin login and image storage run on the **Supabase free tier**. There is no build step and no server to maintain.

---

## Features

**Admin**
- **Password-only sign-in**: devices you've signed in on stay signed in. There is a devices list, "sign out other devices" and password change.
- **Event & branding**: title, subtitle, description, logo, banner, theme color, open/close times, multiple events, share link + QR code.
- **Contestants**: add, edit, reorder, hide and delete, with photo upload. Optionally add a **video** (plays in a pop-up player when voters tap the photo; videos over 50 MB are compressed in the browser to under 45 MB) or a **link** (opens in a new tab). Images are compressed in the browser to save free storage.
- **Criteria**: name, percentage (weight) and description. Shows a warning when the total isn't 100%.
- **Voting rules**
  - *Voting style*: "Pick a contestant" (criteria shown as a guide), or "Rate each criterion" (1–N sliders, weighted score).
  - *Pricing*: free, or paid per vote. Voters pay you directly (GCash/Maya/bank QR), enter a reference no. and/or upload a receipt, and you approve it.
  - *Free + paid*: everyone gets their free votes first. A voter who uses them all sees a "Buy more votes" notice, picks how many votes to buy, pays by scanning your QR code and sends the reference no. and/or receipt. When you approve it in **Payments**, the votes are added to the same device and browser that bought them (and any browser the anti-cheat treats as the same person), within about 10 seconds and without a reload. Bought votes can go to any contestant, including one already voted for.
  - *Limits*: total votes per person, how many different contestants, and whether repeat votes for the same contestant are allowed. One-click presets are included.
  - *Voter details*: name, email, mobile, and a custom field (e.g. Student ID). Email can be limited to specific domains (e.g. only `@ces.edu.ph`).
- **Anti-cheat** (see below), plus a log of every blocked attempt.
- **Live updates**: changes saved in the admin (title, banner, contestants, criteria, rules, opening/closing voting) appear on open voting pages within a second, with no reload. Uses Supabase Realtime; if its connection limit is reached (200 on the free plan), pages check for changes every 30 seconds instead.
- **Payments**: view receipts, approve or reject individually, approve all, see totals.
- **Votes & voters**: every voter with device, OS, model, IP and fingerprint. Shared-name and incognito voters are flagged. Block or unblock voters, delete votes, export CSV, reset.
- **Screenshot tab**: a styled standings board (podium + list) that you capture as a PNG or copy to the clipboard. You can show names and photos, **numbers only**, or go **fully anonymous** (Contestant A, B, C…). It also has Top 3/5/10, a dark or light style, a custom title and footer note, and an admin-only detailed table with per-criterion averages.

**Audience**
- Mobile-first page with your branding, rules and criteria.
- Shows how many votes they have left and which contestants they already voted for.
- Optional live standings, with or without vote counts.

## Anti-cheat: how it works

All rules are enforced **in the database** (`cast_vote` function), so they cannot be bypassed by editing the web page.
Every vote is checked against previous votes, and a voter counts as "the same person" when any enabled check matches:

| Check | Catches | Notes |
|---|---|---|
| Browser token (always on) | Same browser voting again | Saved in localStorage, a cookie and IndexedDB. Clearing one store restores it from the others. |
| Same email / mobile | One person, many devices | |
| Same name | Lazy duplicates | Normalized, e.g. "Juan Dela Cruz" = "juan delacruz". |
| Block private windows | Incognito, which wipes the browser token | Off by default. A best guess, mainly in Chrome. |
| Desktop / laptop only | Voting from several phones | Off by default. Phones and tablets (including iPads) see a "Voting unavailable on this device" anti-cheat screen, and the database rejects their votes. |
| Bot blocking | Automated / headless browsers | |
| Cooldown | Spam clicking | |
| Admin block | Anyone you flag | |

Honest limits: no free web app can make cheating *impossible*. Someone with several phones can vote from each phone.
Voters are recognised by their browser only. Device fingerprints and internet addresses are not used: identical
phones, and identical office or school laptops on one Wi-Fi, look the same, so those checks blocked real people.
That means a private window or a second browser can vote again (turn on "Block private / incognito windows" to stop
the first). The admin **Votes & voters** tab flags shared names and private windows, so you can review and block. For high-stakes votes,
turn on email or mobile, or use paid votes with receipt approval.

---

## Setup (about 10 minutes, all free)

### 1. Create the Supabase project
1. Sign up at <https://supabase.com> (free) → **New project**.
2. Open **SQL Editor** → **New query**, paste the whole of [`supabase/schema.sql`](supabase/schema.sql) and click **Run**.
   This creates the tables, security rules, voting functions and the two storage buckets.
   Re-running it later (after updates) is safe.
3. **Authentication → Sign In / Providers → Email**: turn **off** "Confirm email" (or keep it on and confirm the email you sign up with).

### 2. Connect the app
Open **Project Settings → API** and copy the **Project URL** and the **anon public** key into
[`assets/js/config.js`](assets/js/config.js):

```js
export const SUPABASE_URL = 'https://abcdxyz.supabase.co';
export const SUPABASE_ANON_KEY = 'eyJhbGciOi...';
```

The anon key is designed to be public; the database security rules protect your data.

### 3. Publish the site (pick one)
- **GitHub Pages**: repo **Settings → Pages → Deploy from a branch** → choose your branch and `/ (root)`.
  Your site is then at `https://<user>.github.io/<repo>/`.
- **Netlify / Vercel / Cloudflare Pages**: import the repo. There is no build command, and the output directory is the root.
- To test locally, run `npx serve .` and open <http://localhost:3000>.

### 4. Set the admin password
1. Open `admin.html`. The first time, it asks you to **choose the admin password** (e.g. `CESADMIN`). Type it twice and you're in.
2. Back in Supabase: **Authentication → Sign In / Providers → turn off "Allow new users to sign up"** so nobody else can create accounts.

After that, the admin page asks **only for the password**, with no email or username.
Each phone, PC or local dev browser that has signed in once **stays signed in automatically** and opens straight to the dashboard.
It only asks again if that browser's data is cleared or you sign the device out.

Click **🔐 Devices & password** in the sidebar to:
- see every device that is signed in as admin (type, OS, model, IP, last used);
- **sign out all other devices**, for example if you used a borrowed phone;
- change the password.

Behind the scenes the password belongs to an internal account named by `ADMIN_EMAIL` in `config.js`.
It doesn't need to be a real inbox, which is why "Confirm email" must be off in step 1.

### 5. Run your event
1. **Event & branding**: set the title and logo, then set the status to **Open**.
2. Add **Contestants** and **Criteria**, and choose the **Voting rules**.
3. Share the link or QR code from the Event tab (put it on the screen or on posters).
4. Watch **Votes & voters** and approve **Payments**. Use **Screenshot** to post standings.

## Free-tier notes
- Supabase free: 500 MB database, 1 GB file storage, 5 GB egress per month. That is plenty for many events with thousands of votes.
  Images are shrunk before upload to stay well within the limits.
- Free Supabase projects **pause after 7 days without activity**. Open the dashboard and click *Restore* (it's free).
  Visit the admin page a day before your event to be safe.
- Payments go directly from voters to *your* GCash, bank or other account, so there are no payment gateway fees. The trade-off is that you approve receipts manually.

## Files
```
index.html            audience voting page
admin.html            admin dashboard
assets/css/app.css    styles (light/dark automatically)
assets/js/config.js   your Supabase URL + anon key
assets/js/lib.js      Supabase client, UI helpers, image upload
assets/js/device.js   device token + fingerprint + device info
assets/js/vote.js     voting page logic
assets/js/admin.js    admin dashboard logic
assets/js/standings.js ranking + standings rendering
supabase/schema.sql   database, security rules, voting functions, storage
```
