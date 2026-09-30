#!/bin/bash
set -euo pipefail

project_dir="$(cd "$(dirname "$0")/.." && pwd)"
app_dir="$project_dir/mac-agent/build/iPhone Data Sharing.app"
node_binary="$(node -p 'process.execPath')"

cd "$project_dir/server"
npm run build

rm -rf "$app_dir"
mkdir -p "$app_dir/Contents/MacOS" "$app_dir/Contents/Resources/server" "$app_dir/Contents/Resources/shortcuts" "$app_dir/Contents/Resources/tools"
cp "$project_dir/mac-agent/Info.plist" "$app_dir/Contents/Info.plist"
cp "$project_dir/mac-agent/assets/AppIcon.png" "$app_dir/Contents/Resources/AppIcon.png"
cp "$project_dir/mac-agent/assets/MenuIcon.png" "$app_dir/Contents/Resources/MenuIcon.png"
cp "$node_binary" "$app_dir/Contents/MacOS/node"
cp -R "$project_dir/server/dist" "$app_dir/Contents/Resources/server/dist"
cp -R "$project_dir/server/node_modules" "$app_dir/Contents/Resources/server/node_modules"
cp "$project_dir/server/package.json" "$app_dir/Contents/Resources/server/package.json"
cp "$project_dir/shortcuts/"*.shortcut "$app_dir/Contents/Resources/shortcuts/"
cp "$project_dir/tools/build_shortcuts.py" "$app_dir/Contents/Resources/tools/"
module_cache="$project_dir/mac-agent/build/module-cache"
mkdir -p "$module_cache"
CLANG_MODULE_CACHE_PATH="$module_cache" SWIFT_MODULECACHE_PATH="$module_cache" xcrun swiftc -module-cache-path "$module_cache" -framework AppKit -framework CoreImage -framework SystemConfiguration "$project_dir/mac-agent/main.swift" -o "$app_dir/Contents/MacOS/iPhone Data Sharing"
codesign --force --deep --sign - "$app_dir"
echo "$app_dir"
