#!/usr/bin/env python3
"""把 SVG 截成 PNG，给人眼自查用。不参与渲染，画图本身不需要它。

用法：
    python scripts/preview.py 角色.svg                  # 写出 角色.png，2 倍清晰度
    python scripts/preview.py 角色.svg 预览.png 3       # 指定输出和倍数（1–8）
    python scripts/preview.py 角色.svg --browser 路径    # 指定浏览器可执行文件

依赖 Playwright：pip install playwright
找浏览器的顺序：--browser 参数 → 环境变量 CHIBI_BROWSER → Playwright 自带的 Chromium
（python -m playwright install chromium）→ 本机的 Chrome / Edge / Chromium。
Windows、macOS、Linux 都按各自的常见安装位置找。
"""
import argparse
import os
import pathlib
import platform
import re
import shutil
import sys

INSTALL_HINT = """\
找不到能用的浏览器。任选一种：
  1. pip install playwright && python -m playwright install chromium
  2. 安装 Google Chrome、Microsoft Edge 或 Chromium
  3. 已经装了但在别的位置：用 --browser <可执行文件> 或设置环境变量 CHIBI_BROWSER
预览只是给人看的；不能截图时，直接用浏览器打开 SVG 检查也可以。"""


def candidates():
    """各平台常见的 Chrome / Edge / Chromium 位置。"""
    system = platform.system()
    found = []
    if system == 'Windows':
        roots = [os.environ.get(k) for k in ('PROGRAMFILES', 'PROGRAMFILES(X86)', 'LOCALAPPDATA')]
        rels = [r'Google\Chrome\Application\chrome.exe', r'Microsoft\Edge\Application\msedge.exe',
                r'Chromium\Application\chrome.exe']
        found += [os.path.join(r, rel) for r in roots if r for rel in rels]
    elif system == 'Darwin':
        for app in ('Google Chrome', 'Microsoft Edge', 'Chromium'):
            for base in ('/Applications', os.path.expanduser('~/Applications')):
                found.append(f'{base}/{app}.app/Contents/MacOS/{app}')
    names = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser',
             'microsoft-edge', 'microsoft-edge-stable', 'msedge', 'chrome']
    found += [p for p in (shutil.which(n) for n in names) if p]
    return found


def launch(pw, explicit):
    tried = []
    if explicit:
        if not pathlib.Path(explicit).exists():
            sys.exit(f'--browser / CHIBI_BROWSER 指向的文件不存在：{explicit}\n\n{INSTALL_HINT}')
        return pw.chromium.launch(executable_path=explicit)
    try:
        return pw.chromium.launch()          # Playwright 自带的 Chromium
    except Exception as e:                   # 没装自带浏览器时会报错，继续找本机的
        tried.append(f'Playwright 自带 Chromium：{str(e).splitlines()[0]}')
    for exe in candidates():
        if pathlib.Path(exe).exists():
            try:
                return pw.chromium.launch(executable_path=exe)
            except Exception as e:
                tried.append(f'{exe}：{str(e).splitlines()[0]}')
    sys.exit('\n'.join(['试过：', *('  ' + t for t in tried), '', INSTALL_HINT]))


def svg_size(svg):
    """取根 <svg> 的显示尺寸：先看 width/height，没有就用 viewBox。"""
    head = re.search(r'<svg\b[^>]*>', svg)
    head = head.group(0) if head else ''
    num = lambda k: (m := re.search(rf'\s{k}="([\d.]+)(px)?"', head)) and float(m.group(1))
    w, h = num('width'), num('height')
    vb = re.search(r'viewBox="([^"]+)"', head)
    if vb:
        _, _, vw, vh = (float(v) for v in re.split(r'[\s,]+', vb.group(1).strip()))
        if not w and not h: w, h = vw, vh
        elif not h: h = w * vh / vw
        elif not w: w = h * vw / vh
    return (w or 300, h or 150)


def main():
    ap = argparse.ArgumentParser(description='SVG → PNG 预览')
    ap.add_argument('svg')
    ap.add_argument('out', nargs='?')
    ap.add_argument('scale', nargs='?', type=float, default=2.0, help='清晰度倍数，默认 2')
    ap.add_argument('--browser', default=os.environ.get('CHIBI_BROWSER'))
    a = ap.parse_args()
    if not 0 < a.scale <= 8:
        sys.exit('scale 取 1–8 之间的数，比如 2')
    src = pathlib.Path(a.svg).resolve()
    out = pathlib.Path(a.out) if a.out else src.with_suffix('.png')
    svg = src.read_text(encoding='utf-8')
    w, h = svg_size(svg)
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        sys.exit('没有装 Playwright：pip install playwright\n\n' + INSTALL_HINT)
    with sync_playwright() as pw:
        b = launch(pw, a.browser)
        pg = b.new_page(viewport={'width': max(1, round(w)), 'height': max(1, round(h))},
                        device_scale_factor=a.scale)
        pg.set_content(f'<html><body style="margin:0">{svg}</body></html>')
        pg.query_selector('svg').screenshot(path=str(out))
        b.close()
    print(f'wrote {out}（{round(w * a.scale)}×{round(h * a.scale)}）')


if __name__ == '__main__':
    main()
