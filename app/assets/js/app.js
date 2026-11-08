/* app.js — ICAO 900 句学习器 UI */
(function () {
  'use strict';

  var B = window.ICAOBridge || null;
  var B2 = window.ICAOAsr || null;      // 本地 Qwen3-ASR（原生注入）
  var META = window.ICAOMeta || null;
  var A = window.Aviation;

  /* 原生注入的包版本号；浏览器预览时为 null */
  var VER = (function () {
    try { return META ? (META.version() || '') : ''; } catch (e) { return ''; }
  })();

  var K_PROG = 'icao900.progress';
  var K_EXAM = 'icao900.exams';
  var K_SET = 'icao900.settings';
  var K_POS = 'icao900.positions';   // 每个章节/分类上次学到第几句
  var K_LASTREC = 'icao900.lastrec'; // 最近一次录音的电平参数（排查"声音小"）
  var K_OFAV = 'opi900.fav';         // OPI 收藏 {卡号: 1}
  var K_OPASS = 'opi900.pass';       // OPI Pass 计数 {卡号: 次数}
  var K_OCHAT = 'opi900.chats';      // 模拟对话历史（只留总评/雷达图与最近5次的录音）

  var S = {
    data: null,
    items: [],
    byNum: {},
    chapters: [],
    progress: {},
    exams: [],
    settings: {
      asr: true, online: true, autoPlay: true, showCn: true, rate: 1, opiVoice: 'f',
      theme: 'auto',
      ai: false, aiBase: 'https://api.openai.com/v1', aiModel: 'whisper-1', aiKey: '',
      localAsr: false,
      chatBase: 'https://api.openai.com/v1', chatModel: 'gpt-4o-mini', chatKey: ''
    },
    homeTab: 'ch',
    positions: {},
    lastRec: null,
    localInfo: null,        // 本地模型的设备/下载状态
    localPct: 0,
    view: 'home',
    deck: null,
    exam: null,
    tab: 'home',
    audio: null,
    recAudio: null,
    turn: null,
    flipped: false,
    /* ---------------- OPI ---------------- */
    opi: null,              // opi.json：groups / topics / items
    ofav: {},
    opass: {},
    odeck: null,            // OPI 练习卡片视图
    ochat: null,            // 模拟对话会话
    chats: []
  };

  /* ------------------------------------------------ 存储 */
  function load(k, dft) {
    try {
      var s = localStorage.getItem(k);
      return s ? JSON.parse(s) : dft;
    } catch (e) { return dft; }
  }
  var warnedQuota = false;
  function save(k, v) {
    try {
      localStorage.setItem(k, JSON.stringify(v));
      return true;
    } catch (e) {
      /* 写满了：先扔掉老考试记录腾地方再试一次（不递归，失败就只提示一次） */
      if (k !== K_EXAM) {
        var recs = load(K_EXAM, []);
        if (recs.length > 5) {
          try {
            localStorage.setItem(K_EXAM, JSON.stringify(recs.slice(-5)));
            localStorage.setItem(k, JSON.stringify(v));
            return true;
          } catch (e2) {}
        }
      }
      if (!warnedQuota) {
        warnedQuota = true;
        try { toast('本机存储已满，新的记录可能存不下'); } catch (x) {}
      }
      return false;
    }
  }
  function saveProg() { save(K_PROG, S.progress); }
  function saveSet() { save(K_SET, S.settings); }

  /* ------------------------------------------------ 外观主题
     夜间模式：纯黑背景 + 白色文字。切换动画不靠逐元素 transition——
     app.css 里用 @property 把颜色变量注册成可插值的 <color>，改 data-theme
     时变量本身逐帧过渡，整页颜色（底色/文字/卡片/描边）一起渐变。 */
  function themePref() {
    var t = S.settings && S.settings.theme;
    return (t === 'dark' || t === 'light') ? t : 'auto';
  }
  function themeDark() {
    var p = themePref();
    if (p !== 'auto') return p === 'dark';
    try {
      return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
    } catch (e) { return false; }
  }
  function applyTheme() {
    var dark = themeDark();
    try { document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light'); } catch (e) {}
    /* 系统栏与 WebView 底色同步换色，避免夜间模式在状态栏/导航栏留白边 */
    try { if (window.ICAOTheme && ICAOTheme.setDark) ICAOTheme.setDark(dark); } catch (e) {}
    try {
      var m = document.querySelector('meta[name="theme-color"]');
      if (m) m.setAttribute('content', dark ? '#000000' : '#0b1f3a');
    } catch (e) {}
  }
  /* 跟随系统时，用户在系统里切深浅色要立刻响应 */
  function watchSystemTheme() {
    try {
      var mq = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)');
      if (!mq) return;
      var h = function () { if (themePref() === 'auto') applyTheme(); };
      if (mq.addEventListener) mq.addEventListener('change', h);
      else if (mq.addListener) mq.addListener(h);
    } catch (e) {}
  }

  /* 学习位置：每个章节/分类各自记住上次看到第几句 */
  function posGet(key) {
    if (!key) return 0;
    var v = S.positions[key];
    return typeof v === 'number' && v >= 0 ? v : 0;
  }
  function posSet(key, i) {
    if (!key) return;
    S.positions[key] = i;
    save(K_POS, S.positions);
  }

  function pget(n) { return S.progress[n] || null; }
  function pset(n, patch) {
    var cur = S.progress[n] || { st: '', hl: [], best: -1, ts: 0, tries: 0 };
    for (var k in patch) if (patch.hasOwnProperty(k)) cur[k] = patch[k];
    cur.ts = Date.now();
    S.progress[n] = cur;
    saveProg();
  }

  /* ------------------------------------------------ 工具 */
  function $(sel, root) { return (root || document).querySelector(sel); }
  function el(tag, cls, html) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }
  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  var toastTimer = null;
  function toast(msg) {
    var t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('show'); }, 1800);
  }
  function sheet(title, desc, okText, onOk, danger) {
    var mask = $('#sheet'), body = $('#sheetBody');
    body.innerHTML = '<h3>' + esc(title) + '</h3><p>' + desc + '</p>' +
      '<div class="btns"><button class="cancel">取消</button>' +
      '<button class="ok' + (danger ? ' danger' : '') + '">' + esc(okText) + '</button></div>';
    mask.classList.remove('hidden');
    $('.cancel', body).onclick = closeSheet;
    $('.ok', body).onclick = function () { closeSheet(); onOk && onOk(); };
  }
  function closeSheet() { $('#sheet').classList.add('hidden'); }

  function pct(a, b) { return b ? Math.round(a * 100 / b) : 0; }

  function lvName(lv) { return lv <= 3 ? 'LEVEL 3' : (lv >= 5 ? 'LEVEL 5' : 'LEVEL 4'); }
  function lvKey(lv) { return 'l' + (lv <= 3 ? 3 : (lv >= 5 ? 5 : 4)); }

  function opiAu(au) {
    /* 男声考官：把 opi/ 下的音频切换到 opi_m/ 下（同一文件名） */
    if (au && typeof au === 'string' && au.indexOf('opi/') === 0 && S.settings.opiVoice === 'm') {
      return 'opi_m/' + au.slice(4);
    }
    return au;
  }
  function audioUrl(it) {
    if (!it || !it.a) return '';
    return opiAu(it.a.indexOf('/') >= 0 ? it.a : 'audio/' + it.a);   // OPI 音频带 opi/ 前缀
  }

  function expectedMs(it) {
    // 以词数估算标准朗读时长（含自然停顿）
    return Math.max(1200, it.wl * 420 + 700);
  }

  /* ------------------------------------------------ 卡片渲染 */
  function chaptersOf(chId) {
    return S.items.filter(function (x) { return x.ch === chId; });
  }
  function chapterMeta(id) {
    for (var i = 0; i < S.chapters.length; i++) {
      if (S.chapters[i].id === id) return S.chapters[i];
    }
    return { id: id, name: '第 ' + id + ' 章', count: chaptersOf(id).length };
  }
  function knownList() {
    return S.items.filter(function (x) { var p = pget(x.n); return p && p.st === 'known'; });
  }
  function unknownList() {
    return S.items.filter(function (x) { var p = pget(x.n); return p && p.st === 'unknown'; });
  }

  /* ------------------------------------------------ 首页 */
  function levelList(lv) {
    return S.items.filter(function (x) { return x.lv === lv; });
  }
  function resumeText(key) {
    var i = posGet(key);
    return i > 0 ? '上次到第 ' + (i + 1) + ' 句' : '';
  }

  function renderHome() {
    var total = S.items.length;
    var kNow = knownList().length, uNow = unknownList().length;
    var l3 = levelList(3), l4 = levelList(4);
    var l5 = S.items.filter(function (x) { return x.lv >= 5; });

    var html = '<div class="page-head"><div><h1>ICAO 900句</h1>' +
      '<div class="sub">民航飞行员英语 · 精听、跟读与考试</div></div>' +
      '<div class="chip">' + (kNow + uNow) + '/' + total + ' 已练</div></div>';

    html += '<div class="hero"><div class="row">' +
      '<div><div class="big">' + kNow + '<small>句已掌握</small></div>' +
      '<div class="lbl">共 ' + total + ' 句 · ' + S.chapters.length + ' 个章节</div></div>' +
      '<div style="text-align:right"><div style="font-size:24px;font-weight:800">' + pct(kNow, total) + '%</div>' +
      '<div class="lbl">完成度</div></div></div>' +
      '<div class="bars"><div class="bar-item"><div class="t">已掌握 ' + kNow + '</div>' +
      '<div class="bar"><i style="width:' + pct(kNow, total) + '%"></i></div></div>' +
      '<div class="bar-item"><div class="t">未掌握 ' + uNow + '</div>' +
      '<div class="bar"><i style="width:' + pct(uNow, total) + '%;background:linear-gradient(90deg,#ffb37a,#ff7a6a)"></i></div></div></div></div>';

    /* 两种分类方式：按章节 / 按等级（3、4 级里不含专家级 5 级） */
    html += '<div class="seg" id="homeSeg">' +
      '<button data-htab="ch"' + (S.homeTab === 'lv' ? '' : ' class="on"') + '>按章节</button>' +
      '<button data-htab="lv"' + (S.homeTab === 'lv' ? ' class="on"' : '') + '>按等级</button></div>';

    if (S.homeTab !== 'lv') {
      html += '<div class="sec-title"><h2>章节练习</h2><span>按话题分类</span></div><div class="grid">';
      S.chapters.forEach(function (ch) {
        var list = chaptersOf(ch.id);
        var kn = list.filter(function (x) {
          var p = pget(x.n); return p && p.st === 'known';
        }).length;
        var pp = pct(kn, list.length);
        var dash = 2 * Math.PI * 12;
        var key = 'ch:' + ch.id;
        var rs = resumeText(key);
        html += '<button class="ch-card" data-ch="' + ch.id + '">' +
          '<div class="ring"><svg width="30" height="30"><circle cx="15" cy="15" r="12" fill="none" stroke="rgba(127,140,160,.18)" stroke-width="3"/>' +
          '<circle cx="15" cy="15" r="12" fill="none" stroke="#1b6ef3" stroke-width="3" stroke-linecap="round" ' +
          'stroke-dasharray="' + dash + '" stroke-dashoffset="' + (dash * (1 - pp / 100)) + '"/></svg>' +
          '<div class="v">' + pp + '</div></div>' +
          '<div class="idx">CHAPTER ' + ch.id + '</div>' +
          '<div class="nm">' + esc(ch.name) + '</div>' +
          '<div class="mt"><span>' + kn + '/' + ch.count + ' 掌握</span><span>' + (rs || ch.count + ' 句') + ' ›</span></div></button>';
      });
      html += '</div>';
    } else {
      html += '<div class="sec-title"><h2>按等级练习</h2><span>不含专家级</span></div>';
      var lvInfo = [
        { lv: 3, list: l3, name: 'LEVEL 3 · 标准通话', desc: '程式化短句 · 必须一个词都不错', tag: 'lv3' },
        { lv: 4, list: l4, name: 'LEVEL 4 · 描述表达', desc: '较长句子 · 90% 正确得满分', tag: 'lv4' }
      ];
      lvInfo.forEach(function (o) {
        var key = 'lv:' + o.lv;
        var kn = o.list.filter(function (x) {
          var p = pget(x.n); return p && p.st === 'known';
        }).length;
        var rs = resumeText(key);
        html += '<button class="lv-card" data-level="' + o.lv + '">' +
          '<div class="lh"><span class="tag ' + o.tag + '">' + o.name + '</span>' +
          '<span class="cnt">' + o.list.length + ' 句</span></div>' +
          '<div class="d">' + o.desc + '</div>' +
          '<div class="bar"><i style="width:' + pct(kn, o.list.length) + '%"></i></div>' +
          '<div class="f"><span>已掌握 ' + kn + ' 句</span><span>' + (rs ? rs + ' ›' : '开始 ›') + '</span></div></button>';
      });
      html += '<div class="lv-note">另有 <b>' + l5.length + '</b> 句专家级（LEVEL 5）为合成语音，' +
        '只作扩展听力，不进入考试与 3/4 级练习。' +
        '<button class="link" data-level="5">单独查看 ›</button></div>';
    }

    html += '<div class="sec-title"><h2>重点复习</h2><span>独立于章节与等级</span></div>' +
      '<div class="deck-row">' +
      '<button class="deck-btn known" data-deck="known"><div class="t">✓ 已掌握</div>' +
      '<div class="n">' + kNow + '</div><div class="h">复习已经拿下的句子</div></button>' +
      '<button class="deck-btn unknown" data-deck="unknown"><div class="t">! 未掌握</div>' +
      '<div class="n">' + uNow + '</div><div class="h">集中攻克薄弱句子</div></button></div>';

    /* --------------- OPI 口语练习（与 900 句之间用分割区隔开） ---------------
       卡片结构与上面的章节卡完全一致：环形进度 + 小号编号 + 名称 + 底部信息，
       不引入另一套配色/排版，避免观感割裂。 */
    var opiTopics = S.opi ? S.opi.topics.length : 0;
    var totalQ = S.opi ? S.opi.count : 0;
    var favN = Object.keys(S.ofav || {}).length;
    var passN = Object.keys(S.opass || {}).length;
    var dash = 2 * Math.PI * 12;
    var passPct = totalQ ? Math.min(100, Math.round(passN * 100 / totalQ)) : 0;
    var favPct = Math.min(100, Math.round(favN * 100 / 30));

    html += '<div class="opi-split"><span>OPI 口语部分</span></div>' +
      '<div class="sec-title"><h2>OPI 口语练习</h2><span>PEPEC 面试问答</span></div>' +
      '<div class="grid">' +

      '<button class="ch-card" data-opi="toc">' +
      '<div class="ring"><svg width="30" height="30"><circle cx="15" cy="15" r="12" fill="none" stroke="rgba(127,140,160,.18)" stroke-width="3"/>' +
      '<circle cx="15" cy="15" r="12" fill="none" stroke="#1b6ef3" stroke-width="3" stroke-linecap="round" ' +
      'stroke-dasharray="' + dash + '" stroke-dashoffset="' + (dash * (1 - passPct / 100)) + '"/></svg>' +
      '<div class="v">' + opiTopics + '</div></div>' +
      '<div class="idx">TOPICS</div>' +
      '<div class="nm">OPI 话题目录</div>' +
      '<div class="mt"><span>' + passN + '/' + totalQ + ' 已 Pass</span><span>开始 ›</span></div></button>' +

      '<button class="ch-card" data-opi="fav">' +
      '<div class="ring"><svg width="30" height="30"><circle cx="15" cy="15" r="12" fill="none" stroke="rgba(127,140,160,.18)" stroke-width="3"/>' +
      '<circle cx="15" cy="15" r="12" fill="none" stroke="#1b6ef3" stroke-width="3" stroke-linecap="round" stroke-dasharray="' + dash + '" ' +
      'stroke-dashoffset="' + (dash * (1 - favPct / 100)) + '"/></svg>' +
      '<div class="v">' + favN + '</div></div>' +
      '<div class="idx">FAVORITES</div>' +
      '<div class="nm">OPI 收藏夹</div>' +
      '<div class="mt"><span>' + (S.opi ? S.opi.groups.length : 0) + ' 大类 · 按话题</span><span>查看 ›</span></div></button></div>';

    render(html);
    $('#app').onclick = function (e) {
      var t = e.target.closest('[data-htab]');
      if (t) { S.homeTab = t.getAttribute('data-htab'); renderHome(); return; }

      var b = e.target.closest('[data-ch]');
      if (b) {
        var id = +b.getAttribute('data-ch');
        var list = chaptersOf(id);
        openDeck({ nums: list.map(function (x) { return x.n; }),
          title: chapterMeta(id).name, sub: 'CHAPTER ' + id,
          kind: 'chapter', key: 'ch:' + id });
        return;
      }
      var lb = e.target.closest('[data-level]');
      if (lb) {
        var lv = +lb.getAttribute('data-level');
        var arr = levelList(lv);
        if (!arr.length) { toast('这个等级还没有句子'); return; }
        openDeck({ nums: arr.map(function (x) { return x.n; }),
          title: lvName(lv) + ' 句子', sub: lvName(lv) + ' · ' + arr.length + ' 句',
          kind: 'level', key: 'lv:' + lv });
        return;
      }
      var d = e.target.closest('[data-deck]');
      if (d) {
        var kind = d.getAttribute('data-deck');
        var lst = kind === 'known' ? knownList() : unknownList();
        if (!lst.length) { toast(kind === 'known' ? '还没有已掌握的句子' : '还没有未掌握的句子'); return; }
        openDeck({ nums: lst.map(function (x) { return x.n; }),
          title: kind === 'known' ? '已掌握' : '未掌握',
          sub: kind === 'known' ? 'MASTERED' : 'TO REVIEW',
          kind: kind, key: 'list:' + kind });
        return;
      }
      var ob = e.target.closest('[data-opi]');
      if (ob) {
        var ov = ob.getAttribute('data-opi');
        if (!S.opi) { toast('OPI 数据加载中，稍后再试'); return; }
        if (ov === 'toc') renderOpiToc();
        else if (ov === 'fav') renderOpiFav();
      }
    };
  }

  /* ------------------------------------------------ 播放器 */
  function openDeck(deck) {
    S.deck = deck;
    if (typeof deck.i !== 'number') {
      var saved = posGet(deck.key);
      deck.i = Math.min(saved, Math.max(0, deck.nums.length - 1));
    }
    S.ctx = 'deck';
    S.view = 'deck';
    $('#app').classList.add('hide-tabbar');
    $('#tabbar').classList.add('hidden');
    renderDeck();
  }

  function closeDeck() {
    abortTurn();
    if (S.deck && S.deck.key) posSet(S.deck.key, S.deck.i);
    stopPlay(); stopRecAudio();
    S.deck = null;
    S.view = 'home';
    $('#app').classList.remove('hide-tabbar');
    $('#tabbar').classList.remove('hidden');
    renderHome();
  }

  /* 翻面统一入口：除 transform 外同步 .flipped 类，
   * 靠 CSS 把不可见那一面设为 pointer-events:none ——
   * Android WebView 里 backface-visibility:hidden 不参与点击命中测试，
   * 不这么做的话点背面的单词会打到正面中央的播放键上。 */
  function setFlip(on, animate) {
    S.flipped = !!on;
    var flip = $('#flip');
    if (!flip) return;
    flip.classList.toggle('flipped', S.flipped);
    flip.style.transition = animate === false
      ? 'none' : 'transform .42s cubic-bezier(.22,.9,.28,1)';
    flip.style.transform = 'rotateY(' + (S.flipped ? 180 : 0) + 'deg)';
  }

  function curItem() {
    if (!S.deck) return null;
    return S.byNum[S.deck.nums[S.deck.i]];
  }

  function renderDeck() {
    var it = curItem();
    if (!it) return closeDeck();
    var n = S.deck.nums.length, i = S.deck.i;
    var p = pget(it.n) || {};
    var hl = p.hl || [];
    var words = it.en.split(/\s+/);
    var enHtml = words.map(function (w, k) {
      return '<span class="w' + (hl.indexOf(k) >= 0 ? ' hl' : '') + '" data-i="' + k + '">' + esc(w) + '</span>';
    }).join(' ');

    var html = '<div class="player">' +
      '<div class="p-bar">' +
      '<button class="back" id="btnBack"><svg viewBox="0 0 24 24"><path d="M15.4 3.4 7.8 11a1.4 1.4 0 0 0 0 2l7.6 7.6 1.4-1.4L9.6 12l7.2-7.2z"/></svg></button>' +
      '<div class="mid"><div class="t">' + esc(S.deck.title) + '</div>' +
      '<div class="s">' + (i + 1) + ' / ' + n + ' · No.' + it.n +
      ' · <span class="lv-tag ' + lvKey(it.lv) + '">' + lvName(it.lv) + '</span></div></div>' +
      '<button class="toc-btn" id="btnToc" aria-label="目录">' +
      '<svg viewBox="0 0 24 24"><path d="M4 6h2v2H4zm4 0h12v2H8zM4 11h2v2H4zm4 0h12v2H8zM4 16h2v2H4zm4 0h12v2H8z"/></svg>目录</button></div>';

    html += '<div class="deck-wrap"><div class="flip" id="flip">' +
      '<div class="face front"><div class="front-in">' +
      '<div class="top"><span>LISTEN</span><span>' + (it.tts ? '合成语音' : '真人录音') + '</span></div>' +
      '<div class="playwrap"><div class="playing-halo" id="halo"></div>' +
      '<button class="playbtn" id="btnPlay"><svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg></button></div>' +
      '<div class="wave" id="wave">' + new Array(22).join('<i></i>') + '</div>' +
      '<div class="bottom">左右滑动卡片翻面</div>' +
      '</div></div>' +
      '<div class="face back"><div class="back-in">' +
      '<div class="hint"><span>TEXT · 点击单词可高亮</span>' +
      '<span class="hint-r">No.' + it.n +
      '<button class="mini-play" id="btnPlayBack" aria-label="播放">' +
      '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg></button></span></div>' +
      '<div class="en" id="enText"><div class="en-in">' + enHtml + '</div></div>' +
      (S.settings.showCn !== false ? '<div class="cn"><span class="tag">中文</span>' + esc(it.cn) + '</div>' : '') +
      '</div></div></div></div>';

    html += '<div class="pager"><button id="btnPrev"' + (i === 0 ? ' disabled' : '') + '>' +
      '<svg viewBox="0 0 24 24"><path d="M15.4 3.4 7.8 11a1.4 1.4 0 0 0 0 2l7.6 7.6 1.4-1.4L9.6 12l7.2-7.2z"/></svg></button>' +
      '<div class="dots"><i style="width:' + pct(i + 1, n) + '%"></i></div>' +
      '<button id="btnNext"' + (i === n - 1 ? ' disabled' : '') + '>' +
      '<svg viewBox="0 0 24 24"><path d="M8.6 20.6 16.2 13a1.4 1.4 0 0 0 0-2L8.6 3.4 7.2 4.8 14.4 12l-7.2 7.2z"/></svg></button></div>';

    html += '<div class="rec-zone"><div class="rec-line">' +
      '<button class="rec-btn" id="btnRec"><svg viewBox="0 0 24 24"><path d="M12 3a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3zm7 9a7 7 0 0 1-6 6.93V21h-2v-2.07A7 7 0 0 1 5 12h2a5 5 0 0 0 10 0z"/></svg></button>' +
      '<div class="rec-meta"><div class="t" id="recTitle">点击开始朗读</div>' +
      '<div class="d" id="recDesc">练习只录音，回放对比原声</div>' +
      '<div class="level-meter" id="meter">' + new Array(24).join('<i></i>') + '</div></div>' +
      '<div class="rec-actions"><button class="mini ghost" id="btnPlayRec" disabled>' +
      '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>回放</button></div></div></div>';

    html += '<div class="mastery"><button class="m-btn known" id="btnKnown">' +
      '<svg viewBox="0 0 24 24"><path d="M9.5 17.6 4.4 12.5l1.4-1.4 3.7 3.7 8.7-8.7 1.4 1.4z"/></svg>已掌握</button>' +
      '<button class="m-btn unknown" id="btnUnknown">' +
      '<svg viewBox="0 0 24 24"><path d="M12 2 1 21h22zm0 5.5 6.9 11.5H5.1zM11 10h2v5h-2zm0 6h2v2h-2z"/></svg>未掌握</button></div></div>';

    /* 目录：整章的句子一览，点一下直接跳 */
    var tocItems = S.deck.nums.map(function (num, k) {
      var x = S.byNum[num];
      var st = (pget(num) || {}).st || '';
      return '<button class="toc-item' + (k === i ? ' on' : '') + '" data-jump="' + k + '">' +
        '<span class="no">' + (k + 1) + '</span>' +
        '<span class="tx"><b>No.' + num + '</b>' + esc(x.en.slice(0, 34)) + (x.en.length > 34 ? '…' : '') + '</span>' +
        '<span class="dot ' + st + '"></span></button>';
    }).join('');
    html += '<div class="toc-wrap hidden" id="tocWrap"><div class="toc-mask" id="tocMask"></div>' +
      '<div class="toc"><div class="toc-head"><b>目录</b><span>' + n + ' 句 · 点击跳转</span>' +
      '<button class="toc-x" id="tocClose">✕</button></div>' +
      '<div class="toc-list" id="tocList">' + tocItems + '</div></div></div>';

    render(html, true);
    bindDeck(it);
    updateMastery(it);
    if (S.deck.key) posSet(S.deck.key, i);
    if (S.settings.autoPlay && it.a) setTimeout(function () { playAudio(); }, 260);
  }

  function updateMastery(it) {
    var p = pget(it.n) || {};
    var bk = $('#btnKnown'), bu = $('#btnUnknown');
    if (!bk) return;
    var k = p.st === 'known', u = p.st === 'unknown';
    bk.classList.toggle('on', k);
    bu.classList.toggle('on', u);
    bk.classList.toggle('dim', u);
    bu.classList.toggle('dim', k);
    bk.innerHTML = (k ? '<svg viewBox="0 0 24 24"><path d="M9.5 17.6 4.4 12.5l1.4-1.4 3.7 3.7 8.7-8.7 1.4 1.4z"/></svg>已掌握' : '<svg viewBox="0 0 24 24"><path d="M9.5 17.6 4.4 12.5l1.4-1.4 3.7 3.7 8.7-8.7 1.4 1.4z"/></svg>标记已掌握');
    bu.innerHTML = (u ? '<svg viewBox="0 0 24 24"><path d="M12 2 1 21h22zm0 5.5 6.9 11.5H5.1zM11 10h2v5h-2zm0 6h2v2h-2z"/></svg>未掌握' : '<svg viewBox="0 0 24 24"><path d="M12 2 1 21h22zm0 5.5 6.9 11.5H5.1zM11 10h2v5h-2zm0 6h2v2h-2z"/></svg>标记未掌握');
  }

  function render(html, keepTabbar) {
    var app = $('#app');
    app.innerHTML = html;
    if (!keepTabbar) app.classList.remove('hide-tabbar');
  }

  /* ------------------------------------------------ 卡片交互 */
  function bindDeck(it) {
    $('#btnBack').onclick = closeDeck;
    $('#btnPrev').onclick = function () { jump(-1); };
    $('#btnNext').onclick = function () { jump(1); };

    var flip = $('#flip');
    setFlip(false, false);

    var sx = 0, sy = 0, dx = 0, dragging = false, decided = null, w = 0;
    flip.addEventListener('pointerdown', function (e) {
      if (e.target.closest('#btnPlay') || e.target.closest('.w')) return;
      dragging = true; decided = null; dx = 0;
      sx = e.clientX; sy = e.clientY; w = flip.offsetWidth || 320;
      flip.style.transition = 'none';
    });
    flip.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      dx = e.clientX - sx;
      var dy = e.clientY - sy;
      if (decided === null) {
        if (Math.abs(dx) > 8 || Math.abs(dy) > 8) decided = Math.abs(dx) > Math.abs(dy) ? 'h' : 'v';
      }
      if (decided === 'h') {
        var base = S.flipped ? 180 : 0;
        var add = (dx / w) * 150;
        var ang = base + add;
        ang = Math.max(-1, Math.min(181, ang));
        flip.style.transform = 'rotateY(' + ang + 'deg)';
      }
    });
    function endDrag() {
      if (!dragging) return;
      dragging = false;
      if (decided === 'h' && Math.abs(dx) > w * 0.14) {
        setFlip(!S.flipped, true);
      } else {
        setFlip(S.flipped, true);
      }
    }
    flip.addEventListener('pointerup', endDrag);
    flip.addEventListener('pointercancel', endDrag);
    flip.addEventListener('pointerleave', function () { if (dragging) endDrag(); });

    // 点击单词高亮
    $('#enText').addEventListener('click', function (e) {
      var sp = e.target.closest('.w');
      if (!sp) return;
      var k = +sp.getAttribute('data-i');
      var p = pget(it.n) || { hl: [] };
      var hl = (p.hl || []).slice();
      var idx = hl.indexOf(k);
      if (idx >= 0) hl.splice(idx, 1); else hl.push(k);
      hl.sort(function (a, b) { return a - b; });
      sp.classList.toggle('hl');
      pset(it.n, { hl: hl });
    });

    $('#btnPlay').onclick = function (e) { e.stopPropagation(); playAudio(); };
    var pb = $('#btnPlayBack');
    if (pb) pb.onclick = function (e) {
      e.stopPropagation();
      if (S.audio) stopPlay(); else playAudio();   // 背面小喇叭：播放/停止
    };

    $('#btnRec').onclick = function () {
      if (S.turn && S.turn.recording) stopTurn(); else startTurn();
    };
    $('#btnPlayRec').onclick = function () { playRec(); };

    $('#btnToc').onclick = function () { openToc(); };
    $('#tocClose').onclick = closeToc;
    $('#tocMask').onclick = closeToc;
    $('#tocList').onclick = function (e) {
      var b = e.target.closest('[data-jump]');
      if (!b) return;
      closeToc();
      jumpTo(+b.getAttribute('data-jump'));
    };

    $('#btnKnown').onclick = function () {
      pset(it.n, { st: pget(it.n) && pget(it.n).st === 'known' ? '' : 'known' });
      updateMastery(it);
      toast(pget(it.n).st === 'known' ? '已加入「已掌握」' : '已取消标记');
      renderHomeCache();
    };
    $('#btnUnknown').onclick = function () {
      pset(it.n, { st: pget(it.n) && pget(it.n).st === 'unknown' ? '' : 'unknown' });
      updateMastery(it);
      toast(pget(it.n).st === 'unknown' ? '已加入「未掌握」' : '已取消标记');
      renderHomeCache();
    };
  }

  var homeSig = '';
  function renderHomeCache() { homeSig = ''; }

  function jump(d) { jumpTo(S.deck.i + d); }

  function jumpTo(ni) {
    if (!S.deck || ni < 0 || ni >= S.deck.nums.length) return;
    stopPlay(); stopRecAudio(); resetTurn();
    S.deck.i = ni;
    S.flipped = false;
    renderDeck();
  }

  function openToc() {
    var w = $('#tocWrap');
    if (!w) return;
    w.classList.remove('hidden');
    var on = $('#tocList .toc-item.on');
    if (on && on.scrollIntoView) on.scrollIntoView({ block: 'center' });
  }
  function closeToc() {
    var w = $('#tocWrap');
    if (w) w.classList.add('hidden');
  }

  /* ------------------------------------------------ 音频播放 */
  /* 释放一个 Audio：只 pause+置 null 不会回收解码缓冲，长时间练习几百句会越积越多 */
  function releaseAudio(a) {
    if (!a) return;
    try { a.pause(); } catch (e) {}
    try { a.onended = a.onerror = null; a.removeAttribute('src'); a.load(); } catch (e) {}
  }

  function stopPlay() {
    if (S.audio) { releaseAudio(S.audio); S.audio = null; }
    var b = $('#btnPlay'), w = $('#wave'), h = $('#halo');
    if (b) b.classList.remove('playing');
    if (w) w.classList.remove('on');
    if (h) h.style.transform = 'scale(1)';
  }

  function playAudio(cb) {
    /* 用 ctxItem() 而不是 curItem()：OPI 卡片/模拟对话不在 S.deck 里，
       取 900 句当前条目会得到 null，表现为"点了播放没声音"。 */
    var it = ctxItem();
    if (!it || !it.a) { toast('该句暂无音频'); return; }
    stopPlay();
    var a = new Audio(audioUrl(it));
    S.audio = a;
    a.playbackRate = S.settings.rate || 1;
    var b = $('#btnPlay'), w = $('#wave'), h = $('#halo');
    if (b) { b.classList.add('playing'); b.innerHTML = '<svg viewBox="0 0 24 24"><path d="M7 5h4v14H7zm6 0h4v14h-4z"/></svg>'; }
    if (w) w.classList.add('on');
    var bars = w ? w.children : [];
    var t0 = Date.now(), raf = null;
    function tick() {
      var level = 0.35 + 0.65 * Math.abs(Math.sin((Date.now() - t0) / 190));
      for (var i = 0; i < bars.length; i++) {
        var v = level * (0.4 + Math.abs(Math.sin((Date.now() - t0) / (260 + i * 23) + i)));
        bars[i].style.height = (6 + v * 18) + 'px';
      }
      if (h) h.style.transform = 'scale(' + (1 + level * 0.16) + ')';
      raf = requestAnimationFrame(tick);
    }
    tick();
    function done() {
      stopPlay();
      cancelAnimationFrame(raf);
      if (cb) cb();
    }
    a.onended = done;
    a.onerror = function () { toast('音频播放失败'); done(); };
    a.play().catch(function () { toast('请先点击页面再播放'); done(); });
  }

  function stopRecAudio() {
    if (S.recAudio) { releaseAudio(S.recAudio); S.recAudio = null; }
  }
  function playRec() {
    var t = S.turn;
    if (!t || !t.rec || !t.rec.url) { toast('还没有录音'); return; }
    stopRecAudio();
    var a = new Audio(t.rec.url);
    S.recAudio = a;
    a.onended = function () { if (S.recAudio === a) stopRecAudio(); };
    a.onerror = function () { toast('回放失败'); };
    a.play().catch(function () { toast('回放失败'); });
  }

  /* ------------------------------------------------ 录音 / 评分 */
  function ctxItem() {
    if (S.ctx === 'exam' && S.exam) {
      var g = S.exam.groups[S.exam.gi];
      return S.byNum[g.nums[S.exam.qi]];
    }
    if ((S.ctx === 'opi' || S.ctx === 'opichat') ) return opiCtxItem();
    return curItem();
  }

  /* 把还在进行的录音收掉。切页/退考试/换句时必须调用：
     否则原生会一直录到 20 秒上限，而下次点录音时原生还在录，
     那一轮会被丢掉（表现：点了没反应、或录成了上一段）。 */
  function abortTurn() {
    var t = S.turn;
    if (!t) return;
    if (t.iv) { clearInterval(t.iv); t.iv = 0; }
    if (t.recording && B && B.cancelTurn) { try { B.cancelTurn(); } catch (e) {} }
    S.turn = null;
  }

  function resetTurn() {
    abortTurn();
    var box = $('#scoreBox');
    if (box) { box.className = 'score-box'; box.innerHTML = ''; }
    var bt = $('#recTitle'), bd = $('#recDesc');
    if (bt) bt.textContent = '点击开始朗读';
    if (bd) bd.textContent = S.ctx === 'exam' ? '凭听力复述，录完自动判分' : '练习只录音，回放对比原声';
    var rp = $('#btnPlayRec'), sc = $('#btnScore'), rb = $('#btnRec');
    if (rp) rp.disabled = true;
    if (sc) sc.disabled = true;
    if (rb) { rb.classList.remove('recording'); rb.disabled = false; }
    var m = $('#meter');
    if (m) for (var i = 0; i < m.children.length; i++) {
      m.children[i].style.height = '3px'; m.children[i].style.opacity = '.35';
    }
  }

  function startTurn() {
    var it = ctxItem();
    if (!it) return;
    resetTurn();
    if (!B) {
      S.turn = { recording: true, ctx: S.ctx, demo: true, t0: Date.now() };
      $('#btnRec').classList.add('recording');
      $('#recTitle').textContent = '正在录音…';
      $('#recDesc').textContent = '（预览模式）';
      var m = $('#meter');
      var iv = setInterval(function () {
        for (var i = 0; i < m.children.length; i++) {
          m.children[i].style.height = (3 + Math.random() * 19) + 'px';
          m.children[i].style.opacity = 0.35 + Math.random() * 0.6;
        }
      }, 90);
      S.turn.iv = iv;
      return;
    }
    stopPlay();
    S.turn = { recording: true, ctx: S.ctx, rec: null, asr: null, t0: Date.now() };
    $('#btnRec').classList.add('recording');
    var chatTurn = (S.ctx === 'opichat');
    var manualStop = chatTurn || (S.ctx === 'opi');   // 模拟对话与 OPI 练习均手动停止，说完自己点第二次
    $('#recTitle').textContent = chatTurn ? '正在作答…' : '正在录音…';
    $('#recDesc').textContent = chatTurn
      ? '说完请再点一次麦克风，结束并交给考官评分'
      : (S.ctx === 'opi' ? '说完请再点一次麦克风结束' : '读完会自动停下，也可以再点一次结束');
    try {
      if (B.setAutoStop) B.setAutoStop(!manualStop);   // 仅 900 句练习与考试自动收
      if (B.setClip) {
        var clip = '';
        if (S.ctx === 'exam' && S.exam) {
          clip = 'exam_' + S.exam.id + '_' + S.exam.gi + '_' + S.exam.qi;
        } else if (S.ctx === 'opichat' && S.ochat) {
          clip = 'opic_' + S.ochat.id + '_' + S.ochat.i;   // 模拟对话录音，按会话+题号存
        }
        B.setClip(clip);
      }
      /* 练习模式不需要识别（考官是你自己），只录音；考试才走识别 */
      var useLocal = S.ctx === 'exam' && localReady();
      if (B.setAsrEnabled) B.setAsrEnabled(S.ctx === 'exam' && !useLocal);
      B.startTurn(expectedMs(it));
    } catch (e) { toast('录音启动失败'); }
  }

  function stopTurn() {
    var t = S.turn;
    if (!t) return;
    var it = ctxItem();
    if (t.demo) {
      clearInterval(t.iv);
      var rbtn = $('#btnRec');
      if (rbtn) rbtn.classList.remove('recording');
      S.turn = { ctx: t.ctx, rec: { url: 'rec/demo.wav', ms: 2400, voicedMs: 2000 },
                 asr: { ok: true, text: it ? it.en : '' }, demo: true };
      if (S.ctx === 'opichat' && S.ochat) { chatTranscribe(); return; }
      finalizeTurn();
      return;
    }
    t.recording = false;
    $('#btnRec').classList.remove('recording');
    $('#recTitle').textContent = S.ctx === 'opichat' ? '录音完成，准备交给考官…' : '识别中…';
    try { B.stopTurn(); } catch (e) {}
  }

  /* 记下最近一次录音的电平参数：用来判断"声音小"出在采集、后处理还是回放。
     inPeakDb 是归一化前的峰值；gainDb 是因为采集电平低而补的增益。
     gainDb 接近 +38 dB 说明这台机器的麦克风给到 App 的信号本身就很小。 */
  function rememberRec(rec) {
    if (!rec || typeof rec.inPeakDb !== 'number') return;
    S.lastRec = {
      at: Date.now(), ms: rec.ms, src: rec.src || '', rate: rec.rate || 0,
      inPeakDb: rec.inPeakDb, gainDb: rec.gainDb,
      outPeakDb: rec.outPeakDb, rmsDb: rec.rmsDb
    };
    try { localStorage.setItem(K_LASTREC, JSON.stringify(S.lastRec)); } catch (e) {}
  }

  function recDiag(rec) {
    if (!rec || typeof rec.outPeakDb !== 'number') return '';
    var g = rec.gainDb || 0;
    return '峰值 ' + rec.outPeakDb.toFixed(1) + ' dB · 增益 ' + (g >= 0 ? '+' : '') + g.toFixed(1) + ' dB';
  }

  function finalizeTurn() {
    var t = S.turn, it = ctxItem();
    if (!t || !t.rec || !it) return;
    /* 录音可能是自动停的（静音 1.2s / 20s 上限），这里必须把"正在录音"的标记清掉，
       否则按钮还是红的，用户下一次点会发 stopTurn，把刚录的这段当空气丢掉。 */
    t.recording = false;
    var rb0 = $('#btnRec');
    if (rb0) rb0.classList.remove('recording');
    var rp = $('#btnPlayRec');
    if (rp) rp.disabled = !t.rec.url;
    var secs = (t.rec.ms / 1000).toFixed(1) + 's';
    if (S.ctx !== 'exam') {
      /* 练习模式：取消自动评分，只保留回放，自己对比原声 */
      var dg = recDiag(t.rec);
      $('#recTitle').textContent = '录音完成';
      $('#recDesc').textContent = secs + (dg ? ' · ' + dg : ' · 回放对比原声');
      return;
    }
    if (t.asr && t.asr.ok) {
      $('#recTitle').textContent = '评分结果';
      $('#recDesc').textContent = secs + ' · ' + (t.asr.local
        ? '本地 Qwen3-ASR 转写后按 ICAO 规则比对'
        : (t.asr.ai ? 'AI 转写后按 ICAO 规则比对' : '已按 ICAO 发音规则比对'));
      doScore();
    } else {
      $('#recTitle').textContent = '录音完成';
      $('#recDesc').textContent = secs + ' · ' + ((t.asr && t.asr.msg) || '没有识别结果');
      doScore();     // 考试：录音即落库，没有识别结果就留待人工判分
    }
  }

  function doScore() {
    var it = ctxItem(), t = S.turn;
    if (!it || !t || !t.rec) { toast('请先录音'); return; }
    var alts = [];
    if (S.settings.asr === false) t.asr = null;
    if (t.asr && t.asr.ok) {
      if (t.asr.alts && t.asr.alts.length) alts = t.asr.alts.slice(0);
      else if (t.asr.text) alts = [t.asr.text];
      alts = alts.filter(function (x, i) { return x && x.trim() && alts.indexOf(x) === i; });
    }
    var g = S.exam ? S.exam.groups[S.exam.gi] : null;
    var answer = { n: it.n, audio: (t.rec && t.rec.url) || '', ai: !!(t.asr && t.asr.ai) };

    if (alts.length) {
      var res = A.evaluateBest(it, alts);
      res.recognized = alts[0];
      showScore(it, res);
      t.res = res;
      answer.score = res.score;
      answer.acc = res.acc;
      answer.rec = alts[0];
      answer.auto = true;
    } else {
      /* 没有识别结果就不给分，交卷后人工判 */
      answer.score = undefined;
      answer.acc = null;
      answer.rec = '';
      answer.auto = false;
      resetTurn();
      toast('没有识别结果，此题交卷后按录音人工判分');
    }
    if (g) g.answers[S.exam.qi] = answer;
    var nb = $('#btnNextQ');
    if (nb) nb.disabled = false;
    var rb = $('#btnRec');
    if (rb) rb.disabled = true;
  }

  function showScore(it, res) {
    var box = $('#scoreBox');
    if (!box) return;
    var cls = res.score === 1 ? 's1' : (res.score === 0.5 ? 's05' : 's0');
    var label = res.score === 1 ? '通过' : (res.score === 0.5 ? '基本通过' : '未通过');
    var rule = it.lv <= 3
      ? 'LEVEL 3 · 一个词都不能错（含冠词介词）'
      : 'LEVEL 4 · ≥90% 得 1 分，≥60% 得 0.5 分';

    var diff = '';
    if (res.detail) {
      diff = res.detail.map(function (d) {
        var c = d.ok >= 1 ? 'ok' : (d.ok > 0 ? 'par' : (d.got ? 'bad' : 'miss'));
        return '<span class="' + c + '">' + esc(d.w) + '</span>';
      }).join(' ');
    }
    box.innerHTML =
      '<div class="score-top"><div class="score-num ' + cls + '">' + (res.score === 0.5 ? '0.5' : res.score) + '</div>' +
      '<div class="score-txt"><b>' + label + ' · 准确率 ' + Math.round(res.acc * 100) + '%</b><br>' + rule +
      (res.acoustic ? ' · 离线近似（未取得语音识别结果）' : '') + '</div></div>' +
      (res.acoustic ? '' : (res.lowConf ? '<div class="conf-hint">识别把握不大（可能没听清），这个分数仅供参考，建议重录一次</div>' : '')) +
      (diff ? '<div class="wdiff">' + diff + '</div>' : '') +
      (res.recognized ? '<div class="wdiff" style="margin-top:6px;max-height:56px">识别：' + esc(res.recognized) + '</div>' : '');
    box.classList.add('show');
  }

  /* ------------------------------------------------ 原生回调 */
  window.Host = window.Host || {};
  var N = window.Host;
  N.onTurnStart = function () {
    if (!S.turn) S.turn = {};
    S.turn.recording = true;
  };
  N.onLevel = function (v) {
    var m = $('#meter');
    if (!m) return;
    var bars = m.children, k = Math.round(Math.max(0, Math.min(1, v)) * bars.length);
    for (var i = 0; i < bars.length; i++) {
      bars[i].style.height = (i < k ? 4 + Math.random() * 16 + v * 8 : 3) + 'px';
      bars[i].style.opacity = i < k ? 0.9 : 0.35;
    }
  };
  N.onRecord = function (o) {
    if (!S.turn) S.turn = {};
    if (!o.url) {
      /* 没录到（设备失败 / 页面切走 / 中途被打断）：复位并明确提示，
         否则会一直停在"识别中…" */
      var why = o.err || '没有录到声音';
      resetTurn();
      toast(why + '，请重试');
      return;
    }
    S.turn.rec = { url: o.url, ms: o.ms, voicedMs: o.voicedMs,
                   inPeakDb: o.inPeakDb, outPeakDb: o.outPeakDb, rmsDb: o.rmsDb,
                   gainDb: o.gainDb, src: o.src, rate: o.rate };
    rememberRec(S.turn.rec);
    if (S.asrProbe) {
      if (S.probeTarget === 'local' && localUsable()) requestLocal();
      else if (aiReady()) requestAi();
      return;
    }   // 识别自检
    if (S.ctx === 'opichat' && S.ochat) { chatTranscribe(); return; }   // 模拟对话：转写后交给考官评分
    if (S.turn.asr) { finalizeTurn(); return; }
    if (S.ctx === 'exam' && localReady()) { requestLocal(); return; }
    if (S.ctx === 'exam' && aiReady()) { requestAi(); return; }
    if (S.ctx === 'exam') setTimeout(fallbackCheck, 4700);
    else finalizeTurn();                        // 练习：录完就结束，不算分
  };
  N.onAsr = function (o) {
    if (S.asrProbe) { probeDone(o); return; }   // 设置页"测试识别"
    if (!S.turn) S.turn = {};
    S.turn.asr = o;
    if (!o.ok) S.lastAsrMsg = o.msg || '识别失败';
    if (S.turn.rec) finalizeTurn();
  };
  /* ---------------- 本地 Qwen3-ASR 的回调 ---------------- */
  N.onLocalAsr = function (o) {
    if (S.asrProbe) { probeDone(o); return; }
    if (S.ctx === 'opichat' && S.ochat) { chatAsrDone(o); return; }
    if (!S.turn) S.turn = {};
    S.turn.localPending = false;
    S.turn.asr = {
      ok: !!o.ok,
      text: o.text || '',
      alts: (o.ok && o.text) ? [o.text] : [],
      conf: -1, ai: false, local: true,
      ms: o.ms || 0,
      msg: o.msg || ''
    };
    if (!o.ok) S.lastAsrMsg = o.msg || '本地识别失败';
    if (S.turn.rec) finalizeTurn();
  };
  N.onAsrReady = function (o) {
    if (o && typeof o === 'object') S.localInfo = o;
    if (S.view === 'settings') renderSettings();
  };
  N.onAsrProgress = function (o) {
    if (!o || !o.total) return;
    S.localPct = Math.min(100, Math.round(o.done * 100 / o.total));
    var t = $('#dlTitle'), bar = $('.dlbar i');
    if (t) t.textContent = '模型下载 ' + (o.done / 1048576).toFixed(0) + ' / ' +
      (o.total / 1048576).toFixed(0) + ' MB（' + S.localPct + '%）';
    if (bar) bar.style.width = S.localPct + '%';
    if (S.localPct >= 100) setTimeout(function () { syncLocal(); if (S.view === 'settings') renderSettings(); }, 800);
  };
  N.onAsrStatus = function (o) {
    if (o && o.msg) toast(o.msg);
  };
  N.onAiAsr = function (o) {
    if (S.asrProbe) { probeDone(o); return; }
    if (S.ctx === 'opichat' && S.ochat) { chatAsrDone(o); return; }
    if (!S.turn) S.turn = {};
    /* 慢网络下上一题的转写可能晚到：回传里有录音文件名，对不上就丢掉，
       否则会把上一题的文本算到这一题头上。 */
    if (o.name && S.turn.aiName && o.name !== S.turn.aiName) return;
    S.turn.aiPending = false;
    S.turn.asr = {
      ok: !!o.ok,
      text: o.text || '',
      alts: (o.ok && o.text) ? [o.text] : [],
      conf: -1, ai: true,
      msg: o.msg || ''
    };
    if (!o.ok) S.lastAsrMsg = o.msg || 'AI 识别失败';
    if (S.turn.rec) finalizeTurn();
  };
  /* 原生那边把录音打断了（切后台、来电、麦克风被抢）：复位界面，别停在"录音中" */
  N.onTurnAbort = function (msg) {
    if (!S.turn) return;
    resetTurn();
    if (msg) toast(msg);
  };

  function probeDone(o) {
    S.asrProbe = false;
    S.lastAsrMsg = o.ok
      ? ('识别成功：' + (o.text || '').slice(0, 40))
      : (o.msg || '识别失败');
    toast(o.ok ? ('识别到：' + o.text) : ('识别失败：' + (o.msg || '未知原因')));
    if (S.view === 'settings') renderSettings();
  }

  /* AI 转写是否可用（开关 + 三项配置齐全） */
  function aiReady() {
    var st = S.settings;
    return !!(B && B.aiTranscribe && st.ai && st.aiKey && st.aiBase && st.aiModel);
  }

  /* ------------------------------------------------ 本地离线识别（Qwen3-ASR） */

  /* 拉一次设备和模型状态（原生侧会统计内存/存储/已下载字节） */
  function syncLocal() {
    if (!B2 || !B2.info) return null;
    try {
      var s = JSON.parse(B2.info());
      if (s && typeof s === 'object') S.localInfo = s;
    } catch (e) {}
    /* 模型被删掉但开关还开着：自动关掉，免得考试时才发现没模型 */
    if (S.localInfo && !S.localInfo.modelReady && S.settings.localAsr) {
      S.settings.localAsr = false;
      saveSet();
    }
    return S.localInfo;
  }

  function localUsable() {
    return !!(B2 && S.localInfo && S.localInfo.modelReady && S.localInfo.ok);
  }

  function localReady() {
    return !!(S.settings.localAsr && localUsable());
  }

  /* 录音存盘后交给本地模型转写；结果走 Host.onLocalAsr */
  function requestLocal() {
    var t = S.turn;
    if (!t || !t.rec || !t.rec.url) return;
    t.localPending = true;
    t.asr = null;
    var bt = $('#recTitle'), bd = $('#recDesc');
    if (bt) bt.textContent = '本地模型转写中…';
    if (bd) bd.textContent = 'Qwen3-ASR-0.6B 离线识别，首次要加载模型，约 5~10 秒';
    try {
      B2.transcribe(t.rec.url);
    } catch (e) {
      t.localPending = false;
      t.asr = { ok: false, msg: '本地识别调用失败' };
      finalizeTurn();
      return;
    }
    setTimeout(function () {
      if (S.turn === t && t.localPending) {
        t.localPending = false;
        t.asr = { ok: false, msg: '本地识别超时（100 秒）' };
        finalizeTurn();
      }
    }, 100000);
  }

  /* 设置页：本地模型的开关 + 下载 + 设备门槛提示 */
  function localGroupHtml() {
    var li = S.localInfo;
    if (!B2 || !li) {
      return '<div class="set-group"><div class="set-row"><div class="g">' +
        '<div class="t">本地离线识别</div><div class="d">当前版本没有内置本地识别组件。</div>' +
        '</div></div></div>';
    }
    var ready = !!li.modelReady;
    var canRun = !!li.ok;
    var mb = function (b) { return (b / 1048576).toFixed(0); };
    var got = (li.modelBytes || 0) + (li.mmprojBytes || 0);
    var need = (li.modelTotal || 0) + (li.mmprojTotal || 0);
    var pct = need ? Math.min(100, Math.round(got * 100 / need)) : 0;

    var html = '<div class="set-group">' +
      '<div class="set-row"><div class="g"><div class="t">本地离线识别（Qwen3-ASR-0.6B）</div>' +
      '<div class="d">录音在本机转文字再判分，不联网、不花 API 费用。模型 1.0GB，' +
      '需要 <b>arm64 芯片 + 4GB 以上内存（建议 8GB）+ 2GB 空闲存储</b>，' +
      '转写一句约 3~10 秒，低端机会明显更慢。</div></div>' +
      '<div class="switch' + (S.settings.localAsr ? ' on' : '') + '" data-tog="localAsr"></div></div>' +

      '<div class="set-row"><div class="g"><div class="d">' +
      '设备：' + esc(li.device || '未知') + ' · ' + esc(li.abi || '') + ' · ' + (li.cores || 0) + ' 核<br>' +
      '内存 ' + Math.round((li.totalMb || 0) / 1024 * 10) / 10 + ' GB（可用 ' +
      Math.round((li.availMb || 0) / 1024 * 10) / 10 + ' GB） · 存储剩余 ' +
      Math.round((li.freeDiskMb || 0) / 1024 * 10) / 10 + ' GB' +
      '</div></div></div>';

    if (!canRun && li.reason) {
      html += '<div class="set-row" style="border:0"><div class="g"><div class="d" style="color:var(--red)">' +
        esc(li.reason) + '。这台机器跑不动本地模型，请用系统识别或 AI 识别。</div></div></div>';
    } else if (ready) {
      html += '<div class="set-row" style="border:0"><div class="g"><div class="d" style="color:var(--green)">' +
        '模型已就绪（' + mb(got) + ' MB）</div></div></div>' +
        '<div class="set-row" style="border:0"><button class="mini" id="btnTestLocal">测试本地识别</button>' +
        '<button class="mini ghost" id="btnDelModel">删除模型</button>' +
        '<span class="set-tip">删了不影响考试成绩，录音都还在</span></div>';
    } else {
      html += '<div class="set-row"><div class="g"><div class="t" id="dlTitle" style="font-size:12px">' +
        '模型下载 ' + mb(got) + ' / ' + mb(need) + ' MB' + (S.localPct ? '（' + S.localPct + '%）' : '') + '</div>' +
        '<div class="dlbar"><i style="width:' + pct + '%"></i></div></div></div>' +
        '<div class="set-row" style="border:0"><button class="mini" id="btnDlModel">下载模型（1.0GB）</button>' +
        (li.downloading ? '<button class="mini ghost" id="btnCancelDl">暂停</button>' : '') +
        '<span class="set-tip">建议连 WiFi，支持断点续传</span></div>';
    }
    return html + '</div>';
  }

  function startLocalDownload() {
    if (!B2 || !B2.download) return;
    toast('开始下载，约 1.0GB，请连 WiFi');
    try { B2.download(); } catch (e) { toast('下载启动失败'); }
    S.localPct = 0;
    renderSettings();
  }

  /* 录音存盘后上传给 AI 转写；结果走 Host.onAiAsr */
  function requestAi() {
    var t = S.turn;
    if (!t || !t.rec || !t.rec.url) return;
    t.aiPending = true;
    t.asr = null;
    t.aiName = String(t.rec.url).split('/').pop();   // 结果回来时用它核对是不是这道题
    var bt = $('#recTitle'), bd = $('#recDesc');
    if (bt) bt.textContent = 'AI 识别中…';
    if (bd) bd.textContent = '上传录音转写（' + S.settings.aiModel + '），稍等';
    try {
      B.aiTranscribe(t.rec.url);
    } catch (e) {
      t.aiPending = false;
      t.asr = { ok: false, msg: 'AI 识别调用失败' };
      finalizeTurn();
      return;
    }
    setTimeout(function () {
      if (S.turn === t && t.aiPending) {
        t.aiPending = false;
        t.asr = { ok: false, msg: 'AI 识别超时（60 秒）' };
        finalizeTurn();
      }
    }, 60000);
  }
  function fallbackCheck() {
    if (!S.turn || !S.turn.rec || S.turn.asr || S.turn.aiPending) return;
    S.turn.asr = { ok: false, msg: '语音识别没有返回结果，交卷后可按录音人工判分' };
    finalizeTurn();
  }
  N.onError = function (msg) {
    $('#btnRec') && $('#btnRec').classList.remove('recording');
    if (S.turn) {
      /* 刚开始录就报错（权限/设备初始化失败）：直接复位，别让界面停在"录音中" */
      var failedStart = S.turn.recording && !S.turn.rec;
      S.turn.recording = false;
      if (failedStart) resetTurn();
    }
    toast(msg || '出错了');
  };
  N.onPermission = function (granted) {
    if (!granted) toast('需要麦克风权限才能录音');
  };

  /* ------------------------------------------------ 组卷考试 */
  function shuffle(a) {
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1)); var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }
  /* 句子词数（用于分级抽题） */
  function wordCount(it) {
    var m = String(it.en || '').match(/[A-Za-z0-9'’\-]+/g);
    return m ? m.length : 0;
  }

  /* 按权重不放回抽取；weightFn 返回相对权重 */
  function pickWeighted(list, n, weightFn) {
    var pool = list.slice(), out = [];
    while (out.length < n && pool.length) {
      var total = 0, i;
      for (i = 0; i < pool.length; i++) total += Math.max(0, weightFn(pool[i]));
      var pick = pool.length - 1;
      if (total > 0) {
        var r = Math.random() * total, acc = 0;
        for (i = 0; i < pool.length; i++) {
          acc += Math.max(0, weightFn(pool[i]));
          if (r <= acc) { pick = i; break; }
        }
      } else {
        pick = Math.floor(Math.random() * pool.length);
      }
      out.push(pool[pick]);
      pool.splice(pick, 1);
    }
    return out;
  }

  function pickN(list, n) {
    var pool = shuffle(list.slice());
    return pool.slice(0, Math.min(n, pool.length));
  }

  function renderExam() {
    var html = '<div class="page-head"><div><h1>组卷考试</h1>' +
      '<div class="sub">按 PEPEC 组题规则随机抽题</div></div></div>' +
      '<div class="exam-hero"><h3>模拟考试</h3>' +
      '<p>2 组三级题组（每组 4 句，共 8 句）+ 1 组四级题组（4 句），共 3 组。</p>' +
      '<ul class="exam-rules">' +
      '<li>题库只取<b>有真人录音</b>的 3/4 级句子，专家级（L5）不参与</li>' +
      '<li>三级句：一个词都不能错，全对得 1 分，否则 0 分</li>' +
      '<li>四级句：≥90% 得 1 分，60%~90% 得 0.5 分，&lt;60% 得 0 分</li>' +
      '<li>每组满分 4 分，<b>任意一组低于 3 分即判为不通过</b></li>' +
      '<li>每题只能听一遍，每组仅有 1 次重听机会</li>' +
      '<li>录音全部保存，交卷后可听原声、我的录音并人工改判</li></ul>' +
      '<button class="btn-primary" id="btnStartExam">开始考试</button></div>';

    /* OPI 模拟对话属于口试考试，入口跟组卷放一起（与 .lv-card 同族样式） */
    html += '<div class="sec-title"><h2>OPI 模拟对话</h2><span>口试实战演练</span></div>' +
      '<button class="lv-card" id="btnGoChat">' +
      '<div class="lh"><span class="tag lv4">OPI · ORAL</span>' +
      '<span class="cnt">3~4 话题 · ≤15 问</span></div>' +
      '<div class="d">AI 考官从题库随机抽题提问，逐题从发音、结构、词汇、流畅、理解、应对' +
      '六个方面打分（2~5 分），全部答完给出答题记录、文字总评与雷达图。</div>' +
      '<div class="f"><span>已演练 ' + S.chats.length + ' 次</span><span>开始演练 ›</span></div></button>';

    var recs = S.exams.slice().reverse();
    html += '<div class="sec-title"><h2>最近考试</h2><span>' + recs.length + ' 次记录</span></div>';
    if (!recs.length) {
      html += '<div class="empty">还没有考试记录，先来一次模拟吧</div>';
    } else {
      recs.slice(0, 5).forEach(function (r) {
        html += '<div class="row-item" data-exam="' + r.id + '">' +
          '<div class="dot" style="background:' + (r.pass ? 'var(--green)' : 'var(--red)') + '"></div>' +
          '<div class="g"><div class="t1">' + (r.pass ? '通过' : '未通过') + ' · ' + r.total.toFixed(1) + ' 分</div>' +
          '<div class="t2">' + fmtDate(r.ts) + ' · ' + r.groups.map(function (g) { return g.score + '/4'; }).join(' · ') + '</div></div>' +
          '<div style="color:var(--ink3);font-size:16px">›</div></div>';
      });
    }
    render(html);
    $('#btnStartExam').onclick = startExam;
    $('#btnGoChat').onclick = renderOpiChatHome;
    $('#app').onclick = function (e) {
      var r = e.target.closest('[data-exam]');
      if (r) showExamRecord(r.getAttribute('data-exam'));
    };
  }

  function fmtDate(ts) {
    var d = new Date(ts);
    function p(n) { return n < 10 ? '0' + n : n; }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  function startExam() {
    abortTurn();
    /* 上次中途弃考的录音不会有人清理（只有交卷才 prune），开场顺手清一次 */
    if (B && B.pruneExamAudio) {
      try {
        B.pruneExamAudio(S.exams.slice(-10).map(function (r) { return r.id; }).join(','));
      } catch (e) {}
    }
    /* 只从有真人录音的句子里抽：这批就是 ICAO 3/4 级的题库；
     * 合成音的那部分是专家级（L5），不参与考试 */
    var real = S.items.filter(function (x) { return !x.tts; });
    var l3 = real.filter(function (x) { return x.lv === 3; });
    var l4 = real.filter(function (x) { return x.lv === 4; });

    /* 第一组：短的三级句（一般不超过 7 个词），等概率抽 */
    var shortPool = l3.filter(function (x) { return wordCount(x) <= 7; });
    if (shortPool.length < 4) shortPool = l3.slice();
    var g1 = pickWeighted(shortPool, 4, function () { return 1; });

    /* 第二组：全部三级句都可能出现，但越长（越难）概率越高
     * 权重 = (词数-5)^2 + 1 → 4~5 词:1，6 词:2，7 词:5，8 词:10，9+ 词:17 */
    var usedG1 = {};
    g1.forEach(function (x) { usedG1[x.n] = 1; });
    var longPool = l3.filter(function (x) { return !usedG1[x.n]; });
    var g2 = pickWeighted(longPool, 4, function (x) {
      var w = wordCount(x);
      return Math.pow(Math.max(0, w - 5), 2) + 1;
    });

    /* 第三组：四级句，等概率 */
    var g3 = pickWeighted(l4, 4, function () { return 1; });

    /* 题库异常时别硬开考：组不满 4 题会让"每组 3 分达标"变得不公平 */
    if (g1.length < 4 || g2.length < 4 || g3.length < 4) {
      toast('题库数量不足，暂时无法组卷');
      return;
    }
    S.exam = {
      id: 'e' + Date.now(),
      ts: Date.now(),
      gi: 0,
      qi: 0,
      groups: [
        { lv: 3, name: '三级题组 A', nums: g1.map(function (x) { return x.n; }), answers: [], replayLeft: 1, played: [] },
        { lv: 3, name: '三级题组 B', nums: g2.map(function (x) { return x.n; }), answers: [], replayLeft: 1, played: [] },
        { lv: 4, name: '四级题组', nums: g3.map(function (x) { return x.n; }), answers: [], replayLeft: 1, played: [] }
      ]
    };
    S.view = 'exam';
    S.ctx = 'exam';
    $('#tabbar').classList.add('hidden');
    renderExamRun();
  }

  function examGroup() { return S.exam.groups[S.exam.gi]; }

  function renderExamRun() {
    var ex = S.exam, g = examGroup(), it = S.byNum[g.nums[ex.qi]];
    var html = '<div class="p-bar">' +
      '<button class="back" id="btnExamExit"><svg viewBox="0 0 24 24"><path d="M15.4 3.4 7.8 11a1.4 1.4 0 0 0 0 2l7.6 7.6 1.4-1.4L9.6 12l7.2-7.2z"/></svg></button>' +
      '<div class="mid"><div class="t">' + g.name + '</div>' +
      '<div class="s">第 ' + (ex.qi + 1) + ' / ' + g.nums.length + ' 题 · 组 ' + (ex.gi + 1) + '/3</div></div>' +
      '<div class="badge-lv l' + (g.lv <= 3 ? 3 : 4) + '">' + lvName(g.lv) + '</div></div>';

    html += '<div class="exam-progress">';
    ex.groups.forEach(function (gg, i) {
      var done = i < ex.gi;
      html += '<div class="g' + (done ? ' done' : '') + '" data-nums="' + gg.nums.join(',') + '">' +
        '<div class="t"><span>' + (i + 1) + '</span>' +
        '<span>' + (done ? gg.score + '/4' : (i === ex.gi ? (ex.qi + 1) + '/4' : '—')) + '</span></div>' +
        '<div class="b"><i style="width:' + (done ? 100 : (i === ex.gi ? pct(ex.qi, 4) : 0)) + '%"></i></div></div>';
    });
    html += '</div>';

    html += '<div class="q-head"><div class="l">第 ' + (ex.qi + 1) + ' 题</div>' +
      '<div class="r">重听机会：' + g.replayLeft + '/1</div></div>';

    var played = !!(g.played && g.played[ex.qi]);
    html += '<div class="q-audio' + (played ? ' used' : '') + '">' +
      '<button class="playbtn" id="btnQPlay"' + (played ? ' disabled' : '') + '>' +
      '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg></button>' +
      '<div class="info"><div class="t">听录音，然后复述</div>' +
      '<div class="d">' + (played ? '本题已播放（每题只能听一遍）' : '点击播放 · 本题只能听一遍') + '</div></div>' +
      '<button class="mini ghost" id="btnListen" ' +
      ((g.replayLeft && played) ? '' : 'disabled') + '>重听</button></div>';

    html += '<div class="rec-zone" style="margin-top:12px"><div class="rec-line">' +
      '<button class="rec-btn" id="btnRec"><svg viewBox="0 0 24 24"><path d="M12 3a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3zm7 9a7 7 0 0 1-6 6.93V21h-2v-2.07A7 7 0 0 1 5 12h2a5 5 0 0 0 10 0z"/></svg></button>' +
      '<div class="rec-meta"><div class="t" id="recTitle">点击开始朗读</div>' +
      '<div class="d" id="recDesc">凭听力复述，录完自动判分</div>' +
      '<div class="level-meter" id="meter">' + new Array(24).join('<i></i>') + '</div></div>' +
      '<div class="rec-actions"><button class="mini ghost" id="btnPlayRec" disabled>' +
      '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>回放</button></div></div>' +
      '<div class="score-box" id="scoreBox"></div></div>';

    if (localReady()) {
      html += '<div class="exam-note" style="color:var(--green)">识别方式：本地 Qwen3-ASR-0.6B（离线，' +
        '录音不出本机）。每句转写约 3~10 秒，转完自动判分。</div>';
    } else if (!asrStatus().ok) {
      html += '<div class="exam-note">本机没有可用的语音识别：建议到设置里填 AI 识别的 Key；' +
        '不填也能考，录音会全部保存，交卷后逐句回听并人工判分。</div>';
    }
    html += '<button class="btn-primary" id="btnNextQ" disabled>下一题</button>';
    render(html, true);
    bindExamRun(it);
    if (it && it.a && !played) setTimeout(function () { playExamAudio('first'); }, 300);
  }

  /* 考试音频：每题只能听一遍（首次自动播放也算），每组额外 1 次重听 */
  function playExamAudio(kind) {
    var ex = S.exam, g = examGroup(), it = S.byNum[g.nums[ex.qi]];
    if (!it || !it.a) { toast('该句暂无音频'); return; }
    if (!g.played) g.played = [];
    if (kind === 'replay') {
      if (!g.played[ex.qi]) { toast('请先听第一遍'); return; }
      if (!g.replayLeft) { toast('本组重听机会已用完'); return; }
      g.replayLeft--;
    } else {
      if (g.played[ex.qi]) { toast('本题已播放过，需要再听请用重听机会'); return; }
      g.played[ex.qi] = true;
    }
    updateExamAudioUI();
    stopPlay();
    var a = new Audio(audioUrl(it));
    S.audio = a;
    var b = $('#btnQPlay');
    if (b) b.classList.add('playing');
    a.onended = function () {
      if (b) b.classList.remove('playing');
      if (S.audio === a) { releaseAudio(a); S.audio = null; }
    };
    a.play().catch(function () { toast('播放失败'); });
  }

  function updateExamAudioUI() {
    var ex = S.exam;
    if (!ex) return;
    var g = examGroup();
    var played = !!(g.played && g.played[ex.qi]);
    var b = $('#btnQPlay'), l = $('#btnListen');
    var r = $('.q-head .r'), d = $('.q-audio .info .d');
    if (b) { b.disabled = played; }
    if (l) { l.disabled = !(g.replayLeft && played); }
    if (r) { r.textContent = '重听机会：' + g.replayLeft + '/1'; }
    if (d) { d.textContent = played ? '本题已播放（每题只能听一遍）' : '点击播放 · 本题只能听一遍'; }
    var box = $('.q-audio');
    if (box) box.classList.toggle('used', played);
  }

  function bindExamRun(it) {
    var ex = S.exam, g = examGroup();
    $('#btnExamExit').onclick = function () {
      sheet('退出考试？', '当前进度将不会保存。', '退出', function () {
        abortTurn();
        S.exam = null; S.view = 'exam';
        $('#tabbar').classList.remove('hidden');
        $('#app').classList.remove('hide-tabbar');
        renderExam();
      }, true);
    };
    $('#btnQPlay').onclick = function () { playExamAudio('first'); };
    $('#btnListen').onclick = function () { playExamAudio('replay'); };
    $('#btnRec').onclick = function () {
      if (S.turn && S.turn.recording) stopTurn(); else startTurn();
    };
    $('#btnPlayRec').onclick = playRec;
    $('#btnNextQ').onclick = nextQuestion;
  }

  function nextQuestion() {
    var ex = S.exam, g = examGroup();
    if (ex.qi < g.nums.length - 1) {
      ex.qi++;
      stopPlay(); stopRecAudio(); resetTurn();
      renderExamRun();
      return;
    }
    g.score = g.answers.reduce(function (sum, a) {
      return sum + (a && typeof a.score === 'number' ? a.score : 0);
    }, 0);
    if (ex.gi < ex.groups.length - 1) {
      ex.gi++; ex.qi = 0;
      stopPlay(); stopRecAudio(); resetTurn();
      toast(g.name + ' 完成：' + g.score + '/4');
      renderExamRun();
      return;
    }
    finishExam();
  }

  function finishExam() {
    var ex = S.exam;
    recalcExam(ex);
    var recs = load(K_EXAM, []);
    recs.push({ id: ex.id, ts: ex.ts, total: ex.total, pass: ex.pass, groups: ex.groups });
    /* 只保留最近 50 次：localStorage 有容量上限，写满后 save 会静默失败，
       之后连掌握状态都存不进去 */
    if (recs.length > 50) recs = recs.slice(-50);
    save(K_EXAM, recs);
    S.exams = recs;
    /* 只保留最近 10 次考试的录音，避免长期占用空间 */
    if (B && B.pruneExamAudio) {
      try {
        B.pruneExamAudio(recs.slice(-10).map(function (r) { return r.id; }).join(','));
      } catch (e) {}
    }
    showExamResult(ex);
  }

  function showExamResult(ex) {
    S.view = 'result';
    S.resultExam = ex;
    var totalMax = ex.groups.length * 4;
    var html = '<div class="p-bar"><button class="back" id="btnResBack">' +
      '<svg viewBox="0 0 24 24"><path d="M15.4 3.4 7.8 11a1.4 1.4 0 0 0 0 2l7.6 7.6 1.4-1.4L9.6 12l7.2-7.2z"/></svg></button>' +
      '<div class="mid"><div class="t">考试答卷</div><div class="s">' + fmtDate(ex.ts) + '</div></div>' +
      '<div style="width:38px"></div></div>';

    html += '<div class="result-big ' + (ex.pass ? 'pass' : 'fail') + '" id="resBig">' +
      '<div class="r">' + (ex.pass ? 'PASS' : 'FAIL') + '</div>' +
      '<div class="v">' + (ex.pass ? '通过' : '不通过') + '</div>' +
      '<div class="g">总分 ' + ex.total.toFixed(1) + ' / ' + totalMax + ' · ' +
      (ex.pass ? '各组均达到 3 分' : '存在低于 3 分的题组') + '</div></div>' +
      '<div class="judge-hint">自动评分仅供参考 · 每题可听「原声」和「我的录音」逐句对照，' +
      '判错了直接点下方的对 / 半对 / 错改判</div>';

    ex.groups.forEach(function (g, gi) {
      var ok = g.score >= 3;
      html += '<div class="grade-card"><div class="gc-head"><div class="t">' + g.name + ' · ' + lvName(g.lv) + '</div>' +
        '<div class="s" data-gsc="' + gi + '" style="color:' + (ok ? 'var(--green)' : 'var(--red)') + '">' + g.score + '/4 ' +
        (ok ? '达标' : '未达标') + '</div></div>';
      (g.answers || []).forEach(function (a, qi) {
        if (!a) return;
        var it = S.byNum[a.n];
        var hasScore = typeof a.score === 'number';
        var sc = !hasScore ? '待判' : (a.score === 1 ? '1' : (a.score === 0.5 ? '0.5' : '0'));
        var color = !hasScore ? 'var(--ink3)'
          : (a.score === 1 ? 'var(--green)' : (a.score === 0.5 ? 'var(--gold)' : 'var(--red)'));
        html += '<div class="ans-card" data-gi="' + gi + '" data-qi="' + qi + '">' +
          '<div class="ah"><span class="ano">' + (qi + 1) + '</span>' +
          '<span class="atag ' + lvKey(g.lv) + '">' + lvName(g.lv) + '</span>' +
          '<span class="asc" style="color:' + color + '">' + sc + (hasScore ? ' 分' : '') + '</span></div>' +
          '<div class="aen">' + esc(it.en) + '</div>' +
          (it.cn ? '<div class="acn">' + esc(it.cn) + '</div>' : '') +
          (a.rec ? '<div class="arec">识别：' + esc(a.rec) + (a.ai ? ' · AI 转写' : '') + '</div>' : '') +
          '<div class="aplay">' +
          (it.a ? '<button class="mini ghost" data-orig="' + a.n + '">' +
            '<svg class="jico" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>原声</button>' : '') +
          (a.audio
            ? '<button class="mini ghost" data-play="' + esc(a.audio) + '">' +
              '<svg class="jico" viewBox="0 0 24 24"><path d="M12 3a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3zm7 9a7 7 0 0 1-6 6.93V21h-2v-2.07A7 7 0 0 1 5 12h2a5 5 0 0 0 10 0z"/></svg>我的录音</button>'
            : '<button class="mini ghost" disabled>无录音</button>') +
          '</div>' +
          '<div class="judge"><span class="jl">人工判定</span>' +
          (g.lv <= 3 ? [1, 0] : [1, 0.5, 0]).map(function (v) {
            var on = (a.manual && a.score === v) ? ' on' : '';
            var lab = v === 1 ? '对' : (v === 0.5 ? '半对' : '错');
            return '<button class="jchip' + on + '" data-judge="' + v +
              '" data-gi="' + gi + '" data-qi="' + qi + '">' + lab + '</button>';
          }).join('') +
          (a.manual ? '<span class="manual-tag">已改判</span>' : '') +
          '</div></div>';
      });
      html += '</div>';
    });

    html += '<button class="btn-primary" id="btnAgain">再考一次</button>' +
      '<button class="btn-danger" style="margin-top:10px;margin-bottom:8px" id="btnToExam">返回考试页</button>';
    render(html, true);
    $('#btnResBack').onclick = backToExam;
    $('#btnToExam').onclick = backToExam;
    $('#btnAgain').onclick = function () { S.exam = null; startExam(); };

    $('#app').onclick = function (e) {
      var ob = e.target.closest('[data-orig]');
      if (ob) {
        e.preventDefault();
        var oit = S.byNum[+ob.getAttribute('data-orig')];
        if (!oit || !oit.a) return;
        stopRecAudio(); stopPlay();
        var oa = new Audio(audioUrl(oit));
        oa.playbackRate = S.settings.rate || 1;
        S.audio = oa;
        ob.classList.add('playing');
        oa.onended = function () { ob.classList.remove('playing'); if (S.audio === oa) stopPlay(); };
        oa.onerror = function () { toast('原声播放失败'); ob.classList.remove('playing'); };
        oa.play().catch(function () { toast('播放失败'); ob.classList.remove('playing'); });
        return;
      }
      var pb = e.target.closest('[data-play]');
      if (pb) {
        e.preventDefault();
        stopRecAudio();
        var url = pb.getAttribute('data-play');
        if (!url) return;
        var au = new Audio(url);
        S.recAudio = au;
        pb.classList.add('playing');
        au.onended = function () { pb.classList.remove('playing'); if (S.recAudio === au) stopRecAudio(); };
        au.onerror = function () { toast('录音文件已不存在'); pb.classList.remove('playing'); };
        au.play().catch(function () { toast('回放失败'); pb.classList.remove('playing'); });
        return;
      }
      var chip = e.target.closest('[data-judge]');
      if (chip) {
        var gi = +chip.getAttribute('data-gi'), qi = +chip.getAttribute('data-qi');
        var v = parseFloat(chip.getAttribute('data-judge'));
        var rec = S.resultExam;
        if (!rec || !rec.groups[gi] || !rec.groups[gi].answers[qi]) return;
        var ans = rec.groups[gi].answers[qi];
        if (ans.manual && ans.score === v) {
          /* 撤销改判：恢复成自动评分（只清标记会让分数停在人工值，显示和数据不一致） */
          ans.manual = false;
          ans.score = ans.autoScore;
        } else {
          if (ans.autoScore === undefined) ans.autoScore = ans.score;
          ans.score = v;
          ans.manual = true;
        }
        recalcExam(rec);
        persistExam(rec);
        /* 只刷新这一张卡片和小分，不重绘整页：
         * 重绘会把长答卷滚回顶部，改一句就得重新往下翻。 */
        refreshAnsCard(rec, gi, qi);
        refreshResultView(rec);
        return;
      }
    };
  }

  /* 单张答题卡的判定状态与分数 */
  function refreshAnsCard(rec, gi, qi) {
    var a = rec.groups[gi].answers[qi];
    var card = document.querySelector('.ans-card[data-gi="' + gi + '"][data-qi="' + qi + '"]');
    if (!card) return;
    var hasScore = typeof a.score === 'number';
    var sc = card.querySelector('.asc');
    if (sc) {
      sc.textContent = (hasScore
        ? (a.score === 1 ? '1' : (a.score === 0.5 ? '0.5' : '0')) + ' 分'
        : '待判');
      sc.style.color = !hasScore ? 'var(--ink3)'
        : (a.score === 1 ? 'var(--green)' : (a.score === 0.5 ? 'var(--gold)' : 'var(--red)'));
    }
    var chips = card.querySelectorAll('[data-judge]');
    for (var i = 0; i < chips.length; i++) {
      var v = parseFloat(chips[i].getAttribute('data-judge'));
      if (a.manual && a.score === v) chips[i].classList.add('on');
      else chips[i].classList.remove('on');
    }
    var judge = card.querySelector('.judge');
    var tag = card.querySelector('.manual-tag');
    if (a.manual && !tag && judge) {
      judge.insertAdjacentHTML('beforeend', '<span class="manual-tag">已改判</span>');
    } else if (!a.manual && tag) {
      tag.parentNode.removeChild(tag);
    }
  }

  /* 各组小分 / 总分 / PASS 大字 */
  function refreshResultView(rec) {
    rec.groups.forEach(function (g, gi) {
      var el = document.querySelector('[data-gsc="' + gi + '"]');
      if (!el) return;
      var ok = g.score >= 3;
      el.textContent = g.score + '/4 ' + (ok ? '达标' : '未达标');
      el.style.color = ok ? 'var(--green)' : 'var(--red)';
    });
    var big = $('#resBig');
    if (!big) return;
    if (rec.pass) { big.classList.add('pass'); big.classList.remove('fail'); }
    else { big.classList.add('fail'); big.classList.remove('pass'); }
    var r = big.querySelector('.r'), v = big.querySelector('.v'), g2 = big.querySelector('.g');
    if (r) r.textContent = rec.pass ? 'PASS' : 'FAIL';
    if (v) v.textContent = rec.pass ? '通过' : '不通过';
    if (g2) {
      g2.textContent = '总分 ' + rec.total.toFixed(1) + ' / ' + (rec.groups.length * 4) + ' · ' +
        (rec.pass ? '各组均达到 3 分' : '存在低于 3 分的题组');
    }
  }

  /* 重算组内小分、总分与是否通过 */
  function recalcExam(ex) {
    ex.groups.forEach(function (g) {
      g.score = (g.answers || []).reduce(function (sum, a) {
        return sum + (a && typeof a.score === 'number' ? a.score : 0);
      }, 0);
    });
    ex.total = ex.groups.reduce(function (sum, g) { return sum + g.score; }, 0);
    ex.pass = ex.groups.every(function (g) { return g.score >= 3; });
  }

  function persistExam(ex) {
    var recs = load(K_EXAM, []);
    var hit = false;
    for (var i = 0; i < recs.length; i++) {
      if (recs[i].id === ex.id) { recs[i] = ex; hit = true; }
    }
    if (!hit) recs.push(ex);
    save(K_EXAM, recs);
    S.exams = recs;
  }

  function backToExam() {
    var target = S.backTo || 'exam';
    S.backTo = null;
    S.exam = null;
    $('#tabbar').classList.remove('hidden');
    $('#app').classList.remove('hide-tabbar');
    go(target === 'record' ? 'record' : 'exam');
  }

  function showExamRecord(id) {
    var rec = S.exams.filter(function (r) { return r.id === id; })[0];
    if (!rec) return;
    S.backTo = 'record';
    showExamResult(rec);
    $('#btnAgain').onclick = function () { S.exam = null; startExam(); };
  }

  /* ------------------------------------------------ 记录 */
  function renderRecord() {
    var recs = S.exams.slice().reverse();
    var pass = recs.filter(function (r) { return r.pass; }).length;
    var html = '<div class="page-head"><div><h1>练习记录</h1>' +
      '<div class="sub">考试与掌握情况</div></div>' +
      '<div class="chip">通过率 ' + pct(pass, recs.length) + '%</div></div>';

    html += '<div class="hero"><div class="row"><div><div class="big">' + recs.length +
      '<small>次考试</small></div><div class="lbl">通过 ' + pass + ' 次 · 未通过 ' + (recs.length - pass) + ' 次</div></div>' +
      '<div style="text-align:right"><div style="font-size:24px;font-weight:800">' + knownList().length +
      '</div><div class="lbl">已掌握句子</div></div></div></div>';

    html += '<div class="sec-title"><h2>考试记录</h2><span>点击查看答卷</span></div>';
    if (!recs.length) html += '<div class="empty">暂无记录</div>';
    recs.forEach(function (r) {
      html += '<div class="row-item" data-exam="' + r.id + '">' +
        '<div class="dot" style="background:' + (r.pass ? 'var(--green)' : 'var(--red)') + '"></div>' +
        '<div class="g"><div class="t1">' + (r.pass ? '通过' : '未通过') + ' · ' + r.total.toFixed(1) + ' 分</div>' +
        '<div class="t2">' + fmtDate(r.ts) + ' · ' + r.groups.map(function (g) { return g.score + '/4'; }).join(' / ') + '</div></div>' +
        '<div style="color:var(--ink3);font-size:16px">›</div></div>';
    });
    render(html);
    $('#app').onclick = function (e) {
      var r = e.target.closest('[data-exam]');
      if (r) { $('#tabbar').classList.add('hidden'); showExamRecord(r.getAttribute('data-exam')); }
    };
  }

  /* ------------------------------------------------ 设置 */
  /* 录音诊断：把一次录音的音源、采样率、原始电平、补偿量摊开。
     用户截个图就能判断"声音小"是手机采集、App 后处理，还是回放端造成的。 */
  function recDiagGroup() {
    var r = S.lastRec, dev = '';
    try { dev = (B && B.deviceInfo) ? B.deviceInfo() : ''; } catch (e) {}
    if (!r) {
      return '<div class="set-group"><div class="set-row"><div class="g">' +
        '<div class="t">录音诊断</div><div class="d">还没有录音数据。到练习页录一句再回来，' +
        '这里会显示采集音源、原始电平和补偿量。</div></div></div></div>';
    }
    var g = r.gainDb || 0, rms = r.rmsDb || 0;
    var f1 = function (v) { return typeof v === 'number' ? v.toFixed(1) : '—'; };
    var verdict, tone;
    if (g >= 12) {
      verdict = '采集端电平本身就低（系统对麦克风做了抑制），已自动补 +' + g.toFixed(1) +
        ' dB。若还是小，说明这台机器给到 App 的信号实在太弱。';
      tone = 'var(--red)';
    } else if (rms < -24) {
      verdict = '录音仍然偏小：原始峰值 ' + f1(r.inPeakDb) + ' dBFS，语音平均 ' + rms.toFixed(0) +
        ' dBFS。多半是没对着麦克风说，或设备采集太弱。';
      tone = 'var(--red)';
    } else {
      verdict = '采集与后处理都正常：语音平均在 ' + rms.toFixed(0) +
        ' dBFS 左右。若听着仍小，问题在回放端或手机媒体音量。';
      tone = 'var(--green)';
    }
    return '<div class="set-group"><div class="set-row"><div class="g">' +
      '<div class="t">录音诊断</div>' +
      '<div class="d">' +
      (dev ? '设备 ' + esc(dev) + '<br>' : '') +
      '音源 ' + esc(r.src || '—') + ' · ' + (r.rate ? (r.rate / 1000) + ' kHz' : '—') +
      ' · ' + ((r.ms || 0) / 1000).toFixed(1) + ' s<br>' +
      '原始峰值 ' + f1(r.inPeakDb) + ' dBFS · 补偿 ' +
      (g >= 0 ? '+' : '') + g.toFixed(1) + ' dB<br>' +
      '输出峰值 ' + f1(r.outPeakDb) + ' dBFS · 语音平均 ' + rms.toFixed(1) + ' dBFS' +
      '</div></div></div>' +
      '<div class="set-row" style="border:0"><div class="g"><div class="d" style="color:' +
      tone + '">' + verdict + '</div></div></div>' +
      '<div class="set-row" style="border:0"><button class="mini" id="btnCopyRec">复制参数</button>' +
      '<span class="set-tip">录音偏小时把这段发给开发者</span></div></div>';
  }

  function copyText(t) {
    try {
      var ta = document.createElement('textarea');
      ta.value = t;
      ta.style.cssText = 'position:fixed;left:-9999px;top:0';
      document.body.appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, t.length);
      var ok = document.execCommand('copy');
      document.body.removeChild(ta);
      toast(ok ? '参数已复制' : '复制失败，麻烦截图');
    } catch (e) { toast('复制失败，麻烦截图'); }
  }

  function renderSettings() {
    if (B2) syncLocal();          // 每次进设置都刷一次设备/模型状态
    var s = S.settings;
    var html = '<div class="page-head"><div><h1>设置</h1><div class="sub">学习偏好与数据</div></div></div>';

    /* 外观：夜间模式为纯黑底 + 白字，切换时颜色渐变（CSS 变量插值） */
    var tp = themePref();
    html += '<div class="set-group">' +
      '<div class="set-row"><div class="g"><div class="t">外观</div>' +
      '<div class="d">夜间模式为纯黑背景、白色文字，切换时整页颜色渐变过渡</div></div></div>' +
      '<div class="set-row" style="border:0"><div class="seg" style="margin:0;flex:1">' +
      '<button class="' + (tp === 'auto' ? 'on' : '') + '" id="btnThemeAuto">跟随系统</button>' +
      '<button class="' + (tp === 'light' ? 'on' : '') + '" id="btnThemeLight">浅色</button>' +
      '<button class="' + (tp === 'dark' ? 'on' : '') + '" id="btnThemeDark">夜间</button>' +
      '</div></div></div>';

    html += '<div class="set-group">' +
      row('考试自动评分', '考试录音后按 ICAO 规则判分；关掉就只存录音、交卷后人工判分（练习模式不评分）', 'asr', s.asr) +
      row('系统识别优先在线', '走系统在线识别，对非母语口音更准；无网络时自动回落到本机离线识别', 'online', s.online) +
      row('自动播放', '进入卡片后自动播放该句录音', 'autoPlay', s.autoPlay) +
      row('显示中文', '卡片背面显示中文释义', 'showCn', s.showCn) +
      '<div class="set-row"><div class="g"><div class="t">播放速度</div><div class="d">慢速适合跟读</div></div>' +
      '<div class="val" id="rateVal">' + (s.rate === 1 ? '正常' : s.rate + '×') + '</div></div>' +
      '<div class="set-row"><div class="g"><div class="t" style="font-size:12px;color:var(--ink3)">' +
      '<input id="rate" type="range" min="0.6" max="1.4" step="0.1" value="' + s.rate + '" style="width:100%"></div></div></div>' +
      '<div class="set-row"><div class="g"><div class="t">OPI 考官语音</div>' +
      '<div class="d">提问朗读的嗓音，男声更接近真人口试考官</div></div>' +
      '<div class="val"><span class="voice-btns">' +
      '<button class="mini' + (s.opiVoice !== 'm' ? ' on' : '') + '" id="btnVoiceF">女声</button>' +
      '<button class="mini' + (s.opiVoice === 'm' ? ' on' : '') + '" id="btnVoiceM">男声</button></span></div></div>' +
      '</div>';

    html += '<div class="set-group">' +
      '<div class="set-row"><div class="g"><div class="t">AI 语音转写（识别兜底）</div>' +
      '<div class="d">模拟对话的录音默认先用<b>本机 Qwen3-ASR</b> 离线转写；' +
      '若本机没装模型，则走这里配置的 OpenAI 兼容转写接口作兜底，把你的语音变成文字交给考官判分。' +
      'Key 只保存在本机。这不是考试评分接口，仅用于语音转文字。</div></div>' +
      '<div class="switch' + (s.ai ? ' on' : '') + '" data-tog="ai"></div></div>' +
      '<div class="set-field"><label>接口地址</label>' +
      '<input id="aiBase" value="' + esc(s.aiBase || '') + '" placeholder="https://api.openai.com/v1" ' +
      'spellcheck="false" autocapitalize="off"></div>' +
      '<div class="set-field"><label>模型</label>' +
      '<input id="aiModel" value="' + esc(s.aiModel || '') + '" placeholder="whisper-1" ' +
      'spellcheck="false" autocapitalize="off"></div>' +
      '<div class="set-field"><label>API Key</label>' +
      '<input id="aiKey" type="password" value="' + esc(s.aiKey || '') + '" placeholder="sk-..." ' +
      'spellcheck="false" autocapitalize="off"></div>' +
      '<div class="set-row" style="border:0"><button class="mini" id="btnTestAi">测试 AI 识别</button>' +
      '<span class="set-tip">地址填到 /v1 为止，会自动拼 /audio/transcriptions</span></div></div>';

    var av = asrStatus();
    html += '<div class="set-group">' +
      '<div class="set-row"><div class="g"><div class="t">本机识别服务</div>' +
      '<div class="d" style="color:' + (av.ok ? 'var(--green)' : 'var(--red)') + '">' + av.txt +
      (S.lastAsrMsg ? '<br>上次：' + esc(S.lastAsrMsg) : '') + '</div></div></div>' +
      '<div class="set-row" style="border:0"><button class="mini" id="btnTestAsr">测试识别</button></div></div>';

    if (localReady()) {
      html += '<div class="set-group"><div class="set-row"><div class="g"><div class="d">' +
        '当前识别走<b>本地 Qwen3-ASR 模型</b>，上方的系统识别服务不会被调用。</div></div></div></div>';
    }
    html += localGroupHtml();

    /* 模拟对话模型：OPI 实战演练的考官与评分员 */
    html += '<div class="set-group">' +
      '<div class="set-row"><div class="g"><div class="t">模拟对话模型（OPI 考官）</div>' +
      '<div class="d">任意 OpenAI 兼容的对话模型都能用（OpenAI / DeepSeek / 通义 / 硅基流动 / Groq…）。' +
      '它扮演考官提问、逐题六维打分并写总评。Key 只保存在本机。</div></div></div>' +
      '<div class="set-field"><label>接口地址</label>' +
      '<input id="chatBase" value="' + esc(s.chatBase || '') + '" placeholder="https://api.openai.com/v1" ' +
      'spellcheck="false" autocapitalize="off"></div>' +
      '<div class="set-field"><label>模型</label>' +
      '<input id="chatModel" value="' + esc(s.chatModel || '') + '" placeholder="gpt-4o-mini" ' +
      'spellcheck="false" autocapitalize="off"></div>' +
      '<div class="set-field"><label>API Key</label>' +
      '<input id="chatKey" type="password" value="' + esc(s.chatKey || '') + '" placeholder="sk-..." ' +
      'spellcheck="false" autocapitalize="off"></div>' +
      '<div class="set-row" style="border:0">' +
      '<span class="set-tip">' + (chatReady() ? '已配置，可直接开始模拟对话' : '三项都填好后「模拟对话」才可用') +
      '</span></div></div>';

    html += '<div class="set-group"><div class="set-row"><div class="g">' +
      '<div class="t">数据概览</div>' +
      '<div class="d">已掌握 ' + knownList().length + ' 句 · 未掌握 ' + unknownList().length +
      ' 句 · 考试 ' + S.exams.length + ' 次</div></div></div></div>';

    html += recDiagGroup();

    html += '<div class="set-group"><div class="set-row" style="border:0">' +
      '<button class="btn-danger" id="btnReset">重置全部数据</button></div></div>' +
      '<div style="text-align:center;color:var(--ink3);font-size:11px;line-height:1.8;margin-top:6px">' +
      'ICAO 900句 · 本地离线版' + (VER ? ' v' + VER : '') + '<br>数据保存在本机</div>';

    render(html);
    $('#app').onclick = function (e) {
      var r = e.target.closest('[data-tog]');
      if (r) {
        var k = r.getAttribute('data-tog');
        S.settings[k] = !S.settings[k];
        saveSet();
        r.classList.toggle('on', S.settings[k]);
        if (k === 'online') syncAsrMode();
        if (k === 'ai') {
          if (S.settings.ai) { S.settings.localAsr = false; }   // 两种识别互斥
          saveSet(); syncAi();
          if (S.settings.ai) toast('AI 转写已开启，模拟对话将用云端接口转写');
          renderSettings();
        }
        if (k === 'localAsr') {
          if (S.settings.localAsr) {
            if (!localUsable()) {
              S.settings.localAsr = false;
              saveSet();
              toast(S.localInfo && !S.localInfo.ok
                ? (S.localInfo.reason || '这台设备跑不动本地模型')
                : '请先下载模型（1.0GB）');
              return;
            }
            S.settings.ai = false;
            saveSet();
            syncAi();
            toast('已启用本地 Qwen3-ASR，考试录音在本机转写');
          } else {
            saveSet(); syncAi();
          }
          renderSettings();
        }
      }
    };
    var bvf = $('#btnVoiceF'), bvm = $('#btnVoiceM');
    if (bvf) bvf.onclick = function () { S.settings.opiVoice = 'f'; saveSet(); renderSettings(); toast('已切换女声考官'); };
    if (bvm) bvm.onclick = function () { S.settings.opiVoice = 'm'; saveSet(); renderSettings(); toast('已切换男声考官'); };

    /* 外观切换：改设置 → 落盘 → 应用主题（颜色过渡由 CSS 变量动画完成） */
    function pickTheme(t, tip) {
      S.settings.theme = t;
      saveSet();
      applyTheme();
      renderSettings();
      toast(tip);
    }
    var btA = $('#btnThemeAuto'), btL = $('#btnThemeLight'), btD = $('#btnThemeDark');
    if (btA) btA.onclick = function () { pickTheme('auto', '已跟随系统外观'); };
    if (btL) btL.onclick = function () { pickTheme('light', '已切换浅色'); };
    if (btD) btD.onclick = function () { pickTheme('dark', '已开启夜间模式'); };
    var ta = $('#btnTestAsr');
    if (ta) ta.onclick = testAsr;
    /* 本地模型：下载 / 暂停 / 删除 / 测试 */
    var bd = $('#btnDlModel');
    if (bd) bd.onclick = startLocalDownload;
    var bc = $('#btnCancelDl');
    if (bc) bc.onclick = function () {
      try { B2.cancelDownload(); } catch (e) {}
      toast('已暂停，下次继续会接着下');
      setTimeout(function () { syncLocal(); renderSettings(); }, 400);
    };
    var bdel = $('#btnDelModel');
    if (bdel) bdel.onclick = function () {
      sheet('删除本地模型？', '会释放约 1.0GB 空间，本地识别随之关闭。录音和考试成绩不受影响。',
        '删除', function () {
          try { B2.deleteModels(); } catch (e) {}
          S.settings.localAsr = false;
          saveSet();
          setTimeout(function () { syncLocal(); renderSettings(); }, 400);
          toast('已删除本地模型');
        }, true);
    };
    var btl = $('#btnTestLocal');
    if (btl) btl.onclick = function () { testLocal(); };
    var tc = $('#btnCopyRec');
    if (tc) tc.onclick = function () {
      var r = S.lastRec;
      if (!r) return;
      copyText('ICAO900 v' + (VER || '?') + ' | ' + (function () {
        try { return (B && B.deviceInfo) ? B.deviceInfo() : ''; } catch (e) { return ''; }
      })() + ' | src=' + r.src + ' rate=' + r.rate + ' inPeak=' + r.inPeakDb +
        ' gain=' + r.gainDb + ' outPeak=' + r.outPeakDb + ' rms=' + r.rmsDb + ' ms=' + r.ms);
    };
    var tai = $('#btnTestAi');
    if (tai) tai.onclick = testAsr;
    ['aiBase', 'aiModel', 'aiKey'].forEach(function (id) {
      var inp = $('#' + id);
      if (!inp) return;
      inp.oninput = function () {
        S.settings[id] = this.value.trim();
        saveSet(); syncAi();
      };
    });
    ['chatBase', 'chatModel', 'chatKey'].forEach(function (id) {
      var inp = $('#' + id);
      if (!inp) return;
      inp.oninput = function () {
        S.settings[id] = this.value.trim();
        saveSet();
      };
    });
    $('#rate').oninput = function () {
      S.settings.rate = parseFloat(this.value);
      $('#rateVal').textContent = S.settings.rate === 1 ? '正常' : S.settings.rate + '×';
    };
    $('#rate').onchange = saveSet;
    $('#btnReset').onclick = function () {
      sheet('重置全部数据？', '将清空掌握状态、单词高亮、考试记录、OPI 收藏与演练记录、设置，恢复到初次安装的状态。<b>此操作不可撤销。</b>',
        '确认重置', function () {
          try {
            localStorage.removeItem(K_PROG);
            localStorage.removeItem(K_EXAM);
            localStorage.removeItem(K_SET);
            localStorage.removeItem(K_POS);
            localStorage.removeItem(K_LASTREC);
            localStorage.removeItem(K_OFAV);
            localStorage.removeItem(K_OPASS);
            localStorage.removeItem(K_OCHAT);
          } catch (e) {}
          S.progress = {}; S.exams = []; S.positions = {}; S.lastRec = null;
          S.ofav = {}; S.opass = {}; S.chats = [];
          S.settings = {
            asr: true, online: true, autoPlay: true, showCn: true, rate: 1, opiVoice: 'f',
            theme: 'auto',
            ai: false, aiBase: 'https://api.openai.com/v1', aiModel: 'whisper-1', aiKey: '',
            localAsr: false,
            chatBase: 'https://api.openai.com/v1', chatModel: 'gpt-4o-mini', chatKey: ''
          };
          syncAi(); syncAsrMode();
          toast('已恢复到初始状态');
          renderSettings();
        }, true);
    };
  }

  function asrStatus() {
    if (!B) return { ok: false, txt: '预览模式：没有原生识别' };
    try {
      if (localReady()) return { ok: true, txt: '本地 Qwen3-ASR-0.6B（离线转写）' };
      if (aiReady()) return { ok: true, txt: 'AI 识别已启用（' + S.settings.aiModel + '）' };
      return B.asrAvailable()
        ? { ok: true, txt: '可用（可在上方切换在线/离线）' }
        : { ok: false, txt: '本机没有语音识别服务，建议开启上面的 AI 识别' };
    } catch (e) {
      return { ok: false, txt: '检测失败' };
    }
  }

  /* 设置页的"测试识别"：录一小段，直接把识别结果/失败原因弹出来 */
  function testAsr() {
    if (!B) { toast('预览模式不支持语音识别'); return; }
    if (S.asrProbe) { toast('正在测试，请稍候'); return; }
    S.asrProbe = true;
    S.probeTarget = 'system';
    try {
      if (B.setClip) B.setClip('');
      if (B.setAsrEnabled) B.setAsrEnabled(!(localUsable() && S.settings.localAsr));
      syncAi();
      B.startTurn(4000);
      toast(localReady() ? '请朗读一句英文，将用本地模型转写'
        : (aiReady() ? '请朗读一句英文，将用 AI 转写' : '请朗读一句英文，说完自动结束'));
    } catch (e) {
      S.asrProbe = false;
      toast('录音启动失败');
    }
  }

  /* 设置页"测试本地识别"：不管开关是否打开，直接跑一次本地模型 */
  function testLocal() {
    if (!B || !B2) { toast('当前版本没有本地识别组件'); return; }
    if (!localUsable()) { toast('模型还没备好'); return; }
    if (S.asrProbe) { toast('正在测试，请稍候'); return; }
    S.asrProbe = true;
    S.probeTarget = 'local';
    try {
      if (B.setClip) B.setClip('');
      if (B.setAsrEnabled) B.setAsrEnabled(false);   // 本地模式不用系统识别
      if (B.setAi) B.setAi(false, '', '', '');
      B.startTurn(4000);
      toast('请朗读一句英文，录完用本地模型转写');
    } catch (e) {
      S.asrProbe = false;
      toast('录音启动失败');
    }
  }

  /* 把 AI 配置传给原生（只在开启且填了 Key 时才真正启用；本地模型启用时让位） */
  function syncAi() {
    if (!B || !B.setAi) return;
    var st = S.settings;
    var on = !!(st.ai && st.aiKey) && !st.localAsr;
    try {
      B.setAi(on, st.aiBase || '', st.aiModel || '', st.aiKey || '');
    } catch (e) {}
  }

  /* 把"在线/离线识别"偏好传给原生 */
  function syncAsrMode() {
    if (B && B.setPreferOnline) {
      try { B.setPreferOnline(!!S.settings.online); } catch (e) {}
    }
  }

  function row(t, d, key, on) {
    return '<div class="set-row"><div class="g"><div class="t">' + t + '</div>' +
      '<div class="d">' + d + '</div></div>' +
      '<div class="switch' + (on ? ' on' : '') + '" data-tog="' + key + '"></div></div>';
  }

  /* ==================================================================
   *  OPI 口语练习模块
   *  - 话题目录：按 6.x 大类分区，69 个话题
   *  - 卡片：正面问题语音，背面问题文本 + 示例答案 + 翻译；录音回放
   *  - Pass（计数） / 收藏 两个键；收藏夹按话题分类
   *  - 模拟对话：LLM 考官 + 六维评分 + 雷达图
   * ================================================================== */

  var C = window.ICAOChat || null;      // 对话模型桥（模拟对话用）

  /* 当前 OPI 上下文的伪条目：复用 900 句的录音机/播放器机制 */
  function opiCtxItem() {
    var c = null;
    if (S.ctx === 'opi' && S.odeck) {
      c = S.odeck.items[S.odeck.i];
    } else if (S.ctx === 'opichat' && S.ochat) {
      c = S.ochat.qs[S.ochat.i];
    }
    if (!c) return null;
    return {
      n: c.n, en: c.q, cn: c.cn, s: c.q, a: c.au,
      wl: (c.q || '').split(/\s+/).length, lv: 4, opi: c
    };
  }

  function opiTopicById(id) {
    if (!S.opi) return null;
    for (var i = 0; i < S.opi.topics.length; i++) {
      if (S.opi.topics[i].id === id) return S.opi.topics[i];
    }
    return null;
  }
  function opiGroupName(gid) {
    if (!S.opi) return gid;
    for (var i = 0; i < S.opi.groups.length; i++) {
      if (S.opi.groups[i].id === gid) return S.opi.groups[i].name;
    }
    return gid;
  }

  /* ---------------- 话题目录 ---------------- */
  function renderOpiToc() {
    if (!S.opi) { toast('OPI 数据还没加载好'); return; }
    abortTurn();
    S.view = 'opitoc';
    S.odeck = null;
    $('#tabbar').classList.add('hidden');
    $('#app').classList.add('hide-tabbar');

    var html = '<div class="subpage"><div class="p-bar page-bar">' +
      '<button class="back" id="btnOpiBack"><svg viewBox="0 0 24 24"><path d="M15.4 3.4 7.8 11a1.4 1.4 0 0 0 0 2l7.6 7.6 1.4-1.4L9.6 12l7.2-7.2z"/></svg></button>' +
      '<div class="mid"><div class="t">OPI 话题目录</div>' +
      '<div class="s">' + S.opi.groups.length + ' 大类 · ' + S.opi.topics.length + ' 话题 · ' + S.opi.count + ' 问</div></div>' +
      '<span></span></div>';

    S.opi.groups.forEach(function (g) {
      var topics = S.opi.topics.filter(function (t) { return t.group === g.id; });
      if (!topics.length) return;
      html += '<div class="sec-title opi-sec"><h2>' + esc(g.name) + '</h2><span>' + topics.length + ' 个话题</span></div>' +
        '<div class="topic-grid">';
      topics.forEach(function (t) {
        var passN = t.items.filter(function (c) { return S.opass[c.n]; }).length;
        var favN = t.items.filter(function (c) { return S.ofav[c.n]; }).length;
        html += '<button class="topic-card' + (passN ? ' has-pass' : '') + '" data-topic="' + esc(t.id) + '">' +
          '<div class="nm">' + esc(t.name) + '</div>' +
          '<div class="mt"><span>' + t.items.length + ' 问' + (passN ? ' · Pass ' + passN : '') + '</span>' +
          (favN ? '<span class="fv">★ ' + favN + '</span>' : '<span>›</span>') + '</div></button>';
      });
      html += '</div>';
    });

    render(html + '</div>', true);
    $('#btnOpiBack').onclick = goHome;
    $('#app').onclick = function (e) {
      var b = e.target.closest('[data-topic]');
      if (b) openOpiDeck(b.getAttribute('data-topic'));
    };
  }

  /* ---------------- OPI 练习卡片 ---------------- */
  function openOpiDeck(topicId, favOnly) {
    var t = opiTopicById(topicId);
    if (!t) return;
    var items = favOnly ? t.items.filter(function (c) { return S.ofav[c.n]; })
                        : t.items.slice();
    if (!items.length) { toast(favOnly ? '这个话题还没有收藏' : '话题为空'); return; }
    S.ctx = 'opi';
    S.odeck = { topic: t, items: items, i: 0, favOnly: !!favOnly, key: 'opi:' + topicId + (favOnly ? ':fav' : '') };
    S.flipped = false;
    renderOpiDeck();
  }

  function renderOpiDeck() {
    var d = S.odeck;
    if (!d) return goHome();
    var c = d.items[d.i];
    if (!c) { closeOpiDeck(); return; }
    var n = d.items.length, i = d.i;
    var pass = S.opass[c.n] || 0;
    var fav = !!S.ofav[c.n];
    S.view = 'opideck';
    S.flipped = false;
    $('#tabbar').classList.add('hidden');
    $('#app').classList.add('hide-tabbar');

    var html = '<div class="player">' +
      '<div class="p-bar">' +
      '<button class="back" id="btnOpiBack"><svg viewBox="0 0 24 24"><path d="M15.4 3.4 7.8 11a1.4 1.4 0 0 0 0 2l7.6 7.6 1.4-1.4L9.6 12l7.2-7.2z"/></svg></button>' +
      '<div class="mid"><div class="t">' + esc(d.topic.name) + '</div>' +
      '<div class="s">' + (i + 1) + ' / ' + n + (d.favOnly ? ' · 收藏' : '') + '</div></div>' +
      '<span class="lv-tag l4">OPI</span></div>';

    html += '<div class="deck-wrap"><div class="flip" id="flip">' +
      '<div class="face front"><div class="front-in">' +
      '<div class="top"><span>LISTEN</span><span>考官提问</span></div>' +
      '<div class="playwrap"><div class="playing-halo" id="halo"></div>' +
      '<button class="playbtn" id="btnPlay"><svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg></button></div>' +
      '<div class="wave" id="wave">' + new Array(22).join('<i></i>') + '</div>' +
      '<div class="bottom">左右滑动卡片翻面 · 先听问题再作答</div>' +
      '</div></div>' +
      '<div class="face back"><div class="back-in opi-back">' +
      '<div class="hint"><span>QUESTION · 点击小喇叭重听</span>' +
      '<span class="hint-r"><button class="mini-play" id="btnPlayBack" aria-label="播放">' +
      '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg></button></span></div>' +
      '<div class="en opi-q" id="enText"><div class="en-in">' + esc(c.q) + '</div></div>' +
      (S.settings.showCn !== false && c.cn ? '<div class="cn"><span class="tag">中文</span>' + esc(c.cn) + '</div>' : '') +
      (c.a ? '<div class="opi-ans"><span class="tag">示例答案</span>' + esc(c.a) + '</div>' : '') +
      '</div></div></div></div>';

    html += '<div class="pager"><button id="btnPrev"' + (i === 0 ? ' disabled' : '') + '>' +
      '<svg viewBox="0 0 24 24"><path d="M15.4 3.4 7.8 11a1.4 1.4 0 0 0 0 2l7.6 7.6 1.4-1.4L9.6 12l7.2-7.2z"/></svg></button>' +
      '<div class="dots"><i style="width:' + pct(i + 1, n) + '%"></i></div>' +
      '<button id="btnNext"' + (i === n - 1 ? ' disabled' : '') + '>' +
      '<svg viewBox="0 0 24 24"><path d="M8.6 20.6 16.2 13a1.4 1.4 0 0 0 0-2L8.6 3.4 7.2 4.8 14.4 12l-7.2 7.2z"/></svg></button></div>';

    html += '<div class="rec-zone opi-rec-zone"><div class="rec-line">' +
      '<button class="rec-btn" id="btnRec"><svg viewBox="0 0 24 24"><path d="M12 3a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3zm7 9a7 7 0 0 1-6 6.93V21h-2v-2.07A7 7 0 0 1 5 12h2a5 5 0 0 0 10 0z"/></svg></button>' +
      '<div class="rec-meta"><div class="t" id="recTitle">点击开始作答</div>' +
      '<div class="d" id="recDesc">先听问题，再录音回答，可回放</div>' +
      '<div class="level-meter" id="meter">' + new Array(24).join('<i></i>') + '</div></div>' +
      '<div class="rec-actions"><button class="mini ghost" id="btnPlayRec" disabled>' +
      '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>回放</button></div></div></div>';

    html += '<div class="mastery opi-mastery">' +
      '<button class="m-btn pass" id="btnPass">' +
      '<svg viewBox="0 0 24 24"><path d="M9.5 17.6 4.4 12.5l1.4-1.4 3.7 3.7 8.7-8.7 1.4 1.4z"/></svg>' +
      'Pass' + (pass ? ' <span class="cnt">' + pass + '</span>' : '') + '</button>' +
      '<button class="m-btn fav' + (fav ? ' on' : '') + '" id="btnFav">' +
      '<svg viewBox="0 0 24 24"><path d="M12 2l2.9 6.3 6.9.8-5.1 4.7 1.4 6.8L12 17.3 5.9 20.6l1.4-6.8L2.2 9.1l6.9-.8z"/></svg>' +
      (fav ? '已收藏' : '收藏') + '</button></div>';

    render(html, true);
    bindOpiDeck(c);
    if (S.settings.autoPlay) setTimeout(function () { playAudio(); }, 260);
  }

  function bindOpiDeck(c) {
    $('#btnOpiBack').onclick = closeOpiDeck;
    $('#btnPrev').onclick = function () { opiJump(-1); };
    $('#btnNext').onclick = function () { opiJump(1); };

    var flip = $('#flip');
    setFlip(false, false);
    var sx = 0, dx = 0, dragging = false, decided = null, w = 0;
    flip.addEventListener('pointerdown', function (e) {
      if (e.target.closest('#btnPlay')) return;
      dragging = true; decided = null; dx = 0;
      sx = e.clientX; w = flip.offsetWidth || 320;
      flip.style.transition = 'none';
    });
    flip.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      dx = e.clientX - sx;
      if (decided === null) decided = Math.abs(dx) > 8 ? 'h' : 'v';
      if (decided === 'h') {
        var base = S.flipped ? 180 : 0;
        var ang = Math.max(-1, Math.min(181, base + (dx / w) * 150));
        flip.style.transform = 'rotateY(' + ang + 'deg)';
      }
    });
    function endDrag() {
      if (!dragging) return;
      dragging = false;
      if (decided === 'h' && Math.abs(dx) > w * 0.14) setFlip(!S.flipped, true);
      else setFlip(S.flipped, true);
    }
    flip.addEventListener('pointerup', endDrag);
    flip.addEventListener('pointercancel', endDrag);
    flip.addEventListener('pointerleave', function () { if (dragging) endDrag(); });

    $('#btnPlay').onclick = function (e) { e.stopPropagation(); playAudio(); };
    $('#btnPlayBack').onclick = function (e) {
      e.stopPropagation();
      if (S.audio) stopPlay(); else playAudio();
    };
    $('#btnRec').onclick = function () {
      if (S.turn && S.turn.recording) stopTurn(); else startTurn();
    };
    $('#btnPlayRec').onclick = function () { playRec(); };

    $('#btnPass').onclick = function () {
      S.opass[c.n] = (S.opass[c.n] || 0) + 1;
      saveOpiState();
      toast('Pass · 累计 ' + S.opass[c.n] + ' 次');
      var b = $('#btnPass');
      b.innerHTML = '<svg viewBox="0 0 24 24"><path d="M9.5 17.6 4.4 12.5l1.4-1.4 3.7 3.7 8.7-8.7 1.4 1.4z"/></svg>' +
        'Pass <span class="cnt">' + S.opass[c.n] + '</span>';
      b.classList.add('flash');
      setTimeout(function () { b.classList.remove('flash'); }, 500);
    };
    $('#btnFav').onclick = function () {
      if (S.ofav[c.n]) { delete S.ofav[c.n]; toast('已取消收藏'); }
      else { S.ofav[c.n] = 1; toast('已加入收藏夹'); }
      saveOpiState();
      var b = $('#btnFav');
      var fav = !!S.ofav[c.n];
      b.classList.toggle('on', fav);
      b.innerHTML = '<svg viewBox="0 0 24 24"><path d="M12 2l2.9 6.3 6.9.8-5.1 4.7 1.4 6.8L12 17.3 5.9 20.6l1.4-6.8L2.2 9.1l6.9-.8z"/></svg>' +
        (fav ? '已收藏' : '收藏');
    };
  }

  function opiJump(d) { opiJumpTo(S.odeck.i + d); }

  function opiJumpTo(ni) {
    if (!S.odeck || ni < 0 || ni >= S.odeck.items.length) return;
    stopPlay(); stopRecAudio(); resetTurn();
    S.odeck.i = ni;
    renderOpiDeck();
  }

  function closeOpiDeck() {
    stopPlay(); stopRecAudio(); abortTurn();
    S.odeck = null;
    if (S.view === 'opideck') {
      if (S.odeckBack === 'fav') { S.odeckBack = null; renderOpiFav(); }
      else renderOpiToc();
    } else goHome();
  }

  function saveOpiState() {
    try {
      localStorage.setItem(K_OFAV, JSON.stringify(S.ofav));
      localStorage.setItem(K_OPASS, JSON.stringify(S.opass));
    } catch (e) {}
  }

  /* ---------------- OPI 收藏夹（按话题分类） ---------------- */
  function renderOpiFav() {
    if (!S.opi) { toast('OPI 数据还没加载好'); return; }
    abortTurn();
    S.view = 'opifav';
    S.odeckBack = 'fav';
    $('#tabbar').classList.add('hidden');
    $('#app').classList.add('hide-tabbar');

    var favIds = Object.keys(S.ofav);
    var html = '<div class="subpage"><div class="p-bar page-bar">' +
      '<button class="back" id="btnOpiBack"><svg viewBox="0 0 24 24"><path d="M15.4 3.4 7.8 11a1.4 1.4 0 0 0 0 2l7.6 7.6 1.4-1.4L9.6 12l7.2-7.2z"/></svg></button>' +
      '<div class="mid"><div class="t">OPI 收藏夹</div>' +
      '<div class="s">按话题分类 · 共 ' + favIds.length + ' 问</div></div>' +
      '<span></span></div>';

    if (!favIds.length) {
      html += '<div class="empty">还没有收藏。练习时点「收藏」按钮，卡片就会出现在这里。</div>';
    } else {
      S.opi.groups.forEach(function (g) {
        var topics = S.opi.topics.filter(function (t) {
          return t.group === g.id && t.items.some(function (c) { return S.ofav[c.n]; });
        });
        if (!topics.length) return;
        html += '<div class="sec-title opi-sec"><h2>' + esc(g.name) + '</h2><span>FAVORITES</span></div>' +
          '<div class="topic-grid">';
        topics.forEach(function (t) {
          var fn = t.items.filter(function (c) { return S.ofav[c.n]; }).length;
          html += '<button class="topic-card fav" data-topic="' + esc(t.id) + '">' +
            '<div class="nm"><span class="fv">★</span> ' + esc(t.name) + '</div>' +
            '<div class="mt"><span>' + fn + ' 问已收藏</span><span>›</span></div></button>';
        });
        html += '</div>';
      });
    }

    render(html + '</div>', true);
    $('#btnOpiBack').onclick = goHome;
    $('#app').onclick = function (e) {
      var b = e.target.closest('[data-topic]');
      if (b) openOpiDeck(b.getAttribute('data-topic'), true);
    };
  }

  /* ================= 模拟对话 ================= */

  var CHAT_DIMS = [
    { k: 'pron', n: '发音' }, { k: 'struct', n: '结构' }, { k: 'vocab', n: '词汇' },
    { k: 'fluency', n: '流畅' }, { k: 'comp', n: '理解' }, { k: 'inter', n: '应对' }
  ];

  function chatReady() {
    var st = S.settings;
    return !!(C && st.chatBase && st.chatModel && st.chatKey);
  }

  function renderOpiChatHome() {
    if (!S.opi) { toast('OPI 数据还没加载好'); return; }
    abortTurn();
    S.view = 'opichathome';
    S.ochat = null;
    $('#tabbar').classList.add('hidden');
    $('#app').classList.add('hide-tabbar');

    var html = '<div class="subpage"><div class="p-bar page-bar">' +
      '<button class="back" id="btnOpiBack"><svg viewBox="0 0 24 24"><path d="M15.4 3.4 7.8 11a1.4 1.4 0 0 0 0 2l7.6 7.6 1.4-1.4L9.6 12l7.2-7.2z"/></svg></button>' +
      '<div class="mid"><div class="t">模拟对话</div><div class="s">OPI 实战演练</div></div>' +
      '<span></span></div>';

    html += '<div class="chat-intro">' +
      '<div class="ci-ico"><svg viewBox="0 0 24 24"><path d="M4 4h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H7l-4 3V6a2 2 0 0 1 2-2z" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="9" cy="10" r="1.3"/><circle cx="13" cy="10" r="1.3"/><circle cx="17" cy="10" r="1.3"/></svg></div>' +
      '<div class="ci-t">考官从 69 个话题中随机抽 3~4 个，最多 15 个问题</div>' +
      '<ul><li>听到考官提问后点麦克风开始作答，<b>说完再点一次麦克风</b>才结束并转文字评分（不会自动停）</li>' +
      '<li>每题答完，考官从<b>发音 / 结构 / 词汇 / 流畅 / 理解 / 应对</b>六方面打分（2~5 分）</li>' +
      '<li>全部问完后给出<b>答题记录、文字总评与雷达图</b></li>' +
      '<li>录音只保留最近 5 次演练，历史记录保留总评与雷达图</li></ul>' +
      '<div class="ci-dep">依赖：① 设置里的「模拟对话模型」；② 语音识别（本地 Qwen3-ASR 或 AI 转写）</div>' +
      (chatReady() ? '' : '<div class="ci-warn">还没有配置对话模型：请到「设置 → 模拟对话模型」填写接口地址、模型名和 API Key。</div>') +
      '<button class="btn-primary" id="btnStartChat"' + (chatReady() ? '' : ' disabled') + '>开始演练</button></div>';

    if (S.chats.length) {
      html += '<div class="sec-title opi-sec"><h2>历史演练</h2><span>最近 ' + S.chats.length + ' 次</span></div>';
      S.chats.slice().reverse().forEach(function (r) {
        var avg = chatAvg(r);
        html += '<button class="chat-rec" data-chatrec="' + r.id + '">' +
          '<div class="l"><div class="t">' + fmtDate(r.ts) + '</div>' +
          '<div class="d">' + r.topics.length + ' 个话题 · ' + r.questions.length + ' 问 · 平均 ' + avg.toFixed(1) + ' 分</div></div>' +
          '<div class="r">ICAO ' + chatIcaoLevel(avg) + '</div></button>';
      });
    }

    render(html + '</div>', true);
    $('#btnOpiBack').onclick = goExam;      // 模拟对话归在「组卷」板块
    var bs = $('#btnStartChat');
    if (bs) bs.onclick = startOpiChat;
    $('#app').onclick = function (e) {
      var b = e.target.closest('[data-chatrec]');
      if (b) showOpiChatRecord(b.getAttribute('data-chatrec'));
    };
  }

  function chatAvg(r) {
    var sum = 0, cnt = 0;
    r.questions.forEach(function (q) {
      if (q.scores) CHAT_DIMS.forEach(function (d) {
        if (typeof q.scores[d.k] === 'number') { sum += q.scores[d.k]; cnt++; }
      });
    });
    return cnt ? sum / cnt : 0;
  }

  /* 六维平均分（2~5）映射为具体 ICAO 等级（取整，行业上岗线为 ICAO 4 工作级）。
     等级中文名用民航局通行译法：3 次工作级 / 4 工作级 / 5 扩展级 / 6 专家级。
     例：总评 3.6 → ICAO 3（次工作级）；4.2 → ICAO 4（工作级）。 */
  var CHAT_ICAO_CN = { 1: '前初级', 2: '初级', 3: '次工作级', 4: '工作级', 5: '扩展级', 6: '专家级' };
  function chatIcaoLevel(v) {
    var lv = Math.floor(v);
    return lv < 1 ? 1 : (lv > 6 ? 6 : lv);
  }
  function chatIcaoText(v) {
    var lv = chatIcaoLevel(v);
    return 'ICAO ' + lv + ' · ' + (CHAT_ICAO_CN[lv] || '');
  }

  /* 抽 3~4 个话题、共 ≤15 问（均匀分配） */
  function chatPick() {
    var topics = S.opi.topics.slice();
    for (var i = topics.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = topics[i]; topics[i] = topics[j]; topics[j] = t;
    }
    var tn = 3 + (Math.random() < 0.4 ? 1 : 0);
    var picked = [];
    for (var k = 0; k < topics.length && picked.length < tn; k++) {
      if (topics[k].items.length >= 2) picked.push(topics[k]);
    }
    if (!picked.length) return null;
    var per = Math.max(3, Math.floor(15 / picked.length));
    var qs = [];
    picked.forEach(function (t) {
      var items = t.items.slice();
      for (var m = items.length - 1; m > 0; m--) {
        var jj = Math.floor(Math.random() * (m + 1));
        var tt = items[m]; items[m] = items[jj]; items[jj] = tt;
      }
      items.slice(0, per).forEach(function (c) {
        qs.push({ n: c.n, q: c.q, cn: c.cn, au: c.au, topic: t.name });
      });
    });
    return { topics: picked.map(function (t) { return t.name; }), qs: qs.slice(0, 15) };
  }

  function startOpiChat() {
    if (!chatReady()) { toast('先到设置里配置「模拟对话模型」'); return; }
    var pick = chatPick();
    if (!pick) { toast('OPI 题库为空'); return; }
    abortTurn();
    S.ctx = 'opichat';
    S.ochat = {
      id: String(Date.now()), ts: Date.now(),
      topics: pick.topics, qs: pick.qs, i: 0,
      answers: pick.qs.map(function () { return null; }),
      phase: 'ask'      // ask -> scoring -> next ... -> done
    };
    renderOpiChatRun();
  }

  function renderOpiChatRun() {
    var oc = S.ochat;
    if (!oc) return renderOpiChatHome();
    var q = oc.qs[oc.i];
    var done = oc.answers.filter(function (x) { return x; }).length;
    S.view = 'opichat';
    $('#tabbar').classList.add('hidden');
    $('#app').classList.add('hide-tabbar');

    var html = '<div class="player"><div class="p-bar">' +
      '<button class="back" id="btnOpiBack"><svg viewBox="0 0 24 24"><path d="M15.4 3.4 7.8 11a1.4 1.4 0 0 0 0 2l7.6 7.6 1.4-1.4L9.6 12l7.2-7.2z"/></svg></button>' +
      '<div class="mid"><div class="t">模拟对话 · 进行中</div>' +
      '<div class="s">' + (oc.i + 1) + ' / ' + oc.qs.length + ' · 已答 ' + done + '</div></div>' +
      '<span class="chat-topic">' + esc(q.topic) + '</span></div>';

    /* 对话流：展示本轮的问题与上一题的反馈 */
    html += '<div class="chat-flow" id="chatFlow">';
    oc.qs.forEach(function (qq, k) {
      if (k > oc.i) return;
      var a = oc.answers[k];
      if (k === oc.i) {
        html += chatBubble('examiner', qq.q, qq.cn, qq.au, true);
      } else if (a) {
        html += chatBubble('examiner', qq.q, '', qq.au, false) +
          '<div class="bub me">' + esc(a.rec || '（没有识别出回答）') + '</div>' +
          (a.scores ? chatScoreChip(a.scores, a.comment) : '');
      }
    });
    html += '</div>';

    var busyTxt = oc.phase === 'scoring' ? '考官评分中…' : '点麦克风开始作答，说完再点一次结束';
    html += '<div class="chat-rec-zone">' +
      '<div class="chat-status" id="chatStatus">' + busyTxt + '</div>' +
      '<div class="rec-line">' +
      '<button class="rec-btn" id="btnRec"><svg viewBox="0 0 24 24"><path d="M12 3a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3zm7 9a7 7 0 0 1-6 6.93V21h-2v-2.07A7 7 0 0 1 5 12h2a5 5 0 0 0 10 0z"/></svg></button>' +
      '<div class="rec-meta"><div class="t" id="recTitle">点击开始作答</div>' +
      '<div class="d" id="recDesc">说完请再点一次麦克风</div>' +
      '<div class="level-meter" id="meter">' + new Array(24).join('<i></i>') + '</div></div>' +
      '<div class="rec-actions"><button class="mini ghost" id="btnPlayRec" disabled>' +
      '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>回放</button>' +
      '<button class="mini ghost" id="btnReplayQ">重听问题</button></div></div></div></div>';

    render(html, true);
    $('#btnOpiBack').onclick = function () {
      sheet('退出演练？', '本次对话进度不会保存。', '退出', function () {
        S.ochat = null;
        renderOpiChatHome();
      }, true);
    };
    var rb = $('#btnRec');
    rb.onclick = function () {
      if (oc.phase === 'scoring') { toast('考官还在评分，稍等'); return; }
      if (S.turn && S.turn.recording) stopTurn(); else startTurn();
    };
    $('#btnPlayRec').onclick = function () { playRec(); };
    $('#btnReplayQ').onclick = function () {
      stopPlay();
      var a = new Audio(opiAu(q.au));
      S.audio = a;
      a.playbackRate = S.settings.rate || 1;
      a.play().catch(function () {});
    };
    var flow = $('#chatFlow');
    if (flow) flow.scrollTop = flow.scrollHeight;
    if (S.settings.autoPlay) setTimeout(function () {
      var a = new Audio(opiAu(q.au));
      a.playbackRate = S.settings.rate || 1;
      a.play().catch(function () {});
    }, 400);
  }

  function chatBubble(role, en, cn, au, current) {
    var h = '<div class="bub examiner">' + esc(en) +
      (cn ? '<div class="bub-cn">' + esc(cn) + '</div>' : '') +
      (au ? '<button class="bub-play" data-playq="' + esc(opiAu(au)) + '"><svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg></button>' : '') +
      '</div>';
    return h;
  }

  function chatScoreChip(scores, comment) {
    var chips = CHAT_DIMS.map(function (d) {
      var v = scores[d.k];
      var c = v >= 4.5 ? 'hi' : (v >= 4 ? 'mid' : (v >= 3 ? 'low' : 'bad'));
      return '<span class="sc ' + c + '">' + d.n + ' ' + (typeof v === 'number' ? v.toFixed(v % 1 ? 1 : 0) : '-') + '</span>';
    }).join('');
    return '<div class="bub score">' + chips +
      (comment ? '<div class="sc-cmt">' + esc(comment) + '</div>' : '') + '</div>';
  }

  /* 报告里用的六维网格：上标签、下分数，一行六格 */
  function scoreGrid(scores, comment) {
    var cells = CHAT_DIMS.map(function (d) {
      var v = scores[d.k];
      var c = v >= 4.5 ? 'hi' : (v >= 4 ? 'mid' : (v >= 3 ? 'low' : 'bad'));
      return '<div class="sg ' + c + '"><span class="n">' + d.n + '</span>' +
        '<span class="v">' + (typeof v === 'number' ? (v % 1 ? v.toFixed(1) : v) : '-') + '</span></div>';
    }).join('');
    return '<div class="score-grid">' + cells + '</div>' +
      (comment ? '<div class="sg-cmt">' + esc(comment) + '</div>' : '');
  }

  /* 录音完成后：选择转写通道（本地模型优先，其次 AI 转写） */
  function chatTranscribe() {
    var oc = S.ochat;
    if (!oc) return;
    oc.phase = 'scoring';
    var st = $('#chatStatus');
    if (st) st.textContent = '语音识别中…';
    var t = S.turn;
    if (localUsable() && t && t.rec && t.rec.url) {
      t.localPending = true;
      try {
        B2.transcribe(t.rec.url);
        setTimeout(function () {
          if (S.ochat === oc && oc.phase === 'scoring' && t.localPending) {
            chatAsrDone({ ok: false, msg: '本地识别超时' });
          }
        }, 100000);
        return;
      } catch (e) { /* 落到 AI */ }
    }
    if (aiReady() && t && t.rec && t.rec.url) {
      t.aiPending = true;
      t.aiName = String(t.rec.url).split('/').pop();
      var bt = $('#recTitle');
      if (bt) bt.textContent = 'AI 转写中…';
      try { B.aiTranscribe(t.rec.url); } catch (e) { chatAsrDone({ ok: false, msg: 'AI 识别调用失败' }); }
      return;
    }
    chatAsrDone({ ok: false, msg: '没有可用的语音识别（本地模型或 AI 转写），请到设置里配置' });
  }

  function chatAsrDone(o) {
    var oc = S.ochat;
    var t = S.turn;
    if (!oc || !t || !t.rec) return;
    if (t.localPending) t.localPending = false;
    if (t.aiPending) t.aiPending = false;
    var text = o.ok ? (o.text || '') : '';
    if (!text) {
      oc.phase = 'ask';
      var st = $('#chatStatus');
      if (st) st.textContent = o.msg || '没有识别出回答，请重录';
      resetTurn();
      toast(o.msg || '没有识别出回答');
      return;
    }
    var st2 = $('#chatStatus');
    if (st2) st2.textContent = '考官评分中…';
    /* 把转写记在 turn 上：评分回来后要写进答题记录（"我的回答"） */
    t.asr = { ok: true, text: text, alts: [text] };
    chatScoreRequest(text);
  }

  /* 每题评分：LLM 返回六维分数 + 简评 */
  function chatScoreRequest(transcript) {
    var oc = S.ochat;
    if (!oc) return;
    var q = oc.qs[oc.i];
    var t = S.turn;
    var messages = [
      { role: 'system', content: CHAT_SCORE_SYS },
      { role: 'user', content: '考官问题：' + q.q + '\n考生回答（语音转写）：' + transcript +
        '\n\n请按六方面打分并给一句简评。严格按 JSON 输出。' }
    ];
    C.chat(JSON.stringify(messages), S.settings.chatBase, S.settings.chatModel,
      S.settings.chatKey, 0.2, 'score:' + oc.i);
  }

  var CHAT_SCORE_SYS =
    '你是中国民航飞行人员英语等级考试（PEPEC）OPI 口试的资深评分员，依据 ICAO 语言等级标准评分。' +
    '对考生的一句英文回答，从六个方面各打一个 2~5 的整数分（5 最高，2 最低，不允许低于2或高于5）：\n' +
    'pron 发音：重音、语调、节奏能否实现交际功能\n' +
    'struct 结构：语法/句型/时态。**作为口语演练，语法不必深究——只要句子能达意、不影响理解就给 4 分**；只有结构混乱到难以理解才降至 3\n' +
    'vocab 词汇：词汇量是否足够、航空用语是否准确丰富\n' +
    'fluency 流畅：语速与停顿是否自然、有无频繁自我修正\n' +
    'comp 理解：是否听懂了问题、回答是否切题\n' +
    'inter 应对：回答速度与内容是否适当、能否达成交际目的\n' +
    '评分要有区分度：答得一般给 3 分，较好给 4 分，只有明显优秀才给 5 分；答非所问或无法完成交际给 2 分。' +
    '语法小错不计入结构分，但发音、词汇、流畅、理解、应对仍按实际表现严格打分。\n' +
    '只输出 JSON，不要任何多余文字：{"pron":n,"struct":n,"vocab":n,"fluency":n,"comp":n,"inter":n,"comment":"一句中文简评，30字内"}';

  var CHAT_FINAL_SYS =
    '你是中国民航飞行人员英语等级考试（PEPEC）OPI 口试的资深考官。刚刚完成一场模拟面试，' +
    '下面是每个问题、考生回答的转写与逐题六维评分（2~5分）。请写一段 150~250 字的中文总评：' +
    '整体水平判断（相当于 ICAO 等级中的几级）、六个维度各自的突出优点与短板、' +
    '下一步最值得练习的两三件事。语气专业、直接、具体，不要客套。' +
    '注意：语法维度作为口语演练不作主要短板，不必因语法小错过度苛责。';

  /* 对话模型结果回调 */
  N.onChat = function (o) {
    if (!o || !S.ochat) { toast((o && o.msg) || '对话模型返回异常'); return; }
    var oc = S.ochat;
    if (o.tag === 'final') {
      if (o.ok) { chatFinalDone(o.text); }
      else {
        var st = $('#chatStatus');
        if (st) st.textContent = o.msg || '总评生成失败';
        toast(o.msg || '总评生成失败');
        // 没有总评也要把记录落库（雷达图还是有的）
        chatFinalDone('');
      }
      return;
    }
    var m = /^score:(\d+)$/.exec(o.tag || '');
    if (!m || +m[1] !== oc.i) return;    // 慢网络下迟到的上一题结果，丢弃
    if (!o.ok) {
      oc.phase = 'ask';
      var st2 = $('#chatStatus');
      if (st2) st2.textContent = o.msg || '评分失败，可重录或重试';
      resetTurn();
      toast(o.msg || '评分失败');
      return;
    }
    var scores = null, comment = '';
    try {
      var txt = (o.text || '').replace(/```json|```/g, '').trim();
      var mm = txt.indexOf('{');
      var me = txt.lastIndexOf('}');
      if (mm >= 0 && me > mm) {
        var j = JSON.parse(txt.slice(mm, me + 1));
        scores = {};
        CHAT_DIMS.forEach(function (d) {
          var v = j[d.k];
          v = typeof v === 'number' ? Math.round(v) : parseFloat(v);
          if (!isFinite(v)) v = 3;
          scores[d.k] = Math.max(2, Math.min(5, v));
        });
        comment = j.comment || '';
      }
    } catch (e) {}
    if (!scores) {
      oc.phase = 'ask';
      var st3 = $('#chatStatus');
      if (st3) st3.textContent = '评分返回格式异常，可重试';
      resetTurn();
      toast('评分返回格式异常');
      return;
    }

    /* 语法不深究，但发音/流畅/词汇/理解/应对照常。
       只要模型认为基本切题（comp>=3）、且回答有实质长度，结构分强制不低于 4。
       其他维度保留模型评分（保持区分度）；模型若判"答非所问/几乎没说"，尊重其低分。 */
    var transcript = (S.turn && S.turn.asr && S.turn.asr.text) || '';
    var words = transcript.trim().split(/\s+/).filter(Boolean).length;
    if (words >= 5 && scores.comp >= 3 && scores.struct < 4) scores.struct = 4;

    var q = oc.qs[oc.i];
    oc.answers[oc.i] = {
      q: q.q, cn: q.cn, topic: q.topic,
      rec: (S.turn && S.turn.asr && S.turn.asr.ok && S.turn.asr.text) || '',
      audio: (S.turn && S.turn.rec && S.turn.rec.url) || '',
      scores: scores, comment: comment
    };
    oc.i++;
    if (oc.i >= oc.qs.length) {
      oc.phase = 'final';
      chatFinalRequest();
    } else {
      oc.phase = 'ask';
      renderOpiChatRun();
    }
  };

  /* 全部问完：请求总评 */
  function chatFinalRequest() {
    var oc = S.ochat;
    var st = $('#chatStatus');
    if (st) st.textContent = '正在生成总评…';
    var lines = oc.answers.map(function (a, k) {
      var sc = a && a.scores ? CHAT_DIMS.map(function (d) { return d.n + a.scores[d.k]; }).join(' ') : '未评分';
      return (k + 1) + '. 问题：' + (a ? a.q : '') + '\n   回答：' + (a && a.rec ? a.rec : '（无）') +
        '\n   评分：' + sc;
    }).join('\n');
    var messages = [
      { role: 'system', content: CHAT_FINAL_SYS },
      { role: 'user', content: '话题：' + oc.topics.join('、') + '\n' + lines }
    ];
    C.chat(JSON.stringify(messages), S.settings.chatBase, S.settings.chatModel,
      S.settings.chatKey, 0.5, 'final');
  }

  function chatFinalDone(finalText) {
    var oc = S.ochat;
    if (!oc) return;
    var rec = {
      id: oc.id, ts: Date.now(), topics: oc.topics,
      questions: oc.answers.map(function (a) { return a || {}; }),
      final: finalText || ''
    };
    var recs = load(K_OCHAT, []);
    recs.push(rec);
    if (recs.length > 20) recs = recs.slice(-20);
    save(K_OCHAT, recs);
    S.chats = recs;
    /* 录音只留最近 5 次演练 */
    if (B && B.pruneChatAudio) {
      try {
        B.pruneChatAudio(recs.slice(-5).map(function (r) { return r.id; }).join(','));
      } catch (e) {}
    }
    S.ochat = null;
    showOpiChatResult(rec);
  }

  function renderOpiChatResult(rec) {
    S.view = 'opichatresult';
    S.resultChat = rec;
    $('#tabbar').classList.add('hidden');
    $('#app').classList.add('hide-tabbar');

    var html = '<div class="subpage"><div class="p-bar page-bar">' +
      '<button class="back" id="btnOpiBack"><svg viewBox="0 0 24 24"><path d="M15.4 3.4 7.8 11a1.4 1.4 0 0 0 0 2l7.6 7.6 1.4-1.4L9.6 12l7.2-7.2z"/></svg></button>' +
      '<div class="mid"><div class="t">演练报告</div><div class="s">' + fmtDate(rec.ts) + '</div></div>' +
      '<span></span></div>';

    var avg = chatAvg(rec);
    html += '<div class="chat-result-head">' +
      radarSvg(rec, 190) +
      '<div class="cr-info"><div class="big">' + avg.toFixed(1) + '</div>' +
      '<div class="lbl">六维平均分（满分 5）</div>' +
      '<div class="lvl">' + chatIcaoText(avg) + '</div></div></div>';

    if (rec.final) {
      html += '<div class="chat-final"><div class="t">考官总评</div><div class="d">' +
        esc(rec.final).replace(/\n/g, '<br>') + '</div></div>';
    }

    html += '<div class="sec-title opi-sec"><h2>答题记录</h2><span>' + rec.questions.length + ' 问</span></div>';
    rec.questions.forEach(function (a, k) {
      var hasAudio = a.audio && recKeep(a);
      html += '<div class="ans-card">' +
        '<div class="ah"><span class="ano">' + (k + 1) + '</span>' +
        '<span class="atag l4">' + esc(a.topic || '') + '</span></div>' +
        '<div class="aen">' + esc(a.q || '') + '</div>' +
        (a.cn ? '<div class="acn">' + esc(a.cn) + '</div>' : '') +
        (a.rec ? '<div class="arec">我的回答：' + esc(a.rec) + '</div>' : '') +
        (a.scores ? '<div class="aplay" style="display:block">' + scoreGrid(a.scores, a.comment) + '</div>' : '') +
        (hasAudio ? '<div class="aplay"><button class="mini ghost" data-play="' + esc(a.audio) + '">' +
          '<svg class="jico" viewBox="0 0 24 24"><path d="M12 3a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3zm7 9a7 7 0 0 1-6 6.93V21h-2v-2.07A7 7 0 0 1 5 12h2a5 5 0 0 0 10 0z"/></svg>我的录音</button></div>' : '') +
        '</div>';
    });

    html += '<button class="btn-primary" id="btnChatAgain">再练一次</button>' +
      '<button class="btn-danger" style="margin-top:10px;margin-bottom:8px" id="btnChatBack">返回</button>';

    render(html + '</div>', true);
    $('#btnOpiBack').onclick = renderOpiChatHome;
    $('#btnChatBack').onclick = renderOpiChatHome;
    $('#btnChatAgain').onclick = startOpiChat;
    $('#app').onclick = function (e) {
      var b = e.target.closest('[data-play]');
      if (b) {
        stopRecAudio();
        var au = new Audio(b.getAttribute('data-play'));
        S.recAudio = au;
        b.classList.add('playing');
        au.onended = function () { b.classList.remove('playing'); if (S.recAudio === au) stopRecAudio(); };
        au.onerror = function () { toast('录音文件已不存在'); b.classList.remove('playing'); };
        au.play().catch(function () { toast('回放失败'); });
      }
      var pq = e.target.closest('[data-playq]');
      if (pq) {
        stopPlay();
        var a2 = new Audio(pq.getAttribute('data-playq'));
        S.audio = a2;
        a2.playbackRate = S.settings.rate || 1;
        a2.play().catch(function () {});
      }
    };
  }

  /* 该记录的录音是否还在保留期内（最近 5 次演练） */
  function recKeep(rec) {
    var ids = S.chats.slice(-5).map(function (r) { return r.id; });
    return ids.indexOf(rec.id) >= 0;
  }

  function showOpiChatResult(rec) {
    if (typeof rec === 'number') {
      rec = S.chats.filter(function (r) { return String(r.id) === String(rec); })[0];
    }
    if (!rec) { toast('记录不存在'); return; }
    renderOpiChatResult(rec);
  }

  function showOpiChatRecord(id) {
    var rec = S.chats.filter(function (r) { return String(r.id) === String(id); })[0];
    if (!rec) { toast('记录不存在'); return; }
    renderOpiChatResult(rec);
  }

  /* 六维雷达图（纯 SVG，不依赖任何库） */
  function radarSvg(rec, size) {
    var cx = size / 2, cy = size / 2, R = size / 2 - 26;
    var N = 6;
    var pt = function (k, r) {
      var ang = -Math.PI / 2 + k * 2 * Math.PI / N;
      return [cx + r * Math.cos(ang), cy + r * Math.sin(ang)];
    };
    /* 平均每个维度的分数 */
    var vals = CHAT_DIMS.map(function (d) {
      var sum = 0, cnt = 0;
      rec.questions.forEach(function (q) {
        if (q.scores && typeof q.scores[d.k] === 'number') { sum += q.scores[d.k]; cnt++; }
      });
      return cnt ? sum / cnt : 2;
    });
    var rings = [2, 3, 4, 5];
    var ringsHtml = rings.map(function (rv) {
      var r = R * (rv - 2) / 3;
      var p = [];
      for (var k = 0; k < N; k++) {
        var xy = pt(k, Math.max(r, 1));
        p.push(xy[0].toFixed(1) + ',' + xy[1].toFixed(1));
      }
      return '<polygon points="' + p.join(' ') + '" fill="' + (rv === 5 ? 'rgba(139,92,246,.05)' : 'none') +
        '" stroke="rgba(127,140,160,.35)" stroke-width="1" stroke-dasharray="' + (rv === 5 ? '0' : '3,3') + '"/>';
    }).join('');
    var axes = CHAT_DIMS.map(function (d, k) {
      var xy = pt(k, R);
      var lp = pt(k, R + 14);
      return '<line x1="' + cx + '" y1="' + cy + '" x2="' + xy[0].toFixed(1) + '" y2="' + xy[1].toFixed(1) +
        '" stroke="rgba(127,140,160,.25)" stroke-width="1"/>' +
        '<text x="' + lp[0].toFixed(1) + '" y="' + lp[1].toFixed(1) + '" font-size="11" fill="#5a6b85" ' +
        'text-anchor="middle" dominant-baseline="middle">' + d.n +
        (vals[k] ? ' ' + vals[k].toFixed(1) : '') + '</text>';
    }).join('');
    var poly = vals.map(function (v, k) {
      var xy = pt(k, Math.max(R * (Math.max(2, Math.min(5, v)) - 2) / 3, 2));
      return xy[0].toFixed(1) + ',' + xy[1].toFixed(1);
    }).join(' ');
    var dots = vals.map(function (v, k) {
      var xy = pt(k, Math.max(R * (Math.max(2, Math.min(5, v)) - 2) / 3, 2));
      return '<circle cx="' + xy[0].toFixed(1) + '" cy="' + xy[1].toFixed(1) + '" r="3" fill="#8b5cf6"/>';
    }).join('');
    return '<svg class="radar" width="' + size + '" height="' + size + '" viewBox="0 0 ' + size + ' ' + size + '">' +
      ringsHtml + axes +
      '<polygon points="' + poly + '" fill="rgba(139,92,246,.22)" stroke="#8b5cf6" stroke-width="2" stroke-linejoin="round"/>' +
      dots + '</svg>';
  }

  function goHome() {
    go('home');
  }
  function goExam() {
    go('exam');
  }

  /* ------------------------------------------------ 导航 */
  var TABS = { home: renderHome, exam: renderExam, record: renderRecord, settings: renderSettings };
  function go(tab) {
    abortTurn();
    S.tab = tab;
    document.querySelectorAll('.tabbar .tab').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-tab') === tab);
    });
    $('#tabbar').classList.remove('hidden');
    $('#app').classList.remove('hide-tabbar');
    S.view = tab;
    TABS[tab]();
  }

  /* ------------------------------------------------ 启动 */
  function boot() {
    S.progress = load(K_PROG, {});
    S.exams = load(K_EXAM, []);
    S.positions = load(K_POS, {});
    S.lastRec = load(K_LASTREC, null);
    S.ofav = load(K_OFAV, {});
    S.opass = load(K_OPASS, {});
    S.chats = load(K_OCHAT, []);
    S.settings = Object.assign({
      asr: true, online: true, autoPlay: true, showCn: true, rate: 1, opiVoice: 'f',
      theme: 'auto',
      ai: false, aiBase: 'https://api.openai.com/v1', aiModel: 'whisper-1', aiKey: '',
      localAsr: false,
      chatBase: 'https://api.openai.com/v1', chatModel: 'gpt-4o-mini', chatKey: ''
    }, load(K_SET, {}));

    /* 主题尽早生效（index.html 里已按 localStorage 预置过一次，这里用合并后的设置校正），
       并挂上"跟随系统"的监听 */
    applyTheme();
    watchSystemTheme();

    fetch('data.json').then(function (r) { return r.json(); }).then(function (d) {
      S.data = d;
      S.items = d.items;
      S.chapters = d.chapters;
      d.items.forEach(function (x) { S.byNum[x.n] = x; });
      document.querySelectorAll('.tabbar .tab').forEach(function (b) {
        b.addEventListener('click', function () { go(b.getAttribute('data-tab')); });
      });
      go('home');
      syncAsrMode();
      syncLocal();
      syncAi();
      /* OPI 数据独立加载：加载完刷新首页（首页此时多半已渲染，补一次即可） */
      fetch('opi.json').then(function (r) { return r.json(); }).then(function (od) {
        S.opi = od;
        if (S.view === 'home' && S.tab === 'home') renderHome();
      }).catch(function (e) { toast('OPI 数据加载失败：' + (e && e.message || e)); });
      if (window.ICAOBridge && window.ICAOBridge.ready) {
        try { window.ICAOBridge.ready(); } catch (e) {}
      }
    }).catch(function (e) {
      $('#app').innerHTML = '<div class="empty">数据加载失败：' + esc(e && e.message || e) + '</div>';
    });
  }

  window.ICAOBack = function () {
    var toc = document.querySelector('#tocWrap');
    if (toc && !toc.classList.contains('hidden')) { closeToc(); return true; }
    if (S.ochat && S.view === 'opichat') {
      sheet('退出演练？', '本次对话进度不会保存。', '退出', function () {
        abortTurn();
        S.ochat = null;
        renderOpiChatHome();
      }, true);
      return true;
    }
    if (S.view === 'opichatresult') { renderOpiChatHome(); return true; }
    if (S.odeck) { closeOpiDeck(); return true; }
    if (S.view === 'opitoc' || S.view === 'opifav') { goHome(); return true; }
    if (S.view === 'opichathome') { goExam(); return true; }
    if (S.deck) { closeDeck(); return true; }
    if (S.exam && S.view === 'result') { backToExam(); return true; }
    if (S.exam) {
      sheet('退出考试？', '当前进度将不会保存。', '退出', function () {
        S.exam = null;
        $('#tabbar').classList.remove('hidden');
        $('#app').classList.remove('hide-tabbar');
        go('exam');
      }, true);
      return true;
    }
    if (S.view !== S.tab) { go(S.tab); return true; }
    return false;
  };

  /* 息屏/切屏回来偶发白屏（WebView 渲染面丢失）：可见性恢复时抖一次合成层强制出新帧。
     opacity 0.999 肉眼不可见、不影响布局，是比 transform 更安全的重绘触发方式。 */
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState !== 'visible') return;
    document.body.style.opacity = '0.999';
    setTimeout(function () { document.body.style.opacity = ''; }, 80);
  });

  document.addEventListener('DOMContentLoaded', boot);
  if (document.readyState !== 'loading') boot();
})();
