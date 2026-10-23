#!/bin/sh
set -eu

RULES_FILE=/etc/udev/rules.d/99-sipeed-slogic.rules

if [ "$(id -u)" -ne 0 ]; then
  echo "needs root; re-running through sudo"
  exec sudo sh "$0" "$@"
fi

if ! getent group plugdev >/dev/null; then
  echo "error: the 'plugdev' group does not exist on this system" >&2
  exit 1
fi

cat > "$RULES_FILE" <<'EOF'
SUBSYSTEM=="usb", ATTR{idVendor}=="359f", ATTR{idProduct}=="3031", MODE="0660", GROUP="plugdev", TAG+="uaccess"
SUBSYSTEM=="usb", ATTR{idVendor}=="359f", ATTR{idProduct}=="3032", MODE="0660", GROUP="plugdev", TAG+="uaccess"
EOF
chmod 0644 "$RULES_FILE"

udevadm control --reload-rules
udevadm trigger --subsystem-match=usb

echo "installed $RULES_FILE:"
cat "$RULES_FILE"
echo "verify with: lsusb  then  ls -l /dev/bus/usb/<bus>/<device>  (group must read plugdev)"
echo "if the node is still root:root, unplug and re-plug the device once"
