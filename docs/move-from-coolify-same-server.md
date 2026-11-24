# Move from Coolify on the same server

Run Tugra on the server that already runs your Coolify apps, and switch traffic by swapping which proxy owns ports 80 and 443. There is no DNS change: the same addresses keep working. This is the *swap-proxy* shape of a guided run.

> **This path has the least real-world proof.** The proxy swap is covered by tests, but it has not been driven on a real host yet. If you can, use [Move from Coolify (to a new server)](move-from-coolify.md): it is the recommended first move and is easier to undo. Do a dry run here first either way.

## Before you start

- **The server must not run the Coolify control plane.** Tugra refuses a swap on the box where the Coolify dashboard itself runs, because stopping Coolify's proxy there would cut off the dashboard and every server it manages. This guide fits a server that Coolify **manages** as a remote server. If your dashboard and your apps share one box, use the new-server guide.
- **Tugra's agent on that server.** Add the server to Tugra with [Add a server](add-a-server.md). The agent needs the `deploy` and `database` capabilities. Coolify's other containers keep running next to it.
- **A Coolify API token** with **read** and **read:sensitive** (and **deploy** if you want Tugra to stop the source for you). Same rules as in [Move from Coolify](move-from-coolify.md#before-you-start).
- **Certificates ready before the swap.** While Coolify owns port 80, Let's Encrypt cannot validate through it. You need **DNS-01** (a Cloudflare credential in Tugra) or certificates you seed from the source. Without them the run stops before the swap and says so.
- **Disk for two copies.** Both stacks run side by side, so volumes need about twice their size while copying.
- **A single target server.** A swap run that spans several target servers is refused.
- **A real contact email** for Let's Encrypt.

## Steps

1. Do steps 1 to 5 of [Move from Coolify](move-from-coolify.md#steps): connect the token, read the preview, review names, choose the target server. The target is **this** server.
2. Press **Run guided migration**. In the dialog choose **Topology: Same server** (the "?" at the top then opens this guide). Choose **Mode: Copy** to keep Coolify installed, or **Takeover** if you intend to retire it later. Leave **Dry run first** ticked.
3. Read the dry run. It reports the same checks as any run, plus whether certificates can be ready and whether this box runs the Coolify control plane.
4. Start the real run. The data copy, freeze, dark deploy and certificate steps work as in the other guide. The dark deploy starts your apps without public traffic and tests them through Tugra's proxy from inside the host, while Coolify keeps serving.
5. **Approve the swap.** After verification you type the server name and approve. Tugra then:
   1. stops Coolify's proxy container (it never removes it) and records its restart policy,
   2. starts Tugra's proxy on ports 80 and 443,
   3. checks every host from the hub.
6. Watch the observe window, then read the report. Keep Coolify's containers for a few days.
7. Takeover only: once the run is finished, at least 72 hours old and every migrated database has a successful Tugra backup, you can decommission. Tugra stops the old containers and prints the removal commands. You run those yourself.

## Does it affect the source?

- **Until the freeze:** no. Reading and copying only read.
- **At the freeze:** the app containers on the stop list stop.
- **At the swap:** Coolify's proxy stops and its restart policy is set to `no`, so a reboot does not bring it back before Tugra's. Nothing is deleted. If Coolify restarts its proxy on its own, Tugra takes the ports back.
- **While running:** Coolify still shows its apps, but they are no longer the ones serving traffic. Do not redeploy from Coolify during the observe window.

## Roll back

- **Before the swap:** **Abort** restarts the stopped containers and undoes Tugra's changes. Nothing is deleted.
- **After the swap:** **Reverse** undoes it: Coolify's proxy gets its recorded restart policy back and the same container is started again. Data that Tugra's database copies took after the swap is **not** copied back.
- If anything looks wrong on the host after a failure, `docker ps` shows `coolify-proxy` and `tugra-proxy`: only one of them should hold ports 80 and 443.

## FAQ

**Why can't I do this on my Coolify dashboard server?** The dashboard and API sit behind that same proxy. Swapping it would lock you out of Coolify mid-move. Use a new server, or move the apps off first.

**Why DNS-01?** Let's Encrypt's HTTP validation needs port 80, which Coolify still owns until the swap. DNS validation does not.

**Do I need to change DNS?** No. The same records keep pointing at the same IP.

**Do both proxies run at once?** Both can exist, but only one owns ports 80 and 443 at any time. Before the swap, Tugra tests your apps through its own proxy from inside the host.

**What happens on a reboot?** Whether the proxies' restart policies behave as intended across a host reboot has not been verified on a real host. After any reboot, check `docker ps`: exactly one proxy should hold ports 80 and 443.
