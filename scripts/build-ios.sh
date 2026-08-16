#!/bin/bash
# ============================================
# TinyDo - iOS 侧载 .ipa 构建脚本
# 无需 Apple 开发者账号，产出「未签名」.ipa
# 用 Sideloadly 等工具签名安装（实测：ad-hoc 签名 ipa 会导致 Sideloadly
# 报 "Invalid file"，必须提供未签名包让工具自行签名）
#
# 用法:
#   bash scripts/build-ios.sh
# 或:
#   npm run mobile:build:ios
# ============================================
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
VERSION=$(node -e "console.log(require('$PROJECT_DIR/package.json').version)")
IOS_DIR="$PROJECT_DIR/ios/App"
BUILD_DIR="$PROJECT_DIR/ios/build"
IPA_NAME="TinyDo-v$VERSION-ios.ipa"

echo "==================== TinyDo iOS Build v$VERSION ===================="
echo ""

# 1. 环境检查
if ! command -v xcodebuild &>/dev/null; then
  echo "❌ 未检测到 Xcode，请先安装 Xcode 及 Command Line Tools"
  exit 1
fi
if [ ! -d "$IOS_DIR/App.xcworkspace" ]; then
  echo "❌ 未找到 iOS 工程 (ios/App)"
  echo "   请先运行: npx cap add ios && npx cap sync ios"
  exit 1
fi

# 1. 构建前端
echo "[1/4] Building web assets..."
cd "$PROJECT_DIR"
npm run build

# 1.5 生成 iOS AppIcon（从 resources/icon.png 平铺白色去 alpha，与桌面图标一致）
echo "   Generating iOS AppIcon from desktop icon..."
bash "$SCRIPT_DIR/generate-ios-icon.sh"

# 2. 对齐 iOS 部署目标（cap add ios 模板默认 14.0，@capacitor/ios 8.x 要求 15.0+）
#    需要同时修正：
#    a) Podfile 的 platform（cap sync 触发 pod install 时校验）
#    b) Xcode 工程的 IPHONEOS_DEPLOYMENT_TARGET（编译时校验，模板 pbxproj 也是 14.0）
#    先从 @capacitor/ios 的 podspec 读取要求的部署目标。
get_required_deployment() {
  local podspec="$PROJECT_DIR/node_modules/@capacitor/ios/Capacitor.podspec"
  [ -f "$podspec" ] && sed -n "s/.*deployment_target *= *'\([0-9.]*\)'.*/\1/p" "$podspec" | head -1
}
REQUIRED_DEPLOYMENT=$(get_required_deployment)
if [ -z "$REQUIRED_DEPLOYMENT" ]; then
  echo "   ⚠️  未从 podspec 解析到部署目标，默认 15.0"
  REQUIRED_DEPLOYMENT="15.0"
fi

fix_podfile_platform() {
  local podfile="$IOS_DIR/Podfile"
  if [ ! -f "$podfile" ]; then
    return 0
  fi
  local current
  current=$(sed -n "s/.*platform :ios, *'\([0-9.]*\)'.*/\1/p" "$podfile" | head -1)
  if [ -z "$current" ]; then
    echo "   ⚠️  Podfile 未找到 platform 行，跳过对齐"
    return 0
  fi
  # 数值比较：当前版本低于要求则提升
  if awk -v c="$current" -v r="$REQUIRED_DEPLOYMENT" 'BEGIN { exit !(c < r) }'; then
    echo "   📈 iOS 部署目标: $current -> $REQUIRED_DEPLOYMENT（匹配 @capacitor/ios 要求）"
    sed -i.bak "s/platform :ios, *'[0-9.]*'/platform :ios, '$REQUIRED_DEPLOYMENT'/" "$podfile"
    rm -f "$podfile.bak"
  else
    echo "   ✅ Podfile 部署目标 $current 满足要求（>= $REQUIRED_DEPLOYMENT）"
  fi
}

# 3. 同步到 iOS 工程
echo "[2/4] Syncing to iOS project..."
fix_podfile_platform
npx cap sync ios

# 4. 编译原生工程（编译时不签名，编译后用 codesign CLI 手动 ad-hoc 签名）
#    注意（Xcode 26 / iOS SDK 26）：
#    - CODE_SIGNING_ALLOWED=NO 单独使用会报 "bundle format unrecognized"，
#      需要同时 VALIDATE_PRODUCT=NO 跳过产品校验。
#    - xcodebuild 禁止用 CODE_SIGN_IDENTITY="-" (ad-hoc) 构建 iOS，
#      报 "Ad Hoc code signing is not allowed with SDK"。
#    因此：xcodebuild 不签名编译 + codesign 命令手动 ad-hoc 签名（CLI 不受限）。
echo "[3/4] Building native app (unsigned)..."
rm -rf "$BUILD_DIR"
cd "$IOS_DIR"
xcodebuild -workspace App.xcworkspace -scheme App -configuration Release \
  -sdk iphoneos -derivedDataPath "$BUILD_DIR/derived" \
  CODE_SIGN_STYLE=Manual CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO \
  CODE_SIGN_IDENTITY="" VALIDATE_PRODUCT=NO \
  IPHONEOS_DEPLOYMENT_TARGET="$REQUIRED_DEPLOYMENT" \
  build 2>&1 | tail -15

APP_PATH="$BUILD_DIR/derived/Build/Products/Release-iphoneos/App.app"
if [ ! -d "$APP_PATH" ]; then
  echo "❌ 编译失败：未找到产物 $APP_PATH"
  exit 1
fi

# 5. 打包 .ipa（不签名）
#    实测教训：不要用 codesign ad-hoc 签名——Sideloadly 等工具对带
#    adhoc 签名的 ipa 会报 "Guru Meditation ... Invalid file"，
#    必须提供未签名包，由工具自行用 Apple ID 签名安装。
echo "[4/4] Packaging unsigned .ipa..."

rm -rf "$BUILD_DIR/ipa"
mkdir -p "$BUILD_DIR/ipa/Payload"
cp -R "$APP_PATH" "$BUILD_DIR/ipa/Payload/"
cd "$BUILD_DIR/ipa"
rm -f "$IPA_NAME"
# -y 保留符号链接（iOS framework 依赖）
zip -qry "$IPA_NAME" Payload
cd "$PROJECT_DIR"

# 复制到 release 目录
RELEASE_DIR="$PROJECT_DIR/release/v$VERSION"
mkdir -p "$RELEASE_DIR"
cp "$BUILD_DIR/ipa/$IPA_NAME" "$RELEASE_DIR/"

echo ""
echo "✅ iOS .ipa 构建完成（未签名，供侧载工具自行签名）:"
echo "   $RELEASE_DIR/$IPA_NAME"
echo ""
echo "安装方式（均无需开发者账号）："
echo "   1. Sideloadly → iPhone 连接电脑，拖入 .ipa，输入 Apple ID 签名安装（推荐）"
echo "   2. SideStore  → 在 SideStore 中导入 .ipa"
echo ""
echo "⚠️  免费 Apple ID 签名的应用每 7 天需要续签一次（Sideloadly 可自动续签）"
