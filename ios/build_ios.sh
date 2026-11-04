#!/usr/bin/env bash
# 构建 iOS / iPadOS 版（ad-hoc 签名的 .ipa，供用户自签名安装：Sideloadly / AltStore / SideStore / 证书工具）
#
# 必须在 macOS 上运行（需要 Xcode 命令行工具：xcode-select --install）。
# 本地没 Mac 时由 .github/workflows/ios.yml 在 GitHub Actions 的 macOS runner 上跑。
#
# 产物：ios/dist/ICAO900-OPI-ios-<版本>.ipa
set -euo pipefail
cd "$(dirname "$0")"

APP_NAME="ICAO900OPI"
MIN_IOS="15.0"
VER="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' Info.plist 2>/dev/null || echo 1.0.0)"
BUILD="$(date +%Y%m%d%H%M)"
OUT="build"
IPA="ICAO900-OPI-ios-${VER}.ipa"

if ! command -v xcrun >/dev/null 2>&1; then
  echo "错误：需要 macOS + Xcode 命令行工具（xcode-select --install）" >&2
  exit 1
fi

SDK="$(xcrun --sdk iphoneos --show-sdk-path)"
echo "SDK: $SDK"
echo "版本: $VER ($BUILD)  最低 iOS: $MIN_IOS"

rm -rf "$OUT"
mkdir -p "$OUT"

echo "→ 编译 Swift（arm64 设备版）"
xcrun -sdk iphoneos swiftc \
  -target "arm64-apple-ios${MIN_IOS}" \
  -sdk "$SDK" \
  -O \
  -framework UIKit -framework WebKit -framework AVFoundation -framework Speech \
  -o "$OUT/$APP_NAME" \
  main.swift

APP="$OUT/$APP_NAME.app"
mkdir -p "$APP"
cp "$OUT/$APP_NAME" "$APP/$APP_NAME"
cp Info.plist "$APP/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion $BUILD" "$APP/Info.plist"

echo "→ 拷入网页资源（app/assets，含 900 句与 OPI 双嗓音音频）"
cp -R ../app/assets "$APP/assets"

echo "→ 拷入图标"
cp icons/AppIcon*.png "$APP/"

echo "→ ad-hoc 签名（用户用 Sideloadly/AltStore 重新签名即可安装）"
codesign --force --sign - --timestamp=none "$APP" 2>/dev/null \
  || codesign --force --sign - "$APP"

echo "→ 组装 .ipa"
rm -rf "$OUT/Payload"
mkdir -p "$OUT/Payload"
cp -R "$APP" "$OUT/Payload/"
( cd "$OUT" && rm -f "$IPA" && zip -qry "$IPA" Payload )

mkdir -p dist
rm -f "dist/$IPA"
cp "$OUT/$IPA" "dist/$IPA"

echo "→ 校验"
/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$APP/Info.plist"
/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP/Info.plist"
codesign -dv "$APP" 2>&1 | head -3 || true
ls -lh "dist/$IPA"
echo "完成：ios/dist/$IPA"
