#!/bin/bash
# J680: time "upload a ~136 KB file to public_html/portfolio and read it back over HTTPS (byte-identical)" by each route.
# Usage: bench.sh ROUTE RUNS     routes: scp rsync sshcat uapi ftps   (credentials are read from ~/.config/site-put, never printed)
set -u
SSHX=${SSHX:-}; R=$1; N=${2:-5}; F=$HOME/.cache/j680/j680-throwaway.txt; NAME=j680-throwaway.txt
H=p3plzcpnl457110.prod.phx3.secureserver.net; U=zuxabmjqiwhz; DIR=/home/$U/public_html/portfolio; URL=https://angusforbes.com/portfolio/$NAME
WANT=$(sha256sum "$F" | cut -c1-64)
put() {
  case $R in
    scp) scp -q -o BatchMode=yes "$F" "godaddy:public_html/portfolio/$NAME" 2>/dev/null;;
    rsync) rsync -q -e "ssh -o BatchMode=yes $SSHX" "$F" "godaddy:public_html/portfolio/$NAME" 2>/dev/null;;
    sshcat) ssh -o BatchMode=yes godaddy "cat > public_html/portfolio/$NAME" < "$F" 2>/dev/null;;
    uapi) curl -s -m 30 -H @<(printf 'Authorization: cpanel %s:%s\n' "$U" "$(cat ~/.config/site-put/cpanel-token)") -F "dir=$DIR" -F "overwrite=1" -F "file-1=@$F" "https://$H:2083/execute/Fileman/upload_files" | grep -q '"status":1';;
    ftps) curl -s -m 30 --ssl-reqd --netrc-file <(printf 'machine %s login j680bench@angusforbes.com password %s\n' "$H" "$(cat ~/.config/site-put/ftp-pass)") -T "$F" "ftp://$H/$NAME";;
  esac
}
for i in $(seq 1 "$N"); do
  t0=$(date +%s.%N); put; prc=$?; t1=$(date +%s.%N)
  got=$(curl -s -m 20 -H 'Cache-Control: no-cache' "$URL?r=$RANDOM$i" | sha256sum | cut -c1-64); t2=$(date +%s.%N)
  printf '%s run %d: upload %.2fs (rc %d), read-back %.2fs, total %.2fs, %s\n' "$R" "$i" "$(echo "$t1-$t0"|bc)" "$prc" "$(echo "$t2-$t1"|bc)" "$(echo "$t2-$t0"|bc)" "$([[ $got == $WANT ]] && echo identical || echo MISMATCH)"
done
