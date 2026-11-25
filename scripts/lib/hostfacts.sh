# shellcheck shell=sh
# Host facts captured ON THE HOST at install time (the agent itself runs in a bridge-networked container and only
# sees its own container: a container id as hostname, the image's Debian, a docker-bridge address). Written to
# /etc/tugra/host-facts.json, which is mounted into the agent; the agent reports it on connect and refreshes the same
# facts at runtime. POSIX sh (the agent installer runs under `sh`), read-only on the host except that one file.
# Keep byte-identical with HOST_FACTS_SH in apps/hub-api/src/install/host-facts-sh.ts (a spec enforces it).
tugra_write_host_facts() {
  _hf_dir="${TUGRA_HOST_FACTS_DIR:-/etc/tugra}"
  mkdir -p "$_hf_dir" 2>/dev/null || return 0
  _hf_hn="$(hostname 2>/dev/null | tr -cd 'A-Za-z0-9.-' | cut -c1-253)"
  _hf_id=""; _hf_ver=""; _hf_pretty=""
  if [ -r /etc/os-release ]; then
    _hf_id="$(. /etc/os-release 2>/dev/null; printf '%s' "${ID:-}" | tr -cd 'A-Za-z0-9._-' | cut -c1-40)"
    _hf_ver="$(. /etc/os-release 2>/dev/null; printf '%s' "${VERSION_ID:-}" | tr -cd 'A-Za-z0-9._-' | cut -c1-40)"
    _hf_pretty="$(. /etc/os-release 2>/dev/null; printf '%s' "${PRETTY_NAME:-}" | tr -cd 'A-Za-z0-9._ ()/-' | cut -c1-80)"
  fi
  # Hashed machine id (Coolify hub takeover: matches this server to a Coolify server). The raw id never leaves the host:
  # sha256("tugra-mid-v1" + the id), hex. Absent (empty) when the host has no machine id or no sha256 tool.
  _hf_mid=""; _hf_mfile="${TUGRA_MACHINE_ID_FILE:-/etc/machine-id}"
  if [ -r "$_hf_mfile" ]; then
    _hf_mraw="$(tr -cd '0-9a-f' < "$_hf_mfile" 2>/dev/null | cut -c1-64)"
    if [ "${#_hf_mraw}" -ge 16 ]; then
      if command -v sha256sum >/dev/null 2>&1; then _hf_mid="$(printf '%s%s' tugra-mid-v1 "$_hf_mraw" | sha256sum 2>/dev/null | cut -c1-64)"
      elif command -v shasum >/dev/null 2>&1; then _hf_mid="$(printf '%s%s' tugra-mid-v1 "$_hf_mraw" | shasum -a 256 2>/dev/null | cut -c1-64)"; fi
    fi
    _hf_mid="$(printf '%s' "$_hf_mid" | tr -cd '0-9a-f' | cut -c1-64)"
    [ "${#_hf_mid}" = "64" ] || _hf_mid=""
  fi
  # sshd host key fingerprints of THIS machine (Coolify hub takeover: the cross-check after an install over Coolify's own SSH compares
  # the key the Coolify host saw on the wire with the one the new agent reports about its own sshd). Public keys only, as the
  # "SHA256:<43 chars>" text ssh-keygen prints; ed25519 first. Absent when the host has no sshd keys or no tool to hash them.
  _hf_sshdir="${TUGRA_SSH_HOST_KEY_DIR:-/etc/ssh}"; _hf_fps=""; _hf_fp1=""
  for _hf_kt in ed25519 ecdsa rsa; do
    _hf_kf="$_hf_sshdir/ssh_host_${_hf_kt}_key.pub"
    [ -r "$_hf_kf" ] || continue
    _hf_fp=""
    if command -v ssh-keygen >/dev/null 2>&1; then
      _hf_fp="$(ssh-keygen -l -E sha256 -f "$_hf_kf" 2>/dev/null | awk 'NR==1{print $2}')"
    fi
    if [ -z "$_hf_fp" ] && command -v openssl >/dev/null 2>&1; then
      _hf_blob="$(awk 'NR==1{print $2}' "$_hf_kf" 2>/dev/null | tr -cd 'A-Za-z0-9+/=' | cut -c1-2000)"
      [ -n "$_hf_blob" ] && _hf_fp="SHA256:$(printf '%s' "$_hf_blob" | openssl base64 -d -A 2>/dev/null | openssl dgst -sha256 -binary 2>/dev/null | openssl base64 -A 2>/dev/null | tr -d '=')"
    fi
    _hf_fp="$(printf '%s' "$_hf_fp" | tr -cd 'A-Za-z0-9+/:' | cut -c1-50)"
    case "$_hf_fp" in SHA256:*) [ "${#_hf_fp}" = "50" ] || continue ;; *) continue ;; esac
    [ -n "$_hf_fp1" ] || _hf_fp1="$_hf_fp"
    _hf_fps="${_hf_fps:+$_hf_fps,}\"$_hf_fp\""
  done
  _hf_ips=""; _hf_fb=0
  if command -v ip >/dev/null 2>&1; then
    _hf_ips="$(ip -o addr show scope global 2>/dev/null | awk '$2 !~ /^(docker|br-|veth|virbr)/ { sub(/\/.*/, "", $4); print $4 }')"
  fi
  if [ -z "$_hf_ips" ]; then
    _hf_ips="$(hostname -I 2>/dev/null | tr ' ' '\n')"; _hf_fb=1
  fi
  _hf_json=""
  for _hf_ip in $_hf_ips; do
    _hf_ip="$(printf '%s' "$_hf_ip" | tr -cd '0-9a-fA-F:.' | cut -c1-45)"
    [ -n "$_hf_ip" ] || continue
    # `hostname -I` cannot tell interfaces apart: drop the docker-bridge range there (`ip` already skipped docker*/br-*).
    if [ "$_hf_fb" = "1" ]; then case "$_hf_ip" in 172.1[6-9].*|172.2[0-9].*|172.3[01].*) continue ;; esac; fi
    _hf_json="${_hf_json:+$_hf_json,}\"$_hf_ip\""
  done
  _hf_tmp="$_hf_dir/.host-facts.json.tmp"
  printf '{"source":"install","collectedAt":%s,"hostname":"%s","os":"%s","osVersion":"%s","osPretty":"%s","machineIdHash":"%s","sshHostKeyFp":"%s","sshHostKeyFps":[%s],"ips":[%s]}\n' \
    "$(date +%s 2>/dev/null || echo 0)" "$_hf_hn" "$_hf_id" "$_hf_ver" "$_hf_pretty" "$_hf_mid" "$_hf_fp1" "$_hf_fps" "$_hf_json" > "$_hf_tmp" 2>/dev/null \
    && chmod 644 "$_hf_tmp" 2>/dev/null && mv -f "$_hf_tmp" "$_hf_dir/host-facts.json" 2>/dev/null || rm -f "$_hf_tmp" 2>/dev/null
  return 0
}
