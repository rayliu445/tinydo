#!/bin/bash
# ============================================
# TinyDo - iOS AppIcon 生成脚本
# 从桌面图标 resources/icon.png 生成 iOS AppIcon：
#   - 桌面图标按 macOS 网格留白（1024 画布上图形 824），iOS 需全出血 → 先裁掉留白
#   - iOS 图标不允许 alpha 通道，把剩余透明区域平铺到纯白背景
#   - 产出 1024x1024 RGB（无 alpha）
# 由于 ios/ 目录被 gitignore（cap add ios 本地生成），
# 每次构建前用本脚本从跟踪的 resources/icon.png 重新生成，
# 保证 iOS 图标与桌面端一致且可复现。
# 用法: bash scripts/generate-ios-icon.sh
# ============================================
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
SRC="$PROJECT_DIR/resources/icon.png"
OUT="$PROJECT_DIR/ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png"

if [ ! -f "$SRC" ]; then
  echo "❌ 未找到桌面图标源: $SRC"
  exit 1
fi

if ! command -v python3 &>/dev/null; then
  echo "❌ 未检测到 python3，无法生成 iOS 图标"
  exit 1
fi

if ! python3 -c "import PIL" &>/dev/null; then
  echo "   ⚠️  未安装 Pillow，尝试自动安装..."
  python3 -m pip install Pillow --quiet 2>/dev/null \
    || python3 -m pip install --user Pillow --quiet 2>/dev/null \
    || python3 -m pip install --break-system-packages Pillow --quiet 2>/dev/null \
    || {
      echo "❌ 未安装 Pillow 且自动安装失败，请先运行: pip3 install Pillow"
      exit 1
    }
  if ! python3 -c "import PIL" &>/dev/null; then
    echo "❌ Pillow 安装后仍不可用"
    exit 1
  fi
fi

python3 - "$SRC" "$OUT" <<'PY'
import sys
from PIL import Image

src_path, out_path = sys.argv[1], sys.argv[2]
src = Image.open(src_path).convert("RGBA")
# resources/icon.png 按 macOS 图标网格制作（图形本体 824，四周各 100px 透明留白），
# 而 iOS 图标必须全出血（系统自己套圆角，不允许留白/透明）：
# 先裁掉不透明区域之外的留白，再缩放到 1024，最后平铺到纯白背景去掉 alpha。
bbox = src.getbbox()
if bbox:
    src = src.crop(bbox)
if src.size != (1024, 1024):
    src = src.resize((1024, 1024), Image.LANCZOS)
bg = Image.new("RGBA", (1024, 1024), (255, 255, 255, 255))
out = Image.alpha_composite(bg, src).convert("RGB")
out.save(out_path)
print(f"✅ iOS AppIcon 生成完成: {out_path} ({out.size[0]}x{out.size[1]}, {out.mode})")
PY
