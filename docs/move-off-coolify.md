# Move off Coolify

This is the main guide for leaving Coolify. You connect Tugra to the server Coolify runs on, Tugra reads Coolify's own database through its agent, and each server is then taken over where it stands. No Coolify API token is needed. Data is copied only when you choose to move a project to another server.

Nothing happens by itself. Every step that changes a server is a button you press, and the ones that matter ask you to type the server's name first.

There are two parts:

1. **Import > Coolify** reads Coolify, matches its servers to yours and decides where everything goes.
2. **Move off Coolify** (sidebar, or press `⌘K`) is one page that walks each server through the four steps: take over in place, clean up, consolidate projects, shut Coolify down.

Other guides cover the cases this one does not:

- [Move from Coolify (to a new server)](move-from-coolify.md): copy to a fresh server, with a dry run and a DNS switch.
- [Move from Coolify on the same server](move-from-coolify-same-server.md): the proxy swap in detail.
- [Coolify migration reference](coolify-migration.md): the API token, database and volume copy tools, and the manual runbook.

## Before you start

- **You are a team owner.** Reading secrets, taking over, cleaning up and moving projects are owner actions. An admin can see the progress but cannot press those buttons.
- **Tugra's agent on the server Coolify runs on.** See step 1.
- Pick the server that matters least for the first take-over, and do the rest once it went well.

## 1. Add the Coolify server to Tugra

[Add a server](add-a-server.md) for the machine that runs the Coolify dashboard, and wait until its agent shows as online. Only a server where the agent finds Coolify can be read.

## 2. Read Coolify through the agent

1. Open **Import**, choose **Coolify**, then **Connect through the agent**.
2. **Pick the server** that runs Coolify.
3. Press **Allow and read**. Tugra reads the Coolify database on that server through its agent and keeps a copy to look at: teams, projects, servers, apps, databases and services. Nothing on the server is changed or stopped, and no secret value is read yet.
4. **Pick the Coolify team** you are moving. Matching, the scope and the placement list that team's servers and projects. **Show all teams** brings the rest back.

You can stop at any time: **Stop and delete** on the Coolify host's page removes the copy Tugra kept. Coolify itself is never touched.

### Allow secret values

Apps need their environment variables and databases need their passwords to run under Tugra. Without this step the apps and databases cannot be imported.

- The values are decrypted on the Coolify server and sealed for your hub. They never travel as plain text.
- You choose what may be read. Environment variables, shared variables, database credentials, basic-auth passwords, compose files, Dockerfiles and labels, scheduled task commands and S3 storage keys are on by default. Notification tokens, Git app keys and deploy keys are off until you tick them.
- The Coolify encryption key, Coolify's own passwords and the SSH private keys are never read.
- You type the Coolify server's name to allow it (the name is shown in the field with a copy button). The permission lasts 24 hours by default and at most 7 days. **Stop allowing** ends it at once, and it also ends when the import finishes.

A value that cannot be read is listed by name. Only that item is held back; the rest carries on.

## 3. Match servers

Coolify may manage many servers. Tugra needs to know which of your Tugra servers is the same machine as each of them. The **Match servers** step lists each Coolify server with what the hub found: the same SSH host key, machine id, Docker engine, address or host name. A server is "Same machine" only when something proves it. A matching address is "Probably the same"; a name alone never decides.

- **Servers without an agent:** the Coolify host's page offers **Install on N servers**. It uses the SSH keys Coolify already has, and the keys stay on the Coolify server. Tugra first checks every server without changing anything and shows what it found: ready, already has an agent, belongs to another hub, cannot be reached, needs root, or sits behind a tunnel. You type the number of servers to install on. One container, the Tugra agent, starts on each ready server and nothing else on it is touched. The permission lasts two hours at most, and **Undo** removes the agents that run installed.
- **Check these machines automatically:** for the servers matched only by address, Tugra asks each machine who it is through Coolify's own SSH keys. You consent first. It reads each machine's SSH host key, machine id and Docker engine id and compares them with what its Tugra agent reports. Nothing is installed or changed, and the permission ends when the check is done. Machines that prove to be the same turn into "Same machine".
- **Confirm all suggested:** answers the obvious matches at once. It only covers servers the hub is fairly sure of that have a connected agent, and you see each one before you confirm. For the others, choose the Tugra server by hand, or mark it as "not the same server". Tugra refuses a match when the machine identities differ.

