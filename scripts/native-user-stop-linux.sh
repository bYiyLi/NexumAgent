#!/usr/bin/env bash
set -u

if [[ "${GITHUB_ACTIONS:-}" != "true" || "${RUNNER_OS:-}" != "Linux" || -z "${RUNNER_TEMP:-}" || -z "${DISPLAY:-}" || "${NEXUM_BROWSER_NATIVE_HEADFUL:-}" != "1" || "${NEXUM_BROWSER_NATIVE_BINARY:-}" != "$RUNNER_TEMP"/nexum-browser-native-*/extracted/* ]]; then
  printf 'This probe requires its isolated GitHub Linux browser and display.\n' >&2
  exit 1
fi

log="$RUNNER_TEMP/native-stop-observation.log"
capture="$RUNNER_TEMP/native-stop-observation.png"
export NEXUM_NATIVE_STOP_READY_FILE="$RUNNER_TEMP/native-stop-ready.json"
node --experimental-vm-modules --test --test-timeout=150000 packages/browser/test/native-user-stop.acceptance.mjs >"$log" 2>&1 &
test_pid=$!
trap 'if [[ -n "$test_pid" ]]; then kill "$test_pid" 2>/dev/null || true; fi' EXIT

clicked=0
expanded=0
ready_at=-1
for _ in $(seq 1 120); do
  if ! kill -0 "$test_pid" 2>/dev/null; then
    break
  fi
  window=$(xdotool search --onlyvisible --name 'Nexum native user stop' 2>/dev/null | head -1 || true)
  if [[ -n "$window" ]] && import -silent -window "$window" "$capture" 2>/dev/null; then
    words=$(tesseract "$capture" stdout tsv 2>/dev/null || true)
    printf '%s\n' "$words" >"$RUNNER_TEMP/native-stop-ocr.tsv"
    if [[ -s "$NEXUM_NATIVE_STOP_READY_FILE" && "$ready_at" -lt 0 ]]; then
      ready_at=$SECONDS
    fi
    if [[ "$ready_at" -ge 0 ]] && (( SECONDS - ready_at >= 35 )); then
      break
    fi
    coords=$(printf '%s\n' "$words" | awk -F '\t' '
      NR > 1 && tolower($12) ~ /debug/ { debugY=$8+$10/2; debugRight=$7+$9; found=1 }
      NR > 1 && tolower($12) == "cancel" { n++; x[n]=$7+$9/2; y[n]=$8+$10/2 }
      NR > 1 && found && $1 == 5 && $7 > debugRight && $9 >= 30 && $10 >= 20 && ($8+$10/2)-debugY < 25 && debugY-($8+$10/2) < 25 { buttonX=$7+$9/2; buttonY=$8+$10/2 }
      END {
        if (found) for (i=1;i<=n;i++) if (y[i]-debugY<30 && debugY-y[i]<30) { printf "%d %d",x[i],y[i]; exit }
        if (found && buttonX) printf "%d %d",buttonX,buttonY
      }
    ')
    if [[ -n "$coords" && -s "$NEXUM_NATIVE_STOP_READY_FILE" ]]; then
      read -r x y <<<"$coords"
      xdotool mousemove --window "$window" "$x" "$y" click 1
      printf 'Clicked the detected native debugger Cancel control.\n'
      clicked=1
      break
    fi
    if [[ "$expanded" -eq 0 && -s "$NEXUM_NATIVE_STOP_READY_FILE" ]]; then
      bar_y=$(printf '%s\n' "$words" | awk -F '\t' '
        NR > 1 && tolower($12) == "unsupported" { printf "%d",$8+$10/2; exit }
      ')
      width=$(identify -format '%w' "$capture" 2>/dev/null || true)
      if [[ -n "$bar_y" && "$width" =~ ^[0-9]+$ ]] && (( width > 100 )); then
        xdotool mousemove --window "$window" "$((width-30))" "$bar_y" click 1
        printf 'Dismissed the fixture command-line warning to expose other notices.\n'
        expanded=1
      fi
    fi
  fi
  sleep 1
done

if [[ "$clicked" -ne 1 ]]; then
  printf 'The native debugger Cancel control was not identified.\n'
  cat "$log"
  exit 1
fi
wait "$test_pid"
status=$?
test_pid=""
cat "$log"
exit "$status"
