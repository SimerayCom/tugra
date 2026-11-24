# Add a server

A server joins Tugra when its **agent** connects to your hub. You create the server in the panel, copy one command, and run it on the machine. The agent connects **outward** to the hub, so after the install the server does not need port 22 or any other inbound port for Tugra.

## Before you start

- A Linux server (amd64 or arm64) where you can run one command as **root**. If Docker is missing, the command installs it. Without root, install Docker first.
- The server can reach your hub over the network: `https://<your panel domain>` or the IP address of the hub. No inbound ports are needed for the agent.
- The command is valid for **one hour**. If it expires, press **Get a fresh command**.

## Steps

1. Open **Servers**, then **Add Server**. Give the server a name and pick the team.
2. Copy the command shown. It looks like this:

   ```sh
   curl -fsSL https://panel.example.com/install/agent.sh | sh -s -- --hub wss://panel.example.com/agent --token <token>
   ```

   On a hub without a domain the command also carries `--hub-pin`, the fingerprint of the hub's own certificate. The connection is still encrypted.
3. Run it on the server. How you get a shell depends on your setup, see below.
4. Wait. The page shows **Waiting for the agent to connect** and switches to online in a few seconds.

### Option 1: SSH with a key

The simplest case. From your computer:

```sh
ssh root@203.0.113.10
```

Then paste the command. If you log in as another user with `sudo`, use `sudo -i` first so the command runs as root.

### Option 2: through a jump host or Tailscale

When port 22 is closed to the internet or limited to one address, reach the server from a machine that is allowed.

```sh
# via a jump host (bastion)
ssh -J admin@jump.example.com root@10.0.0.12

# via Tailscale: use the machine's Tailscale name or 100.x address
ssh root@app-1
```

Paste the command in that session. The server itself only needs to reach the hub.

### Option 3: the provider's web console

If you cannot use SSH at all (no key, firewall closed), use your provider's console. On Hetzner:

1. Open the server in the Cloud Console.
2. Choose **Rescue**, then **Reset root password**, and note the new password.
3. Open **Console** (the terminal icon) and log in as `root` with that password.
4. Paste the command.

Other providers have the same idea: a browser console that does not depend on SSH or your firewall. A console often does not paste with the usual shortcut: use the provider's paste box or type the command in two lines.

### Option 4: cloud-init (a server that does not exist yet)

Many providers let you paste **user data** when you create a server. Create the server in Tugra first so you have the command, then paste this as the user data, with your own command on the `runcmd` line:

```yaml
#cloud-config
runcmd:
  - curl -fsSL https://panel.example.com/install/agent.sh | sh -s -- --hub wss://panel.example.com/agent --token <token>
```

The server installs the agent on first boot and connects by itself. The token lasts one hour, so create the server soon after you copy the command. If it expired, press **Get a fresh command** and run it by hand.

### Add many servers

On **Add Server**, open **Add many**, enter one name per line and copy the commands. Each server has its own token.

### Provision from the cloud

If you linked a Hetzner credential under **Cloud Providers**, the **Provision from cloud** tab creates the server for you and installs the agent.

## Does it affect the source?

On the server, the command installs Docker if it is missing and starts one container named `tugra-agent` with a data volume `tugra-agent-data`. It mounts the Docker socket so Tugra can manage containers. It does not change your firewall, SSH settings or existing containers.

## Roll back

On the server:

```sh
docker rm -f tugra-agent
docker volume rm tugra-agent-data
```

Then delete the server in Tugra under **Servers**. Docker stays installed.

## FAQ

**The page keeps waiting.** Check that the server can reach the hub (`curl -I https://panel.example.com/health`), that the command was run as root, and read the agent log: `docker logs tugra-agent`. If the hub uses a domain behind Cloudflare, WebSockets must be allowed (they are by default).

**"This command uses plain ws://".** The hub has no HTTPS yet, so secrets could be read on the network. Give the panel a domain ([Domains and Cloudflare](domains-and-cloudflare.md)) or use the IP install, which is encrypted and pinned.

**I use a firewall that only allows my IP on port 22.** Use option 2 or 3, or add the server through cloud-init (option 4).

**Do I need to open any port for apps?** For websites, ports 80 and 443 on the server. That is separate from the agent.

**Can I use a private IP?** Yes, as long as it can reach the hub. For public URLs to work, Tugra needs the server's public IP: set it in the server's network settings if it sits behind NAT.
