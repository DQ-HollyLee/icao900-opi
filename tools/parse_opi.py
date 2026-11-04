# -*- coding: utf-8 -*-
"""把 OPI 资料（PDF 转出的 md）整理成题库 JSON。

输入：.cache/opi_raw.md
输出：.cache/opi_parsed.json  （topics + items，英文原文，未翻译）
      之后由 tools/build_opi.py 补中文翻译、生成音频清单，产出 app/assets/opi.json
"""
import io
import json
import os
import re

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(BASE, '.cache', 'opi_raw.md')

# 话题表（从原文标题核对得到；id 保持原文编号，顺序即学习顺序）
TOPICS = [
    ('6.1', '飞机与飞机系统', ''),
    ('6.1.1', '飞机机型', '6.1'),
    ('6.1.2', '驾驶舱', '6.1'),
    ('6.1.3', '飞行控制系统', '6.1'),
    ('6.1.4', '液压系统', '6.1'),
    ('6.1.5', '起落架', '6.1'),
    ('6.1.6', '电气系统', '6.1'),
    ('6.1.7', '发动机', '6.1'),
    ('6.1.8', '增压系统', '6.1'),
    ('6.1.9', '空调系统', '6.1'),
    ('6.1.10', '氧气系统', '6.1'),
    ('6.1.11', '通讯系统', '6.1'),
    ('6.1.12', '导航系统', '6.1'),
    ('6.1.13', '应急设备', '6.1'),
    ('6.1.14', '文件与手册', '6.1'),
    ('6.2', '飞行环境', ''),
    ('6.2.1', '天气', '6.2'),
    ('6.2.2', '风切变', '6.2'),
    ('6.2.3', '颠簸', '6.2'),
    ('6.2.4', '结冰', '6.2'),
    ('6.2.5', '侧风', '6.2'),
    ('6.2.6', '低能见度', '6.2'),
    ('6.2.7', '积雨云与雷暴', '6.2'),
    ('6.2.8', '雷击', '6.2'),
    ('6.2.9', '复杂机场', '6.2'),
    ('6.2.10', '短窄跑道', '6.2'),
    ('6.2.11', '机场安检和危险品', '6.2'),
    ('6.2.12', '鸟类威胁', '6.2'),
    ('6.2.13', '异物吸入', '6.2'),
    ('6.3', '飞行程序', ''),
    ('6.3.1', '飞行前准备', '6.3'),
    ('6.3.2', '地面相撞', '6.3'),
    ('6.3.3', '跑道入侵', '6.3'),
    ('6.3.4', '中断起飞', '6.3'),
    ('6.3.5', '紧急下降', '6.3'),
    ('6.3.6', '等待', '6.3'),
    ('6.3.7', '复飞', '6.3'),
    ('6.3.8', '紧急着陆', '6.3'),
    ('6.3.9', '紧急撤离', '6.3'),
    ('6.3.10', '流控', '6.3'),
    ('6.3.11', '延误', '6.3'),
    ('6.3.12', '备降', '6.3'),
    ('6.3.13', '失速', '6.3'),
    ('6.3.14', '飞错高度', '6.3'),
    ('6.3.15', '越障', '6.3'),
    ('6.3.16', '冲突飞机', '6.3'),
    ('6.4', '飞行相关人员', ''),
    ('6.4.1', 'Pilots 飞行员', '6.4'),
    ('6.4.2', 'Cabin Crew 空乘人员', '6.4'),
    ('6.4.3', 'Passengers 乘客', '6.4'),
    ('6.4.4', 'CRM 机组资源管理', '6.4'),
    ('6.4.5', 'Flight Training 飞行训练', '6.4'),
    ('6.4.6', 'Medical Emergency 医疗紧急情况', '6.4'),
    ('6.5', '常用缩略词', ''),
    ('6.5.1', 'ATIS', '6.5'),
    ('6.5.2', 'SOP', '6.5'),
    ('6.5.3', 'HUD', '6.5'),
    ('6.5.4', 'CVR', '6.5'),
    ('6.5.5', 'QAR', '6.5'),
    ('6.5.6', 'TCAS', '6.5'),
    ('6.5.7', 'CFIT', '6.5'),
    ('6.5.8', 'CDFA', '6.5'),
    ('6.5.9', 'RVSM', '6.5'),
    ('6.5.10', 'FCTM', '6.5'),
    ('6.5.11', 'CPDLC', '6.5'),
    ('6.5.12', 'RNP', '6.5'),
    ('6.6', '其他话题', ''),
    ('6.6.1', '常见问题', '6.6'),
    ('6.6.2', '遇险与紧急', '6.6'),
    ('6.6.3', '冒烟起火', '6.6'),
    ('6.6.4', '擦机尾 Tail Strike', '6.6'),
    ('6.6.5', '结构损坏', '6.6'),
    ('6.6.6', '仪表故障', '6.6'),
    ('6.6.7', '客航货航', '6.6'),
    ('6.6.8', '昼航夜航', '6.6'),
    ('6.6.9', '航线', '6.6'),
]

