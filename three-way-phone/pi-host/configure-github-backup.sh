#!/usr/bin/env bash
set -euo pipefail
if [[ ${EUID} -ne 0 ]]; then echo 'Run with sudo.' >&2; exit 1; fi
repo=${1:-https://github.com/Peachview747/Three-Way-Chat-App-Data.git}
command -v gh >/dev/null || { echo 'Install GitHub CLI first: sudo apt install gh' >&2; exit 1; }
systemctl stop ai-room.service
runuser -u ai-room -- env HOME=/var/lib/ai-room gh auth login --hostname github.com --git-protocol https --web
runuser -u ai-room -- env HOME=/var/lib/ai-room gh auth setup-git
if [[ ! -d /var/lib/ai-room/private-backup/.git ]]; then
  runuser -u ai-room -- env HOME=/var/lib/ai-room gh repo clone "$repo" /var/lib/ai-room/private-backup
fi
runuser -u ai-room -- git -C /var/lib/ai-room/private-backup config user.name 'AI Room Raspberry Pi'
runuser -u ai-room -- git -C /var/lib/ai-room/private-backup config user.email 'ai-room@raspberrypi.local'
node <<'NODE'
const fs=require('fs'),file='/etc/ai-room/host.json',p=JSON.parse(fs.readFileSync(file));
p.backupRepoPath='/var/lib/ai-room/private-backup';fs.writeFileSync(file,JSON.stringify(p,null,2)+'\n',{mode:0o640});
NODE
chown root:ai-room /etc/ai-room/host.json
systemctl start ai-room.service
echo 'Private GitHub conversation backup enabled.'
