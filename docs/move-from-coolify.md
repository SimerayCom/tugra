# Move from Coolify (to a new server)

Copy your Coolify apps, databases, services and domains onto a Tugra server, check them there, then switch the domains over. Coolify keeps running the whole time, so you can go back until the switch.

Start with [Move off Coolify](move-off-coolify.md). It covers the whole move: reading Coolify through the Tugra agent, matching servers, choosing where each one goes, and the steps after. This page is the detail for servers you place on **another server**, and for reading Coolify with an API token instead of the agent. Placing a server on its own machine is covered in [Move from Coolify on the same server](move-from-coolify-same-server.md).

## Before you start

1. **A Tugra server for the apps.** A new, online server in Tugra: see [Add a server](add-a-server.md). It needs enough disk for your data (a database copy can need about twice its size while it runs).
2. **A way to read Coolify.** Either the Tugra agent on the Coolify server (**Connect through the agent**, see [Move off Coolify](move-off-coolify.md#2-read-coolify-through-the-agent)), or a Coolify API token:
   - In Coolify open **Keys & Tokens, API tokens** and create one as a team **admin or owner**, for the **whole team** (not limited to some projects).
   - Give it **read** and **read:sensitive**. Without `read:sensitive`, Coolify hides build commands, labels, Dockerfile text and variable values, so they cannot move.
   - Add **deploy** only if you want Tugra to stop and restart the source through the API.
   - In Coolify open **Settings, Advanced** and turn on the API. If **Allowed IPs** is set, add your Tugra hub's address or clear the list (Tugra shows the address when Coolify refuses).
3. **A supported Coolify.** Version 4.1.2 or newer, tested up to 4.7.5.
4. **For HTTPS on the new server:** a real contact email for Let's Encrypt, and either a Cloudflare credential in Tugra or willingness to edit DNS by hand.
5. **The Coolify host can reach your hub** over HTTPS. Database and volume data is pulled by a small helper that runs on the Coolify host.
6. **A shell on the Coolify host** for the data steps.

## Steps

1. Open **Import** in Tugra and choose **Coolify**. Connect through the agent as described in [Move off Coolify](move-off-coolify.md), or choose **Connect with an API token**, enter the Coolify address and paste the token. Tugra checks the token and shows one line, for example `✓ Acme Team, 19 apps, 10 databases · read:sensitive`. If it says **no read:sensitive**, create a new token.
2. Choose what moves: everything, only the apps on one source server, or whole projects.
3. Read the **preview**. Blockers must be fixed or acknowledged; notes are things Tugra cannot carry over. Open **Review & rename** to change names, projects and environments.
4. Choose the **target server**.
5. Press the start button at the top of the review, or the same one pinned at its end (it says what it moves, for example **Move to Server A**). It opens its own page, not a dialog. Leave **Dry run first** ticked and start the run. It walks through every step, writes nothing, and lists what would block you. Fix those and repeat until it is clean. Run a dry run before every real run, and make the first real run something that does not matter much.
6. Start the real run from the finished dry run. The run then asks for you at a few points:
   - **Data copy:** it prints one command per source host. Paste it on the Coolify host. The first pass copies while Coolify still serves traffic.
   - **Freeze:** you approve the list of containers to stop. This opens the downtime window. The final data copy runs next.
   - **Dark deploy:** apps start on Tugra without public traffic. Apps with no domain (workers) stay stopped until after the switch.
   - **Certificates and checks:** Tugra gets HTTPS certificates ahead of the switch and tests every app on a temporary address.
   - **Approve the switch:** you read the verification report, type the target server name and approve. This is the point of no return.
   - **Cutover:** Tugra changes DNS (Cloudflare) or shows you the records to change. It then watches the apps for a while and writes a report.
7. Check your sites on the new server. Keep Coolify running for a few days. Remove the push webhooks at the source by hand when you are happy.

To do each piece yourself, the [manual runbook](coolify-migration.md) has every step with commands. The run itself is described in the [guided migration runbook](runbooks/guided-migration.md).

## Does it affect the source?

- **Until the freeze:** no. Reading the fleet is read-only, and the data copy only reads.
- **At the freeze (you approve it):** the containers on the stop list are stopped, so the source is down until the switch. A stop is never a delete: Tugra never runs `docker rm` on the source and never deletes its data.
- **At the cutover:** only DNS changes. Before that, the DNS time-to-live is lowered so the change spreads fast.
- **Push-to-deploy:** switched off on the Tugra copies until after the switch, so both sides do not build on every push.

## Roll back

On a plain import (not the guided run), **Roll back** on the timeline removes the apps it created and the databases it created that are still empty. It keeps apps you deployed since, databases that already have data or backups, and the projects, git sources and settings the import made. For a guided run:

- **Before the point of no return:** press **Abort**. Tugra restarts the source containers it stopped, restores DNS time-to-live, stops its copies and undoes its changes. Nothing is deleted on either side.
- **After the point of no return:** **Reverse** restores DNS from the record Tugra kept. Data written on Tugra after the switch is **not** copied back. Dump it yourself first if it matters.
- Deleting the Tugra copies is a separate, optional step.

When the run is done, use the **Move off Coolify** page to clean up what Coolify left on the servers you took over and to shut Coolify down.

## FAQ

**Coolify refuses with a 403.** Tugra shows one cause. *Not allowed to access the API* means the Allowed IPs list: add the address Tugra shows. *API is disabled* means the API switch. *Limited to selected projects* means create a token for the whole team. *More access than you have* means create a new token.

**The token has no read:sensitive.** The token's creator must be a team admin or owner. Create a new one as such a user and tick both abilities.

**How long does it take?** Setup and the dry run take minutes. The downtime window is the final data copy plus the start of the apps. It is estimated before you approve the freeze and measured afterwards.

**My database is large.** A dump over 256 MiB is refused by default, and the dry run names the blocker. In the run dialog's **Advanced options** you can opt in to a streamed copy. It runs inside the downtime window, so it adds to it. See [large databases](runbooks/guided-migration.md#large-databases).

**My Tugra session expired.** With an API token, the connection to Coolify lasts one hour. The run waits and asks you to paste the token again.

**What about files in S3 or MinIO?** Use [object migration](coolify-migration.md#object-migration-minio--s3).

**Is my data safe if my laptop closes?** Yes. The run lives on the hub, survives restarts and picks up where it was.