QSTART = re.compile(
    r'^(what|how|why|when|where|which|who|whose|do|does|did|is|are|was|were|can|could|'
    r'will|would|shall|should|have|has|had|may|might|must|if|please|tell|describe|compare|'
    r'in your opinion|do you|have you|is there|are there|what\'s|how\'s)\b', re.I)

HAN = re.compile(r'[\u4e00-\u9fa5]')


def clean_text(raw):
    s = raw
    s = re.sub(r'本内容是根据中飞院课程[^\n]*', '\n', s)
    s = re.sub(r'<!-- Page \d+ -->', '\n', s)
    s = re.sub(r'^\s*\d+\s*-->\s*$', '', s, flags=re.M)
    s = re.sub(r'^\s*(One|Two|Three|Four|Five|Six|Seven|Eight|Nine|Ten|Eleven|Twelve)\s+',
               ' ', s, flags=re.M)
    # 音标：/ˈsiːtɪd/、( /si:tbelt/ )
    s = re.sub(r'/[^/\n]{0,40}/', ' ', s)
    # 行内中文括号注释：（副翼）、（这 里是以防），整块去掉
    s = re.sub(r'[（(][^（()）]{0,30}[\u4e00-\u9fa5][^（()）]{0,30}[)）]', ' ', s)
    s = s.replace('\u3000', ' ')
    s = re.sub(r'[ \t]+', ' ', s)
    return s


def fix_spacing(text, vocab):
    """PDF 常把两个词粘在一起（aircraftand / canreceive），按词表拆开。"""
    out = []
    for w in text.split(' '):
        lw = w.lower().strip('.,;:!?')
        if len(lw) >= 8 and lw.isalpha() and lw not in vocab:
            best = None
            for i in range(2, len(lw) - 2):
                a, b = lw[:i], lw[i:]
                if a in vocab and b in vocab and len(b) >= 3:
                    best = (a, b)
                    break
            if best:
                head = w[:len(best[0])]
                tail = w[len(best[0]):]
                out.append(head)
                out.append(tail)
                continue
        out.append(w)
    return ' '.join(out)


def build_vocab(texts, extra_words):
    from collections import Counter
    c = Counter()
    for t in texts:
        for w in re.findall(r"[A-Za-z][A-Za-z'\-]*", t.lower()):
            c[w] += 1
    vocab = {w for w, n in c.items() if n >= 2}
    vocab |= set(extra_words)
    return vocab


def norm_en(s):
    s = s.replace('\u2019', "'").replace('\u2018', "'").replace('\u201c', '"').replace('\u201d', '"')
    s = s.replace('，', ', ').replace('。', '. ').replace('；', '; ').replace('：', ': ')
    s = s.replace('？', '?').replace('！', '!')
    s = re.sub(r'\s+([,.;:?!])', r'\1', s)
    s = re.sub(r'\s+', ' ', s).strip()
    s = re.sub(r'^[^A-Za-z"]+', '', s)
    if s and s[0].islower():
        s = s[0].upper() + s[1:]
    return s