An answer you give here carries forward: a server you confirm is shown as confirmed on the next steps and is placed on itself.

## 4. Choose what moves and where it goes

**Scope.** Pick **A server** (everything running on the servers you choose), **Projects** (whole projects, wherever they run) or **Everything** (everything of the team you picked). If what you picked needs other items, the page names them and offers **Add them**. An app needs the databases and services whose address appears in its variables. When Tugra cannot read an app's variables yet (no consent so far, or a token that cannot read them), it assumes the app needs the databases and services of its own Coolify environment.

**Placement.** Each source server goes either:

- **Same machine (in place):** the proxy is swapped, a few minutes of downtime, the data stays. Servers you confirmed as the same machine are placed on themselves.
- **Another server:** data is copied, a temporary address is used and DNS is switched at the end. See [Move from Coolify (to a new server)](move-from-coolify.md).

The server Coolify itself runs on cannot be taken over in place, because stopping its proxy would cut off the dashboard and every server it manages. Its apps go to another server, or you take them over last (step D). Offline servers, servers without a connected agent and servers without the `deploy` capability cannot be chosen, and the page says why.

**Preview and apply.** Read the preview. Blockers must be fixed or acknowledged; notes are things Tugra cannot carry over. An app with several domains is imported with all of them; its note names the primary and any domain that cannot be carried. A database on a custom image (for example pgvector or timescaledb) keeps that image, also when its credentials are not carried, and its PostgreSQL version is read from the `pg16` part of the tag. A service whose name is already used by an app on the target team, or by another item of the import, is flagged on its card: rename it there. **Review & rename** changes names, projects and environments. Then apply.

If the servers you chose sit in several Tugra teams, Tugra makes one campaign per team in one step, after checking that you are an owner in every one of them. If the placement mixes in-place and moved servers, the campaign has one run for everything that moves to another server and one run for each in-place server, one after the other. The **Campaign reports** list on the Import page and on the Move off Coolify page opens each report.

## 5. Move off Coolify: the four steps

Open **Move off Coolify**. The page shows every server with where it stands and what to do next. If the Coolify host is in another Tugra team, the page finds it and shows each team's servers.

### A. Take over in place

Each app and database starts under Tugra on the machine it already runs on. The image Coolify already built is reused, with the same environment, volumes and ports. No data is copied. The first Tugra build happens on the next normal deploy. Use **Take over in place** on a server's row.

1. **Plan.** Tugra matches what Coolify runs on the server to the apps in Tugra. Nothing is changed.
2. **Test.** Tugra's proxy starts next to Coolify's on a temporary port with no public access, and every domain is checked against what Coolify answers. A domain that does not match is shown, and you can test again.
3. **Take over.** You type the server's name. Coolify's proxy stops, Tugra's takes ports 80 and 443, and the sites keep their addresses. Apps that share data with Coolify are switched with a short break. Databases are compared by a fingerprint taken before and after, and any failure puts everything back.
4. **Verify.** Coolify's certificate is served for a few minutes as a fallback while Tugra gets a new certificate for each domain. The page shows each domain until all of them are verified.

**Give back to Coolify** undoes it with one click: Tugra's proxy stops and Coolify's proxy and containers start again, as they were. It is available until you clean up Coolify on that server; after that the hub refuses it. If the hub restarts while the ports are being handed over or given back, the takeover shows as failed once the hub is back, and you press **Give back to Coolify** again. If a swap fails, Tugra puts everything back by itself. While a verified takeover can still be given back, Tugra checks every minute that its proxy still holds ports 80 and 443 and that Coolify's proxy is stopped; if not, the takeover shows that the ports were lost and is no longer counted as verified.

When a guided run does the takeover, only that run moves it: the takeover page shows it and links to the run, and the buttons there are off until the run has ended.

### B. Clean up Coolify

On the server's page, **Clean up Coolify**:

Cleanup is offered once the takeover is verified, and only when no guided run still holds the server. A takeover that is only swapped, or still being checked, keeps **Give back to Coolify** available, so nothing is removed yet.

1. **Check.** Tugra compares what Coolify has with what Tugra has, one by one: apps, databases, services, domains and traffic, environment variable names, volumes, scheduled tasks, backups and notifications. The checklist must be complete before anything can be removed. Checking removes nothing.
2. Tugra then lists what Coolify left on the server: its proxy and helper containers, its directories, networks and images. Anything that might hold your data, or that something still uses, is listed as kept.
3. You type the server's name to confirm the exact list you saw. If the list changed since, you check again first.

