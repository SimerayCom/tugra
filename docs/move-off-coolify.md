# Move off Coolify

Take everything Coolify runs and manage it from Tugra, server by server, without copying data you do not need to copy. The panel walks you through it on one page, **Import > Move off Coolify**. This guide explains the same four steps, what each one changes, and how to undo it.

Nothing happens by itself. Every step that changes a server is a button you press, and the ones that matter ask you to type the server's name first.

## The four steps

1. **Take over in place.** Each app and database starts under Tugra on the machine it already runs on. The image Coolify already built is reused, with the same environment, volumes and ports. No data is copied.
2. **Clean up Coolify.** When Tugra has everything, remove what Coolify left on each server.
3. **Consolidate projects** (optional). Move a whole project to another server and shut down the servers that end up empty.
4. **Shut down Coolify.** Last, when every server is clean.

The checklist page shows every server with where it stands and what to do next, so you can see all of them at once.

## Before you start

- **Tugra's agent on the Coolify host and on every server Coolify manages.** If a server does not have one yet, [Add a server](add-a-server.md), or let Tugra install the agents for you (see below).
- **You are a team owner.** Taking over, cleaning up and allowing secrets are owner actions. An admin can see the progress but cannot press those buttons.
- A quiet moment for the first server. Pick the one that matters least, and do the rest once it went well.

## Connect Coolify

1. Open the Coolify host's page in Tugra, or **Import > Read this Coolify**.
2. Allow Tugra to read it, then press **Read**. Tugra reads the Coolify database on that server through its agent and keeps a copy to look at: teams, projects, servers, apps, databases and services. Nothing on the server is changed.

You need no Coolify API token for this.

### Allow reading secret values (optional)

Apps need their environment variables and databases need their passwords to run under Tugra. You can let Tugra read them:

- The values are decrypted on the Coolify server and sealed for your hub. They never travel as plain text.
- You choose what may be read: environment variables, shared variables, database credentials, basic-auth passwords, service definitions, scheduled task commands and storage keys are on by default. Notification tokens, Git app keys and deploy keys are off until you tick them.
- The Coolify encryption key, Coolify's own passwords and the SSH private keys are never read.
- You type the Coolify host's name to allow it. It lasts 24 hours by default and at most 7 days, and **Stop allowing** ends it at once.

A value that cannot be read is listed by name. Only that item is held back; the rest carries on.

### Install agents on the other servers

If Coolify manages servers that have no Tugra agent, the Coolify host's page offers **Install on N servers**. It uses the SSH keys Coolify already has; the keys stay on the Coolify server and are never copied or shown.

1. Tugra first checks every server without changing anything, and shows what it found: ready, already has an agent, belongs to another hub, cannot be reached, needs root, or sits behind a tunnel.
2. You type the number of servers to install on.
3. One container, the Tugra agent, starts on each ready server. Nothing else on it is touched. A server that already runs an agent is left alone.
4. Anything that fails shows a plain reason and the install command to run by hand.

The permission lasts two hours at most. **Undo** removes the agents this run installed.

## Step A: Take over in place

Open the server from the checklist, or start from **Import** and choose **Same machine (proxy swap)** for it.

1. **Plan.** Tugra reads what Coolify runs on the server and matches it to the apps in Tugra. Nothing is changed. Each app reuses the image Coolify already built; the first Tugra build happens on the next normal deploy.
2. **Test.** Tugra's proxy starts next to Coolify's on a temporary port with no public access, and every domain is checked against what Coolify answers. A domain that does not match is shown, and you can test again.
3. **Take over.** You type the server's name. Coolify's proxy stops, Tugra's takes ports 80 and 443, and the sites keep their addresses. Apps that share data with Coolify are switched with a short break.
4. **Verify.** Coolify's certificate is served for a few minutes as a fallback while Tugra gets a new certificate for each domain. The page shows each domain until all of them are verified.