QRE = re.compile(
    r'((?:What|What\'s|How|How\'s|Why|When|Where|Which|Who|Whose|Do|Does|'
    r'Did|Is|Are|Was|Were|Can|Could|Will|Would|Should|Shall|Have|Has|Had|If|Please|Tell|'
    r'Describe|Compare|In your opinion)\b[^?？.!]{4,240}?[?？])', re.I)

SENT_END = '.!?？"\u201d)'


def find_questions(t):
    """找疑问句。要求句首边界（避免把句中 what 当成新问题）。

    不能用"消费分隔符"的写法：finditer 不重叠，前一句吃掉的 ? 会让后一句失去边界。
    """
    out = []
    for m in QRE.finditer(t):
        s = m.start(1)
        k = s - 1
        while k >= 0 and t[k] in ' \n\r\t':
            k -= 1
        if k >= 0 and t[k] not in SENT_END and not ('\u4e00' <= t[k] <= '\u9fff'):
            continue
        out.append((s, m.end(1), m.group(1).strip()))
    return out


NUMWORD = re.compile(
    r'^(One|Two|Three|Four|Five|Six|Seven|Eight|Nine|Ten|Eleven|Twelve|Thirteen|Fourteen|'
    r'Fifteen|Sixteen|Seventeen|Eighteen|Nineteen|Twenty|Thirty|Forty|Fifty)\b[\s-]*', re.I)


def tidy_q(q):
    q = re.sub(r'[\u4e00-\u9fa5]+', ' ', q)
    q = NUMWORD.sub('', q)
    q = re.sub(r'\s+', ' ', q).strip()
    return norm_en(q)


def strip_zh(text):
    """去掉中文成分，只留英文。"""
    t = re.sub(r'[^。！？；]*[\u4e00-\u9fa5][^。！？；]*[。！？；]?', ' ', text)
    t = re.sub(r'[\u4e00-\u9fa5]+', ' ', t)
    return re.sub(r'\s+', ' ', t).strip()


def take_leading_zh(text, maxlen=60):
    """取开头那段中文（问题翻译），返回 (中文, 剩余文本)。"""
    m = re.match(r'\s*([^A-Za-z]{2,' + str(maxlen) + r'}?[？?])', text)
    if m and HAN.search(m.group(1)):
        return m.group(1).strip(), text[m.end():]
    return '', text


ABBR = ('e.g', 'i.e', 'u.s', 'mr', 'mrs', 'no', 'vs', 'approx', 'etc', 'dr', 'ft', 'min')


def sentences(t):
    """按句末标点切句。数字里的小数点、常见缩写不算句末。"""
    out, start = [], 0
    i, n = 0, len(t)
    while i < n:
        c = t[i]
        if c in '?？':
            out.append(t[start:i + 1])
            start = i + 1
            while start < n and t[start] in ' \n\r\t':
                start += 1
            i = start
            continue
        if c == '.' and i + 1 < n and t[i + 1] in ' \n\r\t':
            prev = t[i - 1] if i else ''
            low = t[max(0, i - 4):i].lower()
            if prev.isdigit() and i + 2 < n and t[i + 2].isdigit():
                pass                                # 3. 5 这种不算
            elif any(low.endswith(a) for a in ABBR):
                pass
            else:
                out.append(t[start:i + 1])
                start = i + 1
                while start < n and t[start] in ' \n\r\t':
                    start += 1
                i = start
                continue
        i += 1
    if start < n:
        out.append(t[start:])
    return [s.strip() for s in out if s.strip()]


def is_cn_sentence(s):
    return len(HAN.findall(s)) * 3 > len(re.findall(r'[A-Za-z]', s))


