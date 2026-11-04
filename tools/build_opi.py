# -*- coding: utf-8 -*-
"""生成 app/assets/opi.json 与题目语音（edge-tts）。

输入：.cache/opi_parsed.json（parse_opi.py 产出）
输出：app/assets/opi.json
      app/assets/opi/<id>.mp3
"""
import asyncio
import io
import json
import os
import sys

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(BASE, '.cache')
ASSETS = os.path.join(BASE, 'app', 'assets')
OUT_AUDIO = os.path.join(ASSETS, 'opi')

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from opi_zh import OVERRIDES  # noqa: E402

GROUP_NAME = {
    '6.1': '飞机与飞机系统',
    '6.2': '飞行环境',
    '6.3': '飞行程序',
    '6.4': '飞行相关人员',
    '6.5': '常用缩略词',
    '6.6': '其他话题',
}


def apply_overrides(topics):
    """按 (话题 id, 片段) 匹配，改问句 / 补翻译 / 丢弃。"""
    used = [False] * len(OVERRIDES)
    for t in topics:
        kept = []
        for it in t['items']:
            drop = False
            for i, (tid, frag, newq, cn, is_drop) in enumerate(OVERRIDES):
                if tid != t['id'] or used[i]:
                    continue
                if frag not in it['q']:
                    continue
                used[i] = True
                if is_drop:
                    drop = True
                else:
                    if newq:
                        it['q'] = newq
                    if cn and not it['cn']:
                        it['cn'] = cn
                break
            if not drop:
                kept.append(it)
        t['items'] = kept
    missing = [OVERRIDES[i][1] for i, u in enumerate(used) if not u]
    if missing:
        print('  未被命中的修正规则:', missing)
    return topics


def main():
    d = json.load(io.open(os.path.join(CACHE, 'opi_parsed.json'), encoding='utf-8'))
    topics = apply_overrides(d['topics'])

    out_topics, items_flat = [], []
    for t in topics:
        items = []
        for i, it in enumerate(t['items'], 1):
            oid = t['id'].replace('.', '') + '-%02d' % i
            rec = {'n': oid, 'q': it['q'], 'cn': it['cn'], 'a': it['a'],
                   'au': 'opi/%s.mp3' % oid}
            items.append(rec)
            items_flat.append(rec)
        out_topics.append({'id': t['id'], 'name': t['name'],
                           'group': t['group'], 'items': items})

    data = {
        'title': 'PEPEC OPI 口语面试',
        'groups': [{'id': g, 'name': n} for g, n in GROUP_NAME.items()],
        'topics': out_topics,
        'count': len(items_flat),
    }
    os.makedirs(ASSETS, exist_ok=True)
    json.dump(data, io.open(os.path.join(ASSETS, 'opi.json'), 'w', encoding='utf-8'),
              ensure_ascii=False, separators=(',', ':'))
    print('topics=%d items=%d -> app/assets/opi.json' % (len(out_topics), len(items_flat)))

    no_cn = [x['n'] for x in items_flat if not x['cn']]
    print('缺翻译:', len(no_cn), no_cn[:5])

    os.makedirs(OUT_AUDIO, exist_ok=True)
    todo = [x for x in items_flat
            if not os.path.exists(os.path.join(OUT_AUDIO, x['n'] + '.mp3'))]
    print('待生成语音:', len(todo))
    if todo:
        asyncio.run(tts_all(todo))
    got = len([f for f in os.listdir(OUT_AUDIO) if f.endswith('.mp3')])
    print('音频文件:', got)


TTS_FIX = [
    (r'\bFL(\d)', r'flight level \1'),
    (r'\bATC\b', 'A T C'),
    (r'\bC919\b', 'C nine nineteen'),
    (r'\bA320\b', 'A three twenty'),
    (r'\bB737\b', 'B seven thirty seven'),
    (r'\bB747\b', 'B seven forty seven'),
    (r'\b42N\b', '42 north'),
]


async def tts_one(item, voice, sem):
    import edge_tts
    text = item['q']
    for pat, rep in TTS_FIX:
        import re
        text = re.sub(pat, rep, text)
    dst = os.path.join(OUT_AUDIO, item['n'] + '.mp3')
    async with sem:
        for attempt in range(3):
            try:
                c = edge_tts.Communicate(text, voice, rate='-6%')
                await c.save(dst)
                return
            except Exception as e:
                if attempt == 2:
                    print('TTS 失败', item['n'], e)
                await asyncio.sleep(1.5)


async def tts_all(items):
    sem = asyncio.Semaphore(8)
    await asyncio.gather(*[tts_one(x, 'en-US-AriaNeural', sem) for x in items])


if __name__ == '__main__':
    main()
