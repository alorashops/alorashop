# AloraShop — Supabase backend

Two migration files in `migrations/`. Apply both in the Supabase SQL editor
(Dashboard → SQL Editor → New query → paste → Run), in order:

1. `20250101000000_add_staff_with_password.sql` — replaces the old "invite
   link" version of `add_staff` with one that takes a temporary password and
   creates a **confirmed** account (no email, no link, no expiry).
2. `20250101000001_reset_staff_password.sql` — adds `reset_staff_password`,
   the admin-only, email-free password reset used from Settings → Staff.

## One dashboard toggle you MUST set

Authentication → Sign In / Up → Email → **Confirm email: OFF**.

With it ON, new owner sign-ups are held until an email link is clicked — the
exact flow this app deliberately removed. Leave it OFF so accounts are active
the moment they're created. (If you forget, the login screen shows a clear
hint pointing here.)

## After applying

- Adding a staff member from Settings now requires a **temporary password**
  (min 6 chars) instead of sending an invite email.
- Any admin can reset any staff password from Settings → Staff → Reset password.
- Staff sign in with email + password exactly like the shop owner.