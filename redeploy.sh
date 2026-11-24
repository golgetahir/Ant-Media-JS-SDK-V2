#!/bin/sh
# Builds the SDK and copies it, with the example pages, into the apps of a local Ant Media Server.
# Usage: ./redeploy.sh [app ...]     default apps: LiveApp WebRTCAppEE live
# Pages: http://localhost:5080/<app>/js-sdk/examples/publish.html
AMS_DIR=${AMS_DIR:-$HOME/softwares/ant-media-server}

[ $# -eq 0 ] && set -- LiveApp WebRTCAppEE live

[ -d node_modules ] || npm install || exit 1
npm run build || exit 1

for app in "$@"; do
  if [ ! -d "$AMS_DIR/webapps/$app" ]; then
    echo "skipped $app: not in $AMS_DIR/webapps"
    continue
  fi
  target="$AMS_DIR/webapps/$app/js-sdk"
  rm -rf "$target"
  mkdir -p "$target"
  cp -R dist examples "$target"/ || exit 1
  echo "deployed $target"
done
