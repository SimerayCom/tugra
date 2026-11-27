# Move from CapRover

Copy your CapRover apps, one-click apps, databases and domains onto a Tugra server, check them there, then switch the domains over. CapRover keeps running the whole time, so you can go back until the switch.

The import reads CapRover through its dashboard API. It creates the apps, variables, domains, ports and volume definitions in Tugra and creates nothing on CapRover. It does not copy the contents of databases and volumes: you copy those yourself (see [Copy the data](#copy-the-data)).

## Before you start

1. **A Tugra server for the apps.** A new, online server in Tugra: see [Add a server](add-a-server.md). It needs enough disk for your data.
2. **Your CapRover address and its dashboard password.** The address is the one you open the dashboard on, for example `https://captain.example.com`. CapRover has one password for the dashboard and no API keys, so that password is what Tugra asks for.
3. **For HTTPS on the new server:** a real contact email for Let's Encrypt, and either a Cloudflare credential in Tugra or willingness to edit DNS by hand.

## Steps

1. Open **Import** in Tugra and choose **CapRover**. Enter the dashboard address and the password, then press **Connect & preview**.
2. Tugra signs in once and keeps only the login CapRover returns, for one hour. The password is not stored or logged. If the login expires before you apply, connect again.
3. Choose what moves: everything, or only some apps and databases.
4. Read the **preview**. Blockers must be fixed or acknowledged; notes are things Tugra does not carry over. Open **Review & rename** to change names, projects and environments.
5. Choose the **target server** and press **Import to Tugra**. Nothing is deployed yet: each app is created stopped.
6. [Copy the data](#copy-the-data), then deploy the apps on the target server.
7. Check the apps on their temporary address. When they are right, point each domain at the Tugra server (the cutover panel on the operation shows the records).

## What is mapped

| CapRover | Tugra |
|---|---|
| App deployed from an image, including one-click apps | App from the same image (the version CapRover has deployed) |
| App that deploys from a git repository | Git app built from the repository's Dockerfile, with the repository and branch |
| App with persistent data | Single-replica app with its volumes |
| Instance count | Replica count |
| Environment variables | Variables, with their values read from CapRover when you apply |
| Persistent directories | Volumes (named volumes and host paths) |
| Published ports and the container HTTP port | Published ports and the container port |
| Custom domains and their HTTPS setting | Domains |
| HTTP basic auth | Basic auth |
| PostgreSQL, MySQL, MariaDB, MongoDB, Redis, KeyDB, Dragonfly and ClickHouse images run as a single instance | A Tugra database of that engine, with its user, database and password |

An app that is not exposed as a web app gets no domain. An app that was never deployed (no image and no repository) is left out and listed in the preview.

## What is not carried

The preview lists these per app, so none of them is a surprise:

- The `captain-definition` file. Tugra builds the Dockerfile in the repository; check the first build.
- Custom nginx configuration, pre-deploy functions and Docker service overrides.
- The default sub-domain under your CapRover root domain. Add a domain in Tugra for any app that used only that name.
- Registry credentials. An image CapRover pushed to your registry needs that registry added in Tugra first.
- Images CapRover built on its own server and never pushed: there is nothing to pull. Rebuild the app from its repository, or push the image to a registry.

## Copy the data

Database and volume contents are not read through the CapRover API, so the imported databases and volumes start empty.

- **Databases:** dump each one on the CapRover server and restore it into the Tugra database (`pg_dump` and `pg_restore` for PostgreSQL, `mysqldump` for MySQL and MariaDB, `mongodump` and `mongorestore` for MongoDB).
- **Volumes:** copy each volume directory to the same path on the Tugra server with `rsync`, with the app stopped on CapRover.

Stop writes on the CapRover side before the final copy.

## Does it affect the source?

No. Reading CapRover only lists apps. Nothing on CapRover is changed, stopped or deleted. Keep it running for a few days after the switch.

## FAQ

**It says the password is wrong.** Open the dashboard in a browser with the same address and password. If that works, check that the address has no extra path and that CapRover's root domain is reachable from the Tugra hub.

**The session ended while I was reviewing.** The login lasts one hour. Connect again; the address is kept.

**Why can't I use a guided run?** The guided migration run is built for Coolify and Dokploy. A CapRover import runs from the wizard, MCP (`import_connect` with `sourceKind: "caprover"`) or the REST API.
