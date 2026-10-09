# Wasla WhatsApp gateway — safe Nexus VPS migration

> This is an operational plan, not authorization to change live WhatsApp sessions. Never publish secrets, session files, production QR codes, snapshots or customer data.

## Architecture and constraints

The gateway is a single-instance Node 22 / Baileys application behind a reverse proxy. Its Docker port is bound to 127.0.0.1:3000. Baileys auth state persists in host directory /opt/wasla-whatsapp/auth_sessions mounted into /app/auth_sessions. Never run both old and new copies using the same account or credentials.

The gateway still stores company session statuses, message logs and outbox updates in the Wasla Supabase project through sessionStore.js. Moving its container to the Nexus VPS does NOT move these data tables. Retain the Supabase integration as a transitional step until an independently verified backend cutover. WhatsApp runs as a dedicated service next to, rather than inside, TEMM Nexus. OpenCode coding agents stay on the developer workstation and do not run on the VPS.

## Gate A — inspect the real source, without secrets

- Confirm VM / Docker health, actual image digest, deployment code revision, restart policy and listening ports.
- Inspect bind mounts and session directory file counts (never list filenames or contents from session directories publicly).
- Query local authenticated /diag only from within the production container. Log sanitized counts of connected, connecting and disconnected sessions, not phone numbers or QR data.
- Inspect recent errors as aggregate categories, not raw logs. API /health reporting healthy does not prove the WhatsApp sessions are connected.
- Verify presence of environment keys, selected Supabase project reference, volume ownership, disk capacity, proxy and caller integration. Do not display any secret values.

**Stop gate:** when zero sessions are connected, determine whether pairing is pending, credentials have been lost or reconnect retries are stuck. Do not assume a migration will fix pairing.

## Gate B — preserve a restorable source

- Create restricted source VM/data-disk backup and encrypted off-host config backup, with a retention rule and private inventory. Confirm available cloud credit/budget before paid snapshots.
- Rehearse restoring to a disposable, network-isolated target where Baileys cannot connect to WhatsApp.
- Take a final consistent, encrypted copy of auth_sessions only after graceful old service shutdown during the agreed cutover window; online snapshots alone are not proof of consistency.
- Preserve original .env, API keys and encryption credentials in a suitable secret store (never Git, chat, stdout or CI artifacts).
- Measure pending notification_outbox work; stop ingress and drain sending safely to prevent duplicate delivery.

## Gate C — prepare Nexus destination without starting a second socket

- Confirm the exact accepted TEMM Nexus v0.6.3 deploy/commit and sufficient CPU, RAM and persistent storage on its VPS. Do not reuse a busy test stack for production without separate isolation and backup validation.
- Build and verify the gateway image from a pinned commit, but do not start production Baileys sessions yet.
- Configure a dedicated non-root Docker service, internal-only port and TLS proxy; persistent volume with matching ownership, one replica and a graceful termination window.
- Add secrets privately. Preserve Supabase URL and service-role functionality for the temporary bridge.
- Test container configuration with no live session data and no outbound WhatsApp socket.

## Gate D — human-approved production cutover

1. Record sanitized source baseline, verified restore artifacts, image digest and allowed downtime window.
2. Pause caller traffic and gateway-related queue workers; drain and checkpoint in-flight sends.
3. Gracefully STOP the old gateway and verify no old Baileys socket remains.
4. Copy encrypted session backup over a private authenticated channel, verify checksum, and restore strict permissions on the destination.
5. ONLY THEN start the new gateway once. Check /health, authenticated /diag, actual session states, Supabase writes, auth failures and tenant isolation.
6. Complete any required pairing on an operator-controlled UI. Never paste QR/session material into public logs.
7. Switch caller routing to the new proxy; send a small opt-in test; verify deduplication, outbox and webhook behavior.
8. Monitor. Keep old VM stopped but available for rollback until explicit final acceptance.

## Rollback

Stop the NEW gateway before restarting the OLD gateway, revert caller routing and reconcile outbox state before retrying messages. Keep original data and backups. Never start both gateways simultaneously, never remove volumes or format disks as part of cutover.

## Evidence checklist

- [ ] Authorized source inventory and exact deployed source revision
- [ ] Actual WhatsApp session connectivity investigated (not API health alone)
- [ ] Offline tested and restorable backup of app configuration and session data
- [ ] Valid Nexus 0.6.3 production destination with isolated gateway service
- [ ] Continuity of Supabase session/message/outbox database
- [ ] Single-instance stopped-source / started-target handoff
- [ ] Tenant-scoped authorization, QR/device, deduplication and opt-in message verified
- [ ] Rollback demonstrated and monitoring period accepted

Baileys is unofficial WhatsApp Web automation; for long-term production scale evaluate the official WhatsApp Business Platform.
