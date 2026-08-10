# Multi-factor authentication for Deal Radar sign-in

MFA is **required for every account** that signs in to Deal Radar through
Microsoft. There is no exemption list, no per-user opt-out, and no
environment variable that turns it off.

Enforcing that takes two halves, and **both are required**:

| Half | Where it lives | What it does |
| --- | --- | --- |
| Conditional Access policy | Entra admin centre | Makes Microsoft actually *ask* for a second factor |
| `amr` claim verification | `server/lib/microsoftAuth.ts` step 12 | Makes Deal Radar *refuse* a sign-in that did not have one |

The application half is already written and tested. **The Entra half is
not, and cannot be done from this repository** — it needs a Microsoft
administrator in the Vamos tenant.

Why both: a Conditional Access policy can be scoped to exclude a group,
switched to report-only, or disabled in the portal without anyone
touching this repository. If the app simply trusted that a policy was in
force, any of those changes would silently become a way in. The app
checks the token instead of trusting the configuration.

---

## Why the app can tell

An Entra `id_token` carries an `amr` claim — Authentication Methods
References — listing the factors Microsoft actually verified *for that
sign-in*, as opposed to the ones the account is merely capable of.

Deal Radar accepts only two values as proof of multi-factor:

- **`mfa`** — Entra emits this whenever a multi-factor requirement was
  satisfied, including passwordless sign-ins (`["face", "mfa"]`,
  `["fido", "mfa"]`).
- **`ngcmfa`** — a "next generation credential" (Windows Hello for
  Business, passkey provisioning) satisfied it.

Everything else is refused, including `otp`, `sms`, `rsa`, `phh` and
`wiaormfa`. Each of those describes a **single** factor, or is
ambiguous by definition — a tenant can be configured to accept a texted
code as a first and only factor, so `["sms"]` does not establish that two
factors were checked.

**A token with no `amr` claim at all is refused.** That case does not
mean "no MFA happened" — it means the app registration is not releasing
the claim and the server cannot tell either way. It fails closed.

---

## Step 1 — Release the `amr` claim (do this FIRST)

This app uses the Entra **v2.0** endpoint, and v2.0 `id_token`s do **not**
include `amr` by default. It has to be added as an optional claim.

> **Order matters.** Do this step *before* Step 2 and before the SSO
> cutover. If MFA is enforced while the claim is still absent, every
> sign-in is refused — see [Lockout risk](#lockout-risk) below.

1. Entra admin centre → **App registrations** → the Deal Radar app.
2. **Token configuration** → **Add optional claim**.
3. Token type: **ID**.
4. Tick **`amr`** → **Add**.

Manifest equivalent, if the registration is managed as JSON:

```json
"optionalClaims": {
  "idToken": [
    { "name": "amr", "source": null, "essential": false, "additionalProperties": [] }
  ]
}
```

## Step 2 — Require MFA with Conditional Access

1. Entra admin centre → **Protection** → **Conditional Access** →
   **New policy**. Name it something like
   `Deal Radar — require MFA`.
2. **Users**: the group that should have Deal Radar access.
   Exclude at least one break-glass administrator account — this is
   standard practice for *any* Conditional Access policy, and it protects
   the tenant, not Deal Radar. A break-glass account excluded here still
   cannot sign in to Deal Radar, because the application's own check runs
   regardless.
3. **Target resources**: the Deal Radar app registration specifically.
   Not "All cloud apps" — that changes sign-in for every Microsoft
   service in the tenant and is well beyond what this app needs.
4. **Grant**: *Grant access* → **Require multifactor authentication**.
5. Create it in **Report-only** first, confirm the sign-in logs show it
   would apply to the right people, then switch to **On**.

## Step 3 — Verify before cutover

With `AUTH_MODE=hybrid` (so the shared password still works as a way
back in if something is wrong):

1. Sign in through Microsoft as a normal user. It should succeed and
   prompt for a second factor.
2. In Entra → **Sign-in logs** → that sign-in → **Authentication
   Details**, confirm multi-factor was satisfied.
3. In Deal Radar → **Settings** → the audit log, confirm the entry reads
   `sso-login … ok`.

If sign-in is refused with *"Deal Radar requires multi-factor
authentication…"* while Entra's own logs show MFA succeeded, then Step 1
did not take effect — the policy is working but the claim is not being
released. Re-check the optional claim, then have the person sign out of
Microsoft completely and sign in again so a fresh token is minted.

Only once this passes should `AUTH_MODE` move to `microsoft`.

---

## Lockout risk

**This is the failure mode to plan for.** MFA is required with no
override, so if Entra stops releasing `amr` — the optional claim is
removed, the app registration is replaced, a new registration is stood up
without Step 1 — then **every SSO sign-in fails**, for everyone.

If `AUTH_MODE` is `microsoft` at that point, the shared password is also
refused ([server/routes/auth.ts:148](../server/routes/auth.ts#L148)) and
nobody can get in at all.

The way back in, in order of preference:

1. Re-add the `amr` optional claim (Step 1). This is almost always the
   real fix.
2. Set `AUTH_MODE=hybrid` in the environment and restart. The shared
   `ADMIN_PASSWORD` starts working again immediately — this is the
   reversibility the `AUTH_MODE` design already exists to provide, and it
   needs no code change and no redeploy of application code.

Note that option 2 restores access *without* MFA, so treat it as a
break-glass measure and go fix option 1.

---

## What is deliberately *not* covered

The **shared administrator password** path
([server/routes/auth.ts:138](../server/routes/auth.ts#L138)) has no MFA
and gets none from this work. It is one credential shared by the whole
team rather than a set of user accounts, so there is no per-person
identity to attach a second factor to — adding TOTP would mean one shared
authenticator seed, which is not meaningfully a second factor.

That path remains the known weakness recorded in
[TECHNICAL_HANDOFF.md](../TECHNICAL_HANDOFF.md) §1. The intended fix is
the SSO cutover itself: once `AUTH_MODE=microsoft`, the password stops
working entirely and MFA covers every way into the application.