def qa_split(text):
    """一句一句读：问句开头新条目，陈述句并入上一题的答案。"""
    t = re.sub(r'\s+', ' ', text).strip()
    items = []
    for s in sentences(t):
        if s[-1] in '?？':
            if is_cn_sentence(s):
                cn = s.rstrip('？?').strip()
                if items and not items[-1]['cn'] and not items[-1]['a']:
                    items[-1]['cn'] = cn
                else:
                    items.append({'q': '', 'cn': cn, 'a': ''})
                continue
            wc = len(re.findall(r"[A-Za-z][A-Za-z'\-]*", s))
            if wc <= 3 and items and not items[-1]['a']:
                # "Why?" 这类追问并入上一题
                items[-1]['q'] = (items[-1]['q'] + ' ' + s).strip()
                continue
            items.append({'q': norm_en(s), 'cn': '', 'a': ''})
            continue
        if not items:
            items.append({'q': '', 'cn': '', 'a': ''})
        items[-1]['a'] = (items[-1]['a'] + ' ' + s).strip()
    for it in items:
        it['a'] = strip_zh(it['a'])
        it['cn'] = re.sub(r'\s+', ' ', it['cn']).strip()
    return items


def main():
    raw = io.open(RAW, encoding='utf-8').read()
    text = clean_text(raw)

    # 话题切分：找每个 id 第一次出现的位置（必须在行首或空白后）
    marks = []
    for tid, name, parent in TOPICS:
        if not parent:
            continue
        m = re.search(r'(?<![\d.])' + re.escape(tid) + r'\s', text)
        if m:
            marks.append((m.start(), tid))
    marks.sort()

    # 全局词表（含 900 句语料），用来拆粘连词
    d900 = json.load(io.open(os.path.join(BASE, '..', 'icao900-android', 'app', 'assets',
                                          'data.json'), encoding='utf-8'))
    extra = set()
    for it in d900['items']:
        extra |= set(re.findall(r"[a-z]+", it['en'].lower()))
    vocab = build_vocab([text], extra)

    topics = []
    for i, (pos, tid) in enumerate(marks):
        end = marks[i + 1][0] if i + 1 < len(marks) else len(text)
        body = text[pos:end]
        body = re.sub(r'^\s*' + re.escape(tid) + r'\s*', ' ', body)
        body = re.sub(r'^[^\s]*\s*', ' ', body)      # 去掉标题本身
        items = qa_split(body)
        name, parent = next((n, p) for t, n, p in TOPICS if t == tid)
        kept = []
        for it in items:
            it['q'] = tidy_q(fix_spacing(it['q'], vocab))
            it['a'] = norm_en(fix_spacing(it['a'], vocab))
            # 只保留"有英文问题 + 有答案"的条目：
            # 只有中文问题的、答案被上一题吃掉的，都是解析噪声
            if not it['q'] or len(it['a']) < 20:
                continue
            if len(it['q']) > 220 or len(re.findall(r'[A-Za-z]+', it['q'])) > 40:
                continue
            if not it['q'].endswith('?'):
                continue
            kept.append(it)
        if kept:
            topics.append({'id': tid, 'name': name, 'group': parent, 'items': kept})

    total = sum(len(t['items']) for t in topics)
    no_ans = sum(1 for t in topics for it in t['items'] if not it['a'])
    print('topics=%d items=%d no_answer=%d' % (len(topics), total, no_ans))
    for t in topics[:3]:
        print(t['id'], t['name'], len(t['items']))
        for it in t['items'][:2]:
            print('   Q:', it['q'][:90])
            print('   T:', it['cn'][:60])
            print('   A:', it['a'][:110])

    out = os.path.join(BASE, '.cache', 'opi_parsed.json')
    json.dump({'topics': topics}, io.open(out, 'w', encoding='utf-8'),
              ensure_ascii=False, indent=1)
    print('->', out)


if __name__ == '__main__':
    main()