**Give back to Coolify** undoes it with one click: Tugra's proxy stops and Coolify's proxy and containers start again, as they were. It is available until you clean up Coolify on that server.

## Step B: Clean up Coolify

On the server's page, **Clean up Coolify**:

1. **Check.** Tugra compares what Coolify has with what Tugra has, one by one: apps, databases, services, domains, environment variable names, volumes, scheduled tasks, backups and notifications. Checking removes nothing.
2. If everything is there, Tugra lists what Coolify left on the server: its proxy and helper containers, its directories, networks and images. Anything that might hold your data, or that something still uses, is listed as kept and is never removed.
3. You type the server's name to confirm the exact list you saw. If the list changed since, you check again first.

Docker volumes are never listed for removal. After the cleanup, **Give back to Coolify** no longer works on that server.

## Step C: Consolidate projects (optional)

On a project's page, **Move to another server** moves the project and everything under it: apps, databases, services, volumes and domains.

1. **Preview.** Shows what moves and anything that blocks it, such as an offline agent, a database engine that cannot move yet, or items on several servers.
2. **Start.** You type the project's name. The items stop for a short time, copy over and start on the new server, and Tugra checks them. You can also have the DNS records pointed at the new server.
3. The old copy stays for the number of days you chose (7 by default) as a safety copy. **Remove the old copy now** deletes it sooner.

A move that has not started moving can be cancelled. A failed move says why in plain words.

When servers are placed differently in the Import wizard, Tugra makes a campaign with one run per source server. The **Campaign reports** list on the checklist and on the Import page opens each report.

## Step D: Shut down Coolify

When the checklist shows every server cleaned, the Coolify host is the last one. Take its apps over or move them, check that nothing still needs Coolify, then shut it down. Tugra does not take over or clean the Coolify host in place: it runs the Coolify dashboard itself.

## Follow the progress from the terminal or an assistant

The progress is read-only everywhere it is offered:

- **CLI:** `tugra coolify status --team <id>` shows every server and the four steps. `tugra coolify takeover <serverId>`, `consent --team <id>`, `campaigns --team <id>`, `cleanup <serverId>`, `ssh <coolifyHostServerId>` and `move <projectId>` show the rest. None of them changes a server.
- **MCP:** `coolify_move_status`, `coolify_takeover_status`, `migration_campaign_status`, `coolify_cleanup_status`, `coolify_ssh_install_status` and `project_move_status`. They need a token with the `read` scope, return names, counts and statuses only, and never a secret value, key or token. Pressing the buttons stays in the panel.
- **API:** `GET /api/v1/coolify-move/status?teamId=<id>`.

## Does it affect Coolify?

- **Reading, checking, planning and testing:** no. They only read, or start Tugra's proxy on a temporary port.
- **Taking over:** Coolify's proxy stops and its containers keep running behind Tugra's proxy. Nothing is deleted.
- **Cleaning up:** removes what Coolify left, only the listed items, only after you confirm.

## Roll back

- Before taking over: nothing to undo.
- After taking over, before cleaning up: **Give back to Coolify**.
- After cleaning up: Coolify is gone from that server. The apps run under Tugra, and your Docker volumes and data are untouched.
- A project move: **Cancel the move** before it moves anything; afterwards the safety copy of the old server stays for the days you chose.

## FAQ

**Is any data copied?** Not in steps A and B: everything stays where it is. Data is copied only when you move a project to another server in step C.

**Do the sites keep their addresses?** Yes. Taking over in place does not change DNS. A project move can point the records at the new server if you ask it to.

**Why does the page show a server as "not managed by Coolify"?** Tugra only counts servers it knows Coolify runs on. Read Coolify first, so Tugra can match them.

**Why can I not press a button?** Taking over, cleaning up, allowing secrets and moving a project are owner actions. Ask a team owner.

**What if a step fails halfway?** Each step says what failed and what to do next, and can be repeated. A failed takeover can be tested again or given back.
