#!/bin/sh
# Run this reviewed installer kit from a file, with private config on stdin.
set -eu
PATH=/usr/bin:/bin:/usr/sbin:/sbin
export PATH
unset NODE_OPTIONS NODE_PATH NODE_REPL_EXTERNAL_MODULE
case "$(uname -s)" in
 Darwin) node_os=darwin ;;
 Linux) node_os=linux ;;
 *) echo 'Use install.ps1 on Windows; this platform is unsupported.' >&2; exit 1 ;;
esac
case "$(uname -m)" in
 x86_64|amd64) node_arch=x64 ;;
 arm64|aarch64) node_arch=arm64 ;;
 *) echo 'This CPU architecture is unsupported.' >&2; exit 1 ;;
esac
case "$node_os-$node_arch" in
 darwin-arm64) node_sha=89c682593d76cd44233fa53b1563264e7de9cbb189cad169135c5b4fadfbc0a7 ;;
 darwin-x64) node_sha=d132557e7ee2b85af08b0c8c34338e65c6430f2238d01f727728ef42dc83b035 ;;
 linux-arm64) node_sha=33c37be234ba8bee041961047b19160f4d7d0f164e8e246f78bdd10feff148b3 ;;
 linux-x64) node_sha=eb6728e77c576a35162c122c45ccadf224d89ff00abc8dae46cc2897c6002d7c ;;
esac
installer_directory=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
[ -f "$installer_directory/install-agent.mjs" ] || { echo 'Use the complete reviewed installer kit.' >&2; exit 1; }
bootstrap_directory=$(mktemp -d "${TMPDIR:-/tmp}/nexum-node.XXXXXXXX")
trap 'rm -rf "$bootstrap_directory"' EXIT HUP INT TERM
node_archive="node-v24.22.1-$node_os-$node_arch.tar.gz"
curl --fail --location --silent --show-error --proto '=https' --tlsv1.2 "https://nodejs.org/dist/v24.22.1/$node_archive" -o "$bootstrap_directory/node.tar.gz" < /dev/null
if [ "$node_os" = darwin ]; then
 actual_sha=$(/usr/bin/shasum -a 256 "$bootstrap_directory/node.tar.gz" | /usr/bin/awk '{print $1}')
else
 actual_sha=$(/usr/bin/sha256sum "$bootstrap_directory/node.tar.gz" | /usr/bin/awk '{print $1}')
fi
[ "$actual_sha" = "$node_sha" ] || { echo 'The bootstrap Node checksum is invalid.' >&2; exit 1; }
tar -xzf "$bootstrap_directory/node.tar.gz" -C "$bootstrap_directory"
"$bootstrap_directory/node-v24.22.1-$node_os-$node_arch/bin/node" "$installer_directory/install-agent.mjs" "$@"
