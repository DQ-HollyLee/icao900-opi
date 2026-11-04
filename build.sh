#!/usr/bin/env bash
# 构建 ICAO900 OPI APK（手写构建：aapt2 + javac + d8 + zip + apksigner）
# 与正式版的差别：包名 com.icao.n900.asr、内置 llama.cpp 的 mtmd-cli/so、本地 Qwen3-ASR 开关
set -e

ROOT="$(cd "$(dirname "$0")" && pwd)"
# SDK 工具链：默认复用本机已下载的一套；其他机器可用环境变量 ICAO_SDK_CACHE 覆盖
CACHE="${ICAO_SDK_CACHE:-E:/Program Files/WorkBuddyProjects/icao900-android/.cache}"
JDK="$CACHE/sdk_jdk/jdk-17.0.20.1+1"
BT="$CACHE/sdk_bt/android-14"
PLATFORM="$CACHE/sdk_plat/android-34-ext12/android.jar"
APP="$ROOT/app"
BUILD="$ROOT/.build"
DIST="$ROOT/dist"
APKNAME="ICAO900-OPI.apk"

w() { cygpath -w "$1"; }
wm() { cygpath -m "$1"; }

rm -rf "$BUILD"
mkdir -p "$BUILD/gen" "$BUILD/classes" "$BUILD/dex" "$DIST"

echo "==> 1/6 aapt2 compile"
"$BT/aapt2.exe" compile --dir "$(w "$APP/res")" -o "$(w "$BUILD/res.zip")"

echo "==> 2/6 aapt2 link"
VCODE="$(grep -o 'android:versionCode="[0-9]*"' "$APP/AndroidManifest.xml" | head -1 | grep -o '[0-9]*')"
VNAME="$(grep -o 'android:versionName="[^"]*"' "$APP/AndroidManifest.xml" | head -1 | cut -d'"' -f2)"
echo "    version $VNAME ($VCODE)"
"$BT/aapt2.exe" link \
  -o "$(w "$BUILD/base.apk")" \
  -I "$(w "$PLATFORM")" \
  --manifest "$(w "$APP/AndroidManifest.xml")" \
  -A "$(w "$APP/assets")" \
  --java "$(w "$BUILD/gen")" \
  --min-sdk-version 24 \
  --target-sdk-version 34 \
  --version-code "$VCODE" --version-name "$VNAME" \
  "$(w "$BUILD/res.zip")"

echo "==> 3/6 javac"
find "$APP/java" "$BUILD/gen" -name "*.java" | while read -r f; do echo "\"$(wm "$f")\""; done > "$BUILD/sources.txt"
"$JDK/bin/javac.exe" -encoding UTF-8 --release 8 -nowarn \
  -classpath "$(w "$PLATFORM")" -d "$(w "$BUILD/classes")" \
  "@$(w "$BUILD/sources.txt")" > "$BUILD/javac.log" 2>&1 || { cat "$BUILD/javac.log"; exit 1; }

echo "==> 4/6 d8"
"$JDK/bin/jar.exe" cf "$(w "$BUILD/classes.jar")" -C "$(w "$BUILD/classes")" .
"$JDK/bin/java.exe" -cp "$(w "$BT/lib/d8.jar")" com.android.tools.r8.D8 \
  --release --min-api 24 --lib "$(w "$PLATFORM")" --output "$(w "$BUILD/dex")" \
  "$(w "$BUILD/classes.jar")"

echo "==> 5/6 打包 dex + native 库 + 对齐"
"$CACHE/sdk_jdk/jdk-17.0.20.1+1/bin/java.exe" -version >/dev/null 2>&1 || true
"C:/Users/33748/.workbuddy/binaries/python/versions/3.13.12/python.exe" - \
  "$(w "$BUILD/base.apk")" "$(w "$BUILD/dex/classes.dex")" "$(w "$ROOT/libs")" \
  "$(w "$BUILD/unsigned.apk")" <<'PY'
import sys, os, zipfile, shutil
src, dex, libroot, dst = sys.argv[1:5]
shutil.copyfile(src, dst)
with zipfile.ZipFile(dst, 'a', zipfile.ZIP_DEFLATED) as z:
    z.write(dex, 'classes.dex')
    n = 0
    for base, _, files in os.walk(libroot):
        for f in sorted(files):
            p = os.path.join(base, f)
            rel = os.path.relpath(p, libroot).replace('\\', '/')
            zi = zipfile.ZipInfo(rel, (2026, 1, 1, 0, 0, 0))
            zi.compress_type = zipfile.ZIP_DEFLATED
            zi.external_attr = 0o644 << 16
            with open(p, 'rb') as fh:
                z.writestr(zi, fh.read(), compresslevel=9)
            n += 1
    print('dex + %d native libs added' % n)
PY
"$BT/zipalign.exe" -f -p 4 "$(w "$BUILD/unsigned.apk")" "$(w "$BUILD/aligned.apk")"

echo "==> 6/6 签名"
KS="$CACHE/debug.keystore"
if [ ! -f "$KS" ]; then
  "$JDK/bin/keytool.exe" -genkeypair -v -keystore "$(w "$KS")" -storepass icao900 -keypass icao900 \
    -alias icao900 -keyalg RSA -keysize 2048 -validity 10000 \
    -dname "CN=ICAO900, OU=Study, O=ICAO900, L=Beijing, S=Beijing, C=CN" >/dev/null 2>&1
fi
"$JDK/bin/java.exe" -jar "$(w "$BT/lib/apksigner.jar")" sign --ks "$(w "$KS")" \
  --ks-pass pass:icao900 --key-pass pass:icao900 --ks-key-alias icao900 \
  --out "$(w "$DIST/$APKNAME")" "$(w "$BUILD/aligned.apk")"
"$JDK/bin/java.exe" -jar "$(w "$BT/lib/apksigner.jar")" verify --print-certs "$(w "$DIST/$APKNAME")" | head -3
ls -lh "$DIST/$APKNAME"
echo "==> 完成: $DIST/$APKNAME"
