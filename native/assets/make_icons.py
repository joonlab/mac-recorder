#!/usr/bin/env python3
"""GPT 이미지로 만든 정사각 아트워크(src/*.png)를 macOS 앱 아이콘 규격으로 다듬어 .icns 를 만든다.
macOS 규격: 1024 캔버스 안에 824px 둥근 사각형(연속 곡률, 슈퍼타원 근사) + 아래쪽 부드러운 그림자.
사용: python3 make_icons.py  → MacRecorder.icns, MacRecorderCapture.icns, ../../public/app-icon.png"""
import os, subprocess, tempfile
from PIL import Image, ImageDraw, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
SS = 4  # 슈퍼샘플링으로 가장자리를 매끄럽게

def squircle_mask(size, n=5.0):
    big = size * SS
    m = Image.new('L', (big, big), 0)
    pts = []
    import math
    for i in range(720):
        t = 2 * math.pi * i / 720
        c, s = math.cos(t), math.sin(t)
        x = (abs(c) ** (2 / n)) * (1 if c >= 0 else -1)
        y = (abs(s) ** (2 / n)) * (1 if s >= 0 else -1)
        pts.append(((x + 1) / 2 * (big - 1), (y + 1) / 2 * (big - 1)))
    ImageDraw.Draw(m).polygon(pts, fill=255)
    return m.resize((size, size), Image.LANCZOS)

def make(src, out_png):
    art = Image.open(os.path.join(HERE, 'src', src)).convert('RGB').resize((824, 824), Image.LANCZOS)
    mask = squircle_mask(824)
    canvas = Image.new('RGBA', (1024, 1024), (0, 0, 0, 0))
    shadow = Image.new('RGBA', (1024, 1024), (0, 0, 0, 0))
    sh = Image.new('RGBA', (824, 824), (0, 0, 0, 110))
    shadow.paste(sh, (100, 112), mask)
    shadow = shadow.filter(ImageFilter.GaussianBlur(14))
    canvas.alpha_composite(shadow)
    tile = art.convert('RGBA'); tile.putalpha(mask)
    canvas.alpha_composite(tile, (100, 100))
    # 가장자리 테두리 빛(어두운 배경·어두운 Dock 에서도 모양이 보이게) — macOS 기본 앱 아이콘과 같은 처리
    inner = mask.filter(ImageFilter.MinFilter(5))
    rim_a = Image.eval(Image.composite(mask, Image.new('L', mask.size, 0), Image.eval(inner, lambda v: 255 - v)), lambda v: v * 50 // 255)
    rim = Image.new('RGBA', (824, 824), (255, 255, 255, 0)); rim.putalpha(rim_a)
    canvas.alpha_composite(rim, (100, 100))
    canvas.save(out_png)
    return canvas

def icns(img, out):
    d = tempfile.mkdtemp(suffix='.iconset')
    for s in (16, 32, 128, 256, 512):
        img.resize((s, s), Image.LANCZOS).save(f'{d}/icon_{s}x{s}.png')
        img.resize((s * 2, s * 2), Image.LANCZOS).save(f'{d}/icon_{s}x{s}@2x.png')
    subprocess.run(['iconutil', '-c', 'icns', d, '-o', out], check=True)

main = make('main.png', os.path.join(HERE, 'icon_main_1024.png'))
cap = make('capture.png', os.path.join(HERE, 'icon_capture_1024.png'))
icns(main, os.path.join(HERE, 'MacRecorder.icns'))
icns(cap, os.path.join(HERE, 'MacRecorderCapture.icns'))
pub = os.path.join(HERE, '..', '..', 'public')
main.resize((256, 256), Image.LANCZOS).save(os.path.join(pub, 'app-icon.png'))
main.resize((180, 180), Image.LANCZOS).save(os.path.join(pub, 'apple-touch-icon.png'))
print('ok')
