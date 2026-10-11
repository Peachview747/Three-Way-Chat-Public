#!/usr/bin/env bash
set -euo pipefail
if [[ ${EUID} -ne 0 ]]; then echo 'Run with sudo.' >&2; exit 1; fi
if [[ $# -ne 1 || ! -f $1 ]]; then echo 'Usage: sudo ./install.sh /path/to/AI-Room-Phone-Setup.json' >&2; exit 1; fi
case "$(uname -m)" in aarch64|arm64) ;; *) echo 'This installer is for 64-bit Raspberry Pi OS on a Pi 5.' >&2; exit 1;; esac

apt-get update
apt-get install -y ca-certificates curl git
node_major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
if (( node_major < 20 )); then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
id ai-room >/dev/null 2>&1 || useradd --system --create-home --home-dir /var/lib/ai-room --shell /bin/bash ai-room
install -d -o root -g root -m 0755 /opt/ai-room /etc/ai-room
install -d -o ai-room -g ai-room -m 0700 /var/lib/ai-room
cp package.json package-lock.json service.mjs store.mjs providers.mjs /opt/ai-room/
npm --prefix /opt/ai-room ci --omit=dev
npm install --global @openai/codex @anthropic-ai/claude-code
node - "$1" <<'NODE'
const fs=require('fs'),source=process.argv[2],p=JSON.parse(fs.readFileSync(source));
if(p.version!==1||p.server!=='https://ai.jch76.workers.dev/'||!/^[0-9a-f-]{36}$/i.test(p.room||'')||!/^[A-Za-z0-9_-]{43}$/.test(p.phoneKey||'')||!/^[A-Za-z0-9_-]{43}$/.test(p.browserKey||''))throw Error('The setup file is not valid for this AI Room Worker.');
fs.writeFileSync('/etc/ai-room/host.json',JSON.stringify({version:1,server:p.server,room:p.room,phoneKey:p.phoneKey},null,2)+'\n',{mode:0o600});
const query=new URLSearchParams({room:p.room,key:p.browserKey});
console.log(`Private website link:\n${p.server}#${query}`);
NODE
chown root:ai-room /etc/ai-room/host.json
chmod 0640 /etc/ai-room/host.json
install -m 0755 ai-room-login /usr/local/sbin/ai-room-login
install -m 0755 configure-github-backup.sh /usr/local/sbin/ai-room-configure-github-backup
cp ai-room.service /etc/systemd/system/ai-room.service
systemctl daemon-reload
systemctl enable --now ai-room.service
echo
echo 'AI Room Pi host installed and started.'
echo 'Connect subscriptions with: sudo ai-room-login gpt && sudo ai-room-login claude'
echo 'Check the service with: systemctl status ai-room'
