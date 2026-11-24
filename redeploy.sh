#!/bin/sh
# Builds the SDK into examples/sdk and copies the example pages into the apps of a local Ant Media Server.
# Usage: ./redeploy.sh [app ...]     default apps: LiveApp WebRTCAppEE live
# Pages: http://localhost:5080/<app>/samples/index.html
AMS_DIR=${AMS_DIR:-$HOME/softwares/ant-media-server}

[ $# -eq 0 ] && set -- LiveApp WebRTCAppEE live

[ -d node_modules ] || npm install || exit 1
npm run build:samples || exit 1

for app in "$@"; do
  if [ ! -d "$AMS_DIR/webapps/$app" ]; then
    echo "skipped $app: not in $AMS_DIR/webapps"
    continue
  fi
  # samples/ also holds the app's own pages, so copy over it rather than replace it
  target="$AMS_DIR/webapps/$app/samples"
  mkdir -p "$target"
  cp -R examples/. "$target"/ || exit 1
  # earlier versions of this script deployed to js-sdk/
  rm -rf "$AMS_DIR/webapps/$app/js-sdk"
  echo "deployed $target"
done
