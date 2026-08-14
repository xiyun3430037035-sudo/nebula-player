# -*- coding: utf-8 -*-
"""应用图标:直接采用 mobile 的 launcher 图标(白圆角方块 + 蓝色双八分音符)。
源文件:mobile/android/app/src/main/res/mipmap-xxxhdpi/ic_launcher.png(192x192)。
用法:python tools/make_icon.py(需要 PIL)
"""
import os
from PIL import Image

SOURCE = os.path.join(
    os.path.dirname(__file__), '..', 'mobile', 'android', 'app', 'src', 'main',
    'res', 'mipmap-xxxhdpi', 'ic_launcher.png'
)
OUT_DIR = os.path.join(os.path.dirname(__file__), '..', 'build')
MASTER = 512  # 放大母版,再由它生成各尺寸,保证 256 不糊


def main():
    src = Image.open(SOURCE).convert('RGBA')
    # 裁掉四周透明边距(留 3% 呼吸),让图标瓦片占满,任务栏看起来不再偏小
    bbox = src.getbbox()
    pad = int(min(src.size) * 0.03)
    x0 = max(0, bbox[0] - pad)
    y0 = max(0, bbox[1] - pad)
    x1 = min(src.width, bbox[2] + pad)
    y1 = min(src.height, bbox[3] + pad)
    cropped = src.crop((x0, y0, x1, y1))
    master = cropped.resize((MASTER, MASTER), Image.LANCZOS)
    os.makedirs(OUT_DIR, exist_ok=True)
    png_path = os.path.join(OUT_DIR, 'icon.png')
    master.resize((256, 256), Image.LANCZOS).save(png_path)
    sizes = [256, 128, 64, 48, 32, 16]
    ico_path = os.path.join(OUT_DIR, 'icon.ico')
    master.save(ico_path, sizes=[(s, s) for s in sizes])
    print('OK', png_path, ico_path)


if __name__ == '__main__':
    main()
