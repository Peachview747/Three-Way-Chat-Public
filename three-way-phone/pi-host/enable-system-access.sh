#!/bin/sh
set -eu
if [ "$(id -u)" -ne 0 ]; then echo 'Run with sudo.' >&2; exit 1; fi
source_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
visudo -cf "$source_dir/ai-room.sudoers"
install -d -m 0755 /etc/systemd/system/ai-room.service.d
install -m 0440 "$source_dir/ai-room.sudoers" /etc/sudoers.d/ai-room-system-access
install -m 0644 "$source_dir/system-access.conf" /etc/systemd/system/ai-room.service.d/system-access.conf
systemctl daemon-reload
systemctl restart ai-room.service
echo 'AI Room assistants now have local command access and passwordless sudo.'
