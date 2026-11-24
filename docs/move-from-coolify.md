# Move from Coolify (to a new server)

Copy your Coolify apps, databases, services and domains onto a Tugra server, check them there, then switch the domains over. Coolify keeps running the whole time, so you can go back until the switch.

Moving onto the **same server** Coolify runs on? That is a different procedure: see [Move from Coolify on the same server](move-from-coolify-same-server.md).

> **Be honest with yourself about risk.** The pieces are covered by automated tests and a lab, but no real fleet has been moved end to end by the guided run yet. Do a dry run first, then a real run on something non-critical, before the apps that matter. See the [verification status](runbooks/guided-migration.md#verification-status-read-this-first).

## Before you start

1. **A Tugra server for the apps.** A new, online server in Tugra: see [Add a server](add-a-server.md). It needs enough disk for your data (a database copy can need about twice its size while it runs).
2. **A Coolify API token.** In Coolify open **Keys & Tokens, API tokens** and create one:
   - as a team **admin or owner**, for the **whole team** (not limited to some projects),
   - with **read** and **read:sensitive**. Without `read:sensitive`, Coolify hides build commands, labels, Dockerfile text and variable values, so they cannot move,
   - plus **deploy** only if you want Tugra to stop and restart the source through the API.
3. **The Coolify API switched on.** In Coolify open **Settings, Advanced** and turn on the API. If **Allowed IPs** is set, add your Tugra hub's address or clear the list (Tugra shows the address when Coolify refuses).
4. **A supported Coolify.** Version 4.1.2 or newer, tested up to 4.7.5.
5. **For HTTPS on the new server:** a real contact email for Let's Encrypt, and either a Cloudflare credential in Tugra or willingness to edit DNS by hand.
6. **The Coolify host can reach your hub** over HTTPS. Database and volume data is pulled by a small helper that runs on the Coolify host.
7. **The Coolify host runs on a server you control** and you have a shell on it for the data steps.

## Steps

1. Open **Import** in Tugra and choose **Coolify**.
2. Enter the Coolify address and paste the token. Tugra checks it and shows one line, for example `✓ Acme Team, 19 apps, 10 databases · read:sensitive`. If it says **no read:sensitive**, create a new token.
3. Press **Connect & preview**. Choose what moves: everything, or only the apps on one source server.
4. Read the **preview**. Blockers must be fixed or acknowledged; notes are things Tugra cannot carry over. Open **Review & rename** to change names, projects and environments.
5. Choose the **target server**.
6. Press **Run guided migration**. Leave **Dry run first** ticked and create the run. It walks through every step, writes nothing, and lists what would block you. Fix those and repeat until it is clean.
7. Start the real run from the finished dry run. The run then asks for you at a few points:
   - **Data copy:** it prints one command per source host. Paste it on the Coolify host. The first pass copies while Coolify still serves traffic.
   - **Freeze:** you approve the list of containers to stop. This opens the downtime window. The final data copy runs next.
   - **Dark deploy:** apps start on Tugra without public traffic. Apps with no domain (workers) stay stopped until after the switch.
   - **Certificates and checks:** Tugra gets HTTPS certificates ahead of the switch and tests every app on a temporary address.
   - **Approve the switch:** you read the verification report, type the target server name and approve. This is the point of no return.
   - **Cutover:** Tugra changes DNS (Cloudflare) or shows you the records to change. It then watches the apps for a while and writes a report.
8. Check your sites on the new server. Keep Coolify running for a few days. Remove the push webhooks at the source by hand when you are happy.

Prefer to do each piece yourself? The [manual runbook](coolify-migration.md) covers every step with commands.

## Does it affect the source?

- **Until the freeze:** no. Reading the fleet is read-only, and the data copy only reads.
- **At the freeze (you approve it):** the containers on the stop list are stopped, so the source is down until the switch. A stop is never a delete: Tugra never runs `docker rm` on the source and never deletes its data.
- **At the cutover:** only DNS changes. Before that, the DNS time-to-live is lowered so the change spreads fast.
- **Push-to-deploy:** switched off on the Tugra copies until after the switch, so both sides do not build on every push.

## Roll back

- **Before the point of no return:** press **Abort**. Tugra restarts the source containers it stopped, restores DNS time-to-live, stops its copies and undoes its changes. Nothing is deleted on either side.
- **After the point of no return:** **Reverse** restores DNS from the record Tugra kept. Data written on Tugra after the switch is **not** copied back. Dump it yourself first if it matters.
- Deleting the Tugra copies is a separate, optional step.

## FAQ

**Coolify refuses with a 403.** Tugra shows one cause. *Not allowed to access the API* means the Allowed IPs list: add the address Tugra shows. *API is disabled* means the API switch. *Limited to selected projects* means create a token for the whole team. *More access than you have* means create a new token.

**The token has no read:sensitive.** The token's creator must be a team admin or owner. Create a new one as such a user and tick both abilities.

**How long does it take?** Setup and the dry run take minutes. The downtime window is the final data copy plus the start of the apps. It is estimated before you approve the freeze and measured afterwards.

**My database is large.** A dump over 256 MiB is refused by default, and the dry run names the blocker. In the run dialog's **Advanced options** you can opt in to a streamed copy. It runs inside the downtime window, so it adds to it. See [large databases](runbooks/guided-migration.md#large-databases).

**My Tugra session expired.** The connection to Coolify lasts one hour. The run waits and asks you to paste the token again.

**What about files in S3 or MinIO?** Use [object migration](coolify-migration.md#object-migration-minio--s3).

**Is my data safe if my laptop closes?** Yes. The run lives on the hub, survives restarts and picks up where it was.