Docker volumes are never removed. After the cleanup, **Give back to Coolify** no longer works on that server.

### C. Consolidate projects (optional)

On a project's page, **Move to another server** moves the project and everything under it: apps, databases, services, volumes and domains.

1. **Preview.** Shows what moves and anything that blocks it, such as an offline agent, a database engine that cannot move yet, or items on several servers.
2. **Start.** You type the project's name. The items stop for a short time, copy over and start on the new server, and Tugra checks them. You can also have the DNS records pointed at the new server.
3. The old copy stays for the number of days you chose (7 by default) as a safety copy. **Remove the old copy now** deletes it sooner.

A move that has not started moving can be cancelled, and the owner can roll back a finished one within the safety window. A failed move says why in plain words. Shut down the servers that end up empty.

### D. Shut down Coolify

The Coolify host is the last machine. Tugra does not take it over in place, because it runs the Coolify dashboard: apps and databases that still run on the host itself are copied to another server first (an import with a campaign), then Coolify is shut down by you. The page says it is ready only when every server is cleaned, nothing that Coolify ran on the host is left without a copy on another server, and every campaign run is complete. Until then it lists what is still open. If your Coolify manages no other server, the page says so and step D is the whole move.

## Alternative: connect with an API token

If the agent cannot be installed on the Coolify server, choose **Connect with an API token** in the Import wizard instead. Tugra then reads Coolify through its API: enter the Coolify address and a token with **read** and **read:sensitive** (plus **deploy** if Tugra should stop the source for you), created by a team admin or owner for the whole team, with the Coolify API switched on. Everything after the connection works the same way. Token abilities and 403 messages are in the [reference](coolify-migration.md#the-coolify-api-token); the step-by-step run is in [Move from Coolify (to a new server)](move-from-coolify.md).

## Follow the progress from the terminal or an assistant

The progress is read-only everywhere it is offered:

- **CLI:** `tugra coolify status --team <id>` shows every server and the four steps. `tugra coolify takeover <serverId>`, `consent --team <id>`, `campaigns --team <id>`, `cleanup <serverId>`, `ssh <coolifyHostServerId>` and `move <projectId>` show the rest. None of them changes a server.
- **MCP:** `coolify_move_status`, `coolify_takeover_status`, `migration_campaign_status`, `coolify_cleanup_status`, `coolify_ssh_install_status` and `project_move_status`. They need a token with the `read` scope, return names, counts and statuses only, and never a secret value, key or token. Pressing the buttons stays in the panel.
- **API:** `GET /api/v1/coolify-move/status?teamId=<id>`.

## Does it affect Coolify?

- **Reading, matching, checking, planning and testing:** no. They only read, or start Tugra's proxy on a temporary port.
- **Taking over:** Coolify's proxy stops and its containers keep running behind Tugra's proxy. Nothing is deleted.
- **Cleaning up:** removes what Coolify left, only the listed items, only after you confirm.

## Roll back

- Before taking over: nothing to undo.
- After taking over, before cleaning up: **Give back to Coolify**.
- After cleaning up: Coolify is gone from that server. The apps run under Tugra, and your Docker volumes and data are untouched.
- A project move: **Cancel the move** before it moves anything; afterwards the safety copy of the old server stays for the days you chose, and the owner can roll back.

## FAQ

**Is any data copied?** Not in steps A and B: everything stays where it is. Data is copied when you place a server on another server, and when you move a project in step C.

**Do the sites keep their addresses?** Yes. Taking over in place does not change DNS. A project move can point the records at the new server if you ask it to.

**Why is the server list empty, or a server "not managed by Coolify"?** Tugra only counts servers it knows Coolify runs on. Read Coolify first, so Tugra can match them.

**Why is "Same machine (in place)" not offered for a server?** It needs a Tugra server that is the same machine, with an agent online. Match it in step 3, install an agent on it, or choose another server. The Coolify host itself is never offered.

**Why can I not press a button?** Taking over, cleaning up, allowing secrets, checking machines and moving a project are owner actions. Ask a team owner.

**What if a step fails halfway?** Each step says what failed and what to do next, and can be repeated. A failed takeover can be tested again or given back.
