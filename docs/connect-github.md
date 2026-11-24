# Connect GitHub

Deploy private repositories, and move apps that live in private repositories, by giving Tugra a **GitHub App** that can read them. Tugra creates the App for you in one click, or you can create it by hand and paste three values. The App is yours: Tugra never sees your GitHub password, and you can revoke it at any time.

Public repositories need none of this: paste the repository URL when you create the app.

## The quick way (one click)

1. Open **Git Sources** and press **Connect GitHub**.
2. Choose who can use it (one team, or every team), then press **Continue to GitHub**.
3. On GitHub, pick your account or an organisation and press **Create GitHub App**. Tugra fills in the name, permissions and webhook for you.
4. GitHub then asks where to install the App: pick the repositories and press **Install**. You land back in Tugra with the source ready.

To add another account or organisation later, press **Connect GitHub** again. If your panel is not reachable from the internet, Tugra tells you before you leave: deploys still work from the panel, only deploy-on-push needs the public address.

The rest of this page is the manual way, for when you want to create the App yourself (it stays under **Advanced** on the Git Sources page).

## Before you start

- A GitHub account that owns the repositories (or an organisation you can create Apps in).
- A Tugra panel with a public address that GitHub can reach, if you want deploy-on-push. Without it, deploys still work from the panel.
- About five minutes.

The steps below create the App by hand. Gitea, Forgejo and Codeberg are simpler: **Git Sources, Add Gitea / Forgejo / Codeberg**, then paste a personal access token with read access to repositories.

## Steps

### 1. Create the App on GitHub

1. Open GitHub, then **Settings, Developer settings, GitHub Apps, New GitHub App**. For an organisation, start from the organisation's settings instead.
2. **Name:** anything, for example `tugra-acme`. It must be unique on GitHub.
3. **Homepage URL:** your panel address.
4. **Webhook:** leave **Active** off for now. You can turn it on in step 4.
5. **Repository permissions:** set **Contents** to *Read-only* and **Metadata** to *Read-only*. Add **Pull requests** *Read-only* if you want preview apps for pull requests.
6. **Where can this GitHub App be installed?** Choose *Only on this account*. An App created on a personal account can only be installed there.
7. Press **Create GitHub App**.

### 2. Collect three values

1. On the App's page, copy the **App ID** (a number).
2. Scroll to **Private keys**, press **Generate a private key**. A `.pem` file downloads. Keep it safe: it is the App's password.
3. Press **Install App** in the sidebar, choose the account, and pick **All repositories** or only some. After installing, the address bar ends with `/installations/<number>`. That number is the **Installation ID**.

### 3. Paste them into Tugra

1. Open **Git Sources**.
2. Choose the team, then **Add GitHub App**.
3. Enter a name, the App ID, the Installation ID and the private key. Open the `.pem` file in a text editor and paste all of it, including the `BEGIN` and `END` lines.
4. Press **Add source**, then **List repos**. Your repositories appear.

When you create an app, pick **Private repository**, choose this source and a repository.

### 4. Deploy on push (optional)

1. In the App's settings on GitHub, set the **Webhook URL** to `https://<your panel domain>/webhooks/github/<source id>`. The source id is the id of the Git source you just added (it is in the `id` field of `GET /git-sources`).
2. Set a **Webhook secret** (any long random string) and enter the same secret on the Tugra source.
3. Under **Subscribe to events**, tick **Push**, and **Pull request** if you use previews.
4. Turn **Active** on and save.

## Does it affect the source?

Your repositories are only **read**. Tugra clones them with short-lived tokens it asks GitHub for. It does not write to your repositories, create branches or change settings. The webhook only tells Tugra that something was pushed.

## Roll back

- In Tugra: **Git Sources**, delete the source. Apps that used it keep running but cannot pull new commits.
- On GitHub: **Settings, Developer settings, GitHub Apps**, then **Advanced, Delete GitHub App**, or just uninstall it from the account.
- If the private key leaked: generate a new one on GitHub, delete the old one, and update the source in Tugra.

## FAQ

**A repository is missing from the list.** The App is installed only on some repositories. On GitHub, open the installation and add it. Then press **List repos** again.

**It works for me but not for my other team.** Git Sources belong to a team. Add the source to the other team too, or ask the instance owner to share it with all teams.

**The App belongs to my personal account but the repositories are in an organisation.** Create the App under the organisation instead, or create it as *Any account* and install it on the organisation.

**What is the webhook secret for?** It proves a request really came from GitHub. Without it Tugra rejects the webhook, so deploy-on-push stays off but manual deploys keep working.
