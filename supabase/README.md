# AloraShop — Supabase backend

Everything the app needs on the server: **26 versioned SQL migrations** plus one
**Edge Function** (`verify-payment`). None of it is optional — the SQL files carry
the RLS policies, the SECURITY DEFINER hardening and the payment guards.

> **Earlier revisions of this README said "two migration files". That was wrong.**
> Following it left migrations 02–17 unapplied, i.e. no self-promotion fix, no
> cashier cost gating, no audit trail, no payment guards. Apply ALL of them.

> **There is deliberately no `schema.json` here.** The authoritative schema is the
> live database: the owner pulls the REAL cloud schema from Supabase. A
> hand-written copy would drift and be worse than none — do not add one.

## 1. Apply the migrations

Apply **every** file in `migrations/` in ascending filename order (SQL Editor →
New query → paste → Run, one at a time):

| # | Migration | What it fixes |
| - | --------- | ------------- |
| 00 | `add_staff_with_password` | staff accounts with an admin-chosen password (no invite email) |
| 01 | `reset_staff_password` | admin-only, email-free password reset |
| 02 | `lock_profile_self_update` | **Critical:** users could self-promote `role` / move `shop_id` |
| 03 | `gate_product_costing_by_role` | **Critical:** cashiers could read/write cost + margin |
| 04 | `harden_definer_functions` | pin `search_path` on `add_staff` / `reset_staff_password` |
| 05 | `harden_unversioned_functions` | version + harden the six legacy functions |
| 06 | `restore_auth_in_search_path` | **hotfix for 05** — restore `auth` or login breaks |
| 07 | `add_audit_log_table` | append-only audit trail (3 triggers) |
| 08 | `sales_typed_columns` | typed columns + CHECKs on `sales` (P6a) |
| 09 | `sales_updated_at_sanity_bound` | bound `updated_at` for clock sanity (P6b) |
| 10 | `sales_receipt_unique` | unique receipt number per shop (P6c) |
| 11 | `sales_receipt_auto_disambiguate` | offline receipt collisions auto-resolved (P6c) |
| 12 | `sales_secure_views` | stop cashiers reading profit on the pull path (P6d) |
| 13 | `exclude_pending_from_revenue` | unverified Paystack must not count as revenue (P6e) |
| 14 | `guard_card_paid_requires_server` | CARD/PAYSTACK only becomes PAID server-side (P9) |
| 15 | `sales_paystack_reference_unique` | one Paystack reference funds one sale (P9) |
| 16 | `staff_rpc_reauth` | staff RPCs require the caller's OWN password (P10b) |
| 17 | `audit_log_revoke_client_writes` | close the `audit_log` grant drift (P5) |
| 18 | `revoke_anon_table_privileges` | **close the pre-auth surface** — `anon` held the full privilege set on every `public` table (P12c-2) |
| 19 | `fix_sales_receipt_collision_trigger` | **stop the sale re-push from aborting**: the trigger's audit write needed a grant it lost, and its collision loop matched the row's own row (P13) |
| 20 | `restore_sales_receipt_uniqueness` | **restore the receipt safety net** — migration 10 aborted on a pre-existing duplicate, so its unique index never existed; resolve the duplicate then `CREATE UNIQUE INDEX IF NOT EXISTS` (P14) |
| 21 | `repair_p13b_self_renamed_receipts` | repair the 6 receipts the pre-P13 trigger renamed to themselves (`…-000N-2` → `…-000N`) (P13b) |
| 22 | `anon_lockdown_complete` | **close the anon surface on VIEWS + sequences** and make the default-privilege revoke durable for tables/sequences/functions (P12c-2 completion + F3) |
| 23 | `p12c3_owner_write_rpcs` | **owner write RPCs** — `upsert_sales(jsonb)` / `upsert_daily_summaries(jsonb)`, `SECURITY DEFINER` with a pinned `search_path` + a fail-loud tenant gate; lets the client write `sales`/`daily_summaries` without raw table `SELECT` (P12c-3 phase 1; additive) |
| 24 | `p12c3_revoke_raw_select` | **close the cashier-margin leak** — rebuild `sales_secure` / `daily_summaries_secure` as `SECURITY DEFINER` with an explicit `shop_id = current_shop_id()` predicate, then `REVOKE SELECT` on the raw `sales` / `daily_summaries` from `authenticated` (P12c-3 phase 2) |
| 25 | `p10a_password_policy` | **raise the staff password policy** — `add_staff` / `reset_staff_password` now require ≥ 8 chars with a letter, a number and a symbol (P10a; signatures and the P10b re-auth logic unchanged). Existing credentials keep working |

### Two traps that already bit us

1. **Never re-run 05 by itself.** It removed `auth` from the search_path of the
   legacy functions and broke login (401 on login, 403 on data). 06 is the fix.
   If you ever replay 05, replay 06 immediately after.
2. **Migration 16 changes an RPC signature.** Apply it and deploy the matching
   client **together** — an old client hits a dropped function, a new client hits
   a missing one.

### Known residual — accepted 2026-09-26 (needs a superuser)

