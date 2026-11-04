# -*- coding: utf-8 -*-
"""本地预览：把 app/assets 与 preview/ 合成到一个临时目录，起静态服务器。

  python tools/preview.py          # 起服务 http://127.0.0.1:8765
  python tools/preview.py --test   # 跑前端自测
  python tools/preview.py --shots  # 批量截图到 .cache/shots
"""
import json
import os
import shutil
import subprocess
import sys
import threading
import urllib.parse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ASSETS = os.path.join(BASE, 'app', 'assets')
PREVIEW = os.path.join(BASE, 'preview')
STAGE = os.path.join(BASE, '.cache', 'preview')
CHROME = r'C:\Program Files\Google\Chrome\Application\chrome.exe'
PORT = 8765


def stage():
    """把 app/assets 与 preview/ 覆盖式同步到暂存目录。

    这里刻意不做 shutil.rmtree：本机有安全钩子会拦批量删除，
    而覆盖复制已经能保证拿到最新文件（旧的多余文件无害）。
    """
    os.makedirs(STAGE, exist_ok=True)
    for name in os.listdir(ASSETS):
        src = os.path.join(ASSETS, name)
        dst = os.path.join(STAGE, name)
        if os.path.isdir(src):
            if name == 'audio':
                if not os.path.exists(dst):
                    os.symlink(src, dst, target_is_directory=True)
            else:
                shutil.copytree(src, dst, dirs_exist_ok=True)
        else:
            shutil.copyfile(src, dst)
    for name in os.listdir(PREVIEW):
        src = os.path.join(PREVIEW, name)
        dst = os.path.join(STAGE, name)
        if os.path.isdir(src):
            shutil.copytree(src, dst, dirs_exist_ok=True)
        else:
            shutil.copyfile(src, dst)


def serve():
    stage()
    handler = partial(SimpleHTTPRequestHandler, directory=STAGE)
    httpd = ThreadingHTTPServer(('127.0.0.1', PORT), handler)
    print(f'http://127.0.0.1:{PORT}/index.html')
    httpd.serve_forever()


def chrome(url, dst, w=412, h=880, budget=12000):
    subprocess.run([CHROME, '--headless=new', '--disable-gpu', '--hide-scrollbars',
                    f'--window-size={w},{h}', f'--virtual-time-budget={budget}',
                    f'--screenshot={dst}', url], capture_output=True)


def run_shots():
    out = os.path.join(BASE, '.cache', 'shots')
    os.makedirs(out, exist_ok=True)
    flip = ("var el=document.querySelector('.flip');el.style.transition='none';"
            "el.style.transform='rotateY(180deg)';el.classList.add('flipped');'ok'")
    seq = {
        '01_home': [['wait', 1200]],
        '01b_home_lv': [['wait', 1200], ['[data-htab="lv"]', 'click', 900]],
        '02_deck': [['wait', 1200], ['.ch-card', 'click', 1500]],
        '03_back': [['wait', 1200], ['.ch-card', 'click', 900], ['eval', flip, 900]],
        '04_rec': [['wait', 1200], ['.ch-card', 'click', 900], ['#btnRec', 'click', 700],
                   ['#btnRec', 'click', 1500]],
        '04b_toc': [['wait', 1200], ['.ch-card', 'click', 900], ['#btnToc', 'click', 800]],
        '05_exam': [['wait', 1200], ['[data-tab="exam"]', 'click', 1200]],
        '06_examrun': [['wait', 1200], ['[data-tab="exam"]', 'click', 800],
                       ['#btnStartExam', 'click', 1500]],
        '07_record': [['wait', 1200], ['[data-tab="record"]', 'click', 1000]],
        '08_settings': [['wait', 1200], ['[data-tab="settings"]', 'click', 1000]],
    }
    for name, steps in seq.items():
        url = (f'http://127.0.0.1:{PORT}/shoot.html?steps='
               + urllib.parse.quote(json.dumps(steps)))
        chrome(url, os.path.join(out, name + '.png'))
        print('shot', name)


def run_test():
    url = f'http://127.0.0.1:{PORT}/selftest.html'
    p = subprocess.run([CHROME, '--headless=new', '--disable-gpu', '--window-size=460,1000',
                        '--virtual-time-budget=25000', '--dump-dom', url],
                       capture_output=True, text=True)
    import re
    m = re.search(r'<pre id="out">(.*?)</pre>', p.stdout, re.S)
    print(re.sub(r'<[^>]*>', '', m.group(1)) if m else p.stdout[:500])


if __name__ == '__main__':
    mode = sys.argv[1] if len(sys.argv) > 1 else ''
    if mode == '--test':
        stage()
        threading.Thread(target=serve, daemon=True).start()
        import time
        time.sleep(1.5)
        run_test()
    elif mode == '--shots':
        stage()
        threading.Thread(target=serve, daemon=True).start()
        import time
        time.sleep(1.5)
        run_shots()
    else:
        serve()
