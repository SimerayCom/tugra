# First setup

From a fresh install to your first running app, in about ten minutes.

## Before you start

- Tugra is installed and the panel opens. If not, follow [Install](install.md): one command on a Linux server.
- The installer printed a **setup code** on a fresh install. Keep it handy. To read it again later: `grep SETUP_CODE .env` in the install directory.
- Optional: a domain whose DNS you control, if you want HTTPS on the panel right away. You can add it later.

## Steps

1. **Open the panel.** Go to the address the installer printed, usually `http://<server-ip>/`.
2. **Create the owner account.** Enter your email, a password and the setup code. The first account becomes the instance **owner**.
3. **Choose how you use Tugra.** *Fleet* is the full control plane (servers, teams, deploys, monitoring). *Home* is a simple app launcher for one box. You can switch any time in **Settings**.
4. **Check the instance basics.** Tugra fills the public URL from your install. Correct it if the address is not the one people will use. The Let's Encrypt email is optional and only gets expiry notices.
5. **Email (optional).** Needed for password reset and invites. Skip it now and set it later under **Settings, Email**. Without it, the panel still works and invite links can be copied by hand.
6. **Secure your account.** Turn on two-factor authentication. You can also require it for owners and admins under **Settings, Account**.
7. **Connect your first server.** This machine connects itself, so there is no command to run. To add another server, see [Add a server](add-a-server.md).
8. **Launch your first workload.** Deploy from a Git repository, or install an app from the app store in one click. For a private repository, [connect GitHub](connect-github.md) first.
9. **Review.** The last step shows what you set up. Everything on it can be changed later in **Settings**.

Moving from Coolify? Do steps 1 to 7, then follow [Move from Coolify](move-from-coolify.md).

## Does it affect the source?

Nothing outside the server Tugra runs on. The installer adds Docker (if missing), the Tugra containers and its own proxy. It never touches other websites on the host. If something else already uses port 80, the installer says so and falls back to raw ports instead.

## Roll back

- **Wrong choice in a step:** every step can be changed later in **Settings**.
- **Remove Tugra:** `docker compose down` in the install directory stops it. Add `-v` only if you also want to delete its data.

## FAQ

**I lost the setup code.** `grep SETUP_CODE .env` in the install directory prints it.

**The panel does not open from my laptop.** Open ports 80 and 443 in the server's firewall (many providers have a separate cloud firewall). See [Install, Troubleshooting](install.md#troubleshooting).

**Do I need a domain?** No. Tugra works on the server's IP address. A domain gives you HTTPS: see [Domains and Cloudflare](domains-and-cloudflare.md).

**Can I add a server that has SSH locked down?** Yes: see [Add a server](add-a-server.md), which covers jump hosts, Tailscale, provider consoles and cloud-init.

**Where do I report a problem?** Use the feedback button in the panel, or open an issue on GitHub. Include the logs described in [Testing the beta](beta-testing.md).