Migration 22 revokes `anon` on every existing relation/sequence **and** makes the
default privileges of the CURRENT role (`postgres`) anon-free for future
tables/sequences/functions. It **cannot** change `supabase_admin`'s defaults —
that requires membership/superuser, which `postgres` does not have on live. Live
`pg_default_acl` therefore still lists `anon=…` for `supabase_admin` (r/S/f).
**Consequence (durability only, no current exposure):** an object created BY
`supabase_admin` (e.g. via the Dashboard Table Editor) can still inherit an
`anon` grant. Every existing object is clean (verified). To close it, run as a
superuser:

```sql
alter default privileges for role supabase_admin in schema public revoke all on tables    from anon;
alter default privileges for role supabase_admin in schema public revoke all on sequences from anon;
alter default privileges for role supabase_admin in schema public revoke all on functions from anon;
```

Re-check with `scripts/verify_p12c_lockdown_complete_applied.sql` — Section 3
must then be 0 rows.

> **The one invariant:** never `CREATE OR REPLACE` or `ALTER … SET search_path` a
> function whose body is not in this repo (`create_shop`, `update_shop_name`,
> `current_shop_id`, `current_user_role`, `handle_new_user`, `set_updated_at`).
> They exist only in the live DB; pull the body first. Breaking this caused the
> earlier login/data outages.

## 2. Deploy the Edge Function

```bash
supabase functions deploy verify-payment --no-verify-jwt
```

Set its secret `PAYSTACK_SECRET_KEY` (Dashboard → Edge Functions →
verify-payment → Secrets). Without it a card sale can never leave
`PENDING_VERIFICATION` — the POS card path fails closed. Then register
`https://<project-ref>.functions.supabase.co/verify-payment` as the Paystack
`charge.success` webhook. Details: `functions/verify-payment/README.md`.

## 3. Dashboard settings

- **Authentication → Sign In / Up → Email → Confirm email: OFF.** With it ON,
  new owner sign-ups are held for an email click — the flow this app removed.
  (The login screen hints at this if you forget.)
- **Recommended:** enable **leaked-password protection** (Auth → Passwords).
- **Verify by hand:** RLS enabled on every domain table; no `anon` privilege on
  any relation or sequence in `public` (migration 18/22); no `anon` EXECUTE on
  the RPCs; `audit_log` readable by manager/admin only.

## 4. Client environment

`VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` (Project Settings → API).
Card payments additionally need `VITE_PAYSTACK_PUBLIC_KEY` and, optionally,
`VITE_PAYSTACK_BUSINESS_EMAIL`.

## 5. Verify the live database

Each migration documents its own post-apply checks (look for the numbered
verification blocks). The repo also ships executable checks:

| Command | Expected |
| ------- | -------- |
| `node scripts/verify_p11_secure_uid.mjs` | 35/35 |
| `node scripts/verify_p7_receipt_dom.mjs` | 23/23 |
| `node scripts/verify_p8_headers.mjs` | 25/25 |
| `node scripts/verify_p9_decide.ts` | 14/14 |
| `node scripts/verify_p9_guard_migration.mjs` | 11/11 |
| `node scripts/verify_p9_reference_unique.mjs` | 8/8 |
| `node scripts/verify_p13_receipt_trigger_fix.mjs` | 14/14 |
| `node scripts/verify_p14_receipt_uniqueness.mjs` | 24/24 |
| `node scripts/verify_p13b_self_rename_repair.mjs` | 21/21 |
| `node scripts/verify_p12c2b_anon_lockdown_complete.mjs` | 18/18 |
| `node scripts/verify_p12c3_privilege_matrix.mjs` | 14/14 |
| `node scripts/verify_p12c3_write_rpc.mjs` | 30/30 |
| `node scripts/verify_p12c3_client_wiring.mjs` | 11/11 |
| `node scripts/verify_p12c3_revoke_raw_select.mjs` | 21/21 |
| `node scripts/verify_p10b_reauth_migration.mjs` | 22/22 |
| `node scripts/verify_p10a_password_policy.mjs` | 28/28 |
| `scripts/verify_p10c_live_reconcile.sql` (SQL editor) | all checks true |
| `scripts/verify_p14_applied.sql` (SQL editor) | Sections 1 & 2 = 0 rows |
| `scripts/verify_p13b_applied.sql` (SQL editor) | Sections 1–4 = 0 rows |
| `scripts/verify_p12c_lockdown_complete_applied.sql` (SQL editor) | Sections 1 & 2 = 0 rows; Section 3 = 0 rows or the documented `supabase_admin` residual |
| `scripts/verify_p12c3_applied.sql` (SQL editor) | Section 1 = 0 rows; Section 2 = 2 rows |
| `scripts/verify_p12c3_phase2_applied.sql` (SQL editor) | Section 1 = 0 rows |

## 6. What changes for staff once deployed

- Adding a staff member from Settings needs a **temporary password** (min 8
  chars, with a letter, a number and a symbol — P10a) instead of an invite email.
- Any admin can reset any staff password from Settings → Staff, and since
  migration 16 must re-enter **their own** password to do it.
- Staff sign in with email + password exactly like the shop owner.