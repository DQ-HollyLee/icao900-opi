#!/usr/bin/env python3
# 重新生成 OPI 提问 TTS 音频：
#   女声（慢速）-> app/assets/opi_f/{n}.mp3（生成完成后由人工/脚本移到 opi/ 覆盖原速版）
#   男声（慢速）-> app/assets/opi_m/{n}.mp3（新增目录，供设置里切换）
# 题库文本取自 opi.json 每题的 q 字段；命名沿用原 {n}.mp3。
import json, os, asyncio, edge_tts

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OPI = os.path.join(ROOT, 'app', 'assets', 'opi')
F_DIR = os.path.join(ROOT, 'app', 'assets', 'opi_f')
M_DIR = os.path.join(ROOT, 'app', 'assets', 'opi_m')
os.makedirs(F_DIR, exist_ok=True)
os.makedirs(M_DIR, exist_ok=True)

F_VOICE = ''                  # 女声保持现有 opi/ 原速版本，不重新生成（用户确认 1.0 播放下刚好）
M_VOICE = 'en-US-GuyNeural'    # 男声
RATE = '+0%'                   # 原速：用户确认 1.0 播放下原速刚好，不放慢


def collect():
    d = json.load(open(os.path.join(ROOT, 'app', 'assets', 'opi.json'), encoding='utf-8'))
    items = []
    for t in d.get('topics', []):
        for it in t.get('items', []):
            items.append(it)
    return items


async def gen(text, voice, out):
    for attempt in range(4):
        try:
            comm = edge_tts.Communicate(text, voice, rate=RATE)
            await comm.save(out)
            if os.path.getsize(out) > 500:
                return True
        except Exception as e:
            if attempt == 0:
                print('  ! %s 失败: %s' % (os.path.basename(out), e))
        await asyncio.sleep(1.2)
    return False


async def main():
    items = collect()
    print('total questions:', len(items))
    f_ok = m_ok = 0
    for i, it in enumerate(items):
        n = it['n']
        text = (it.get('q') or '').strip()
        if not text:
            continue
        if F_VOICE:
            fout = os.path.join(F_DIR, n + '.mp3')
            if os.path.exists(fout) and os.path.getsize(fout) > 500:
                f_ok += 1
            elif await gen(text, F_VOICE, fout):
                f_ok += 1
        mout = os.path.join(M_DIR, n + '.mp3')
        if await gen(text, M_VOICE, mout):   # 始终重新生成，覆盖此前 -15% 残留
            m_ok += 1
        if (i + 1) % 25 == 0:
            print('  %d/%d  f=%d m=%d' % (i + 1, len(items), f_ok, m_ok))
    print('DONE  f_ok=%d  m_ok=%d  / %d' % (f_ok, m_ok, len(items)))
    # 女声全部成功才提示可覆盖；男声缺失不阻塞
    if f_ok == len(items):
        print('FEMALE_OK')  # 标记：opi_f 可安全覆盖到 opi/


if __name__ == '__main__':
    asyncio.run(main())
