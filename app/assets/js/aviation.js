/* aviation.js — 民航英语发音规则 + 评分引擎
 *
 * 1) 书面/识别文本 -> 可比较的 token 串：
 *      FL310 / "flight level three one zero" -> flight, level, 310
 *      "Runway 36 Right"                     -> runway, 36, right
 *      QNH / "q n h"                         -> qnh
 *      "niner tree fife"                     -> 9, 3, 5   （ICAO 发音同化）
 *      "3,000" / "3-0-0-0" / "three thousand" -> 3000
 *      "we're" / "we are"                     -> we, are
 * 2) token 级加权对齐：功能词（冠词/介词/助动词）权重 0.35，实词权重 1.0，
 *    实词里数字、否定词权重更高，读错才真正影响分数；
 * 3) 按 level 3 / level 4+ 两套规则给分。
 *
 * 评分基准串（item.s）与识别串走完全相同的 tokenize，避免"文字形式不同、
 * 读音相同"被误判（这是旧版 65% 准确率的主因之一）。
 */
(function (global) {
  'use strict';

  var NUM_WORDS = {
    zero: 0, oh: 0, o: 0, one: 1, two: 2, three: 3, tree: 3, four: 4, fower: 4,
    five: 5, fife: 5, six: 6, seven: 7, eight: 8, ate: 8, nine: 9, niner: 9, liner: 9,
    ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
    sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
    thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80,
    ninety: 90, hundred: 100, thousand: 1000
  };

  /* ICAO 字母单词 -> 单字母 */
  var LETTERS = {
    alfa: 'a', alpha: 'a', bravo: 'b', charlie: 'c', delta: 'd', echo: 'e',
    foxtrot: 'f', golf: 'g', hotel: 'h', india: 'i', juliett: 'j', juliet: 'j',
    kilo: 'k', lima: 'l', mike: 'm', november: 'n', oscar: 'o', papa: 'p',
    quebec: 'q', romeo: 'r', sierra: 's', tango: 't', uniform: 'u',
    victor: 'v', whiskey: 'w', whisky: 'w', xray: 'x', yankee: 'y', zulu: 'z'
  };

  /* 同音/近音归一 */
  var ALIAS = {
    'x-ray': 'xray', whisky: 'whiskey', alpha: 'alfa', juliet: 'juliett',
    'o.k': 'okay', ok: 'okay', 'flightlevel': 'flight',
    dec: 'decimal', deci: 'decimal', 'point': 'decimal',
    'centre': 'center', 'metre': 'meter', 'litre': 'liter',
    'acknowledge': 'acknowledge',
    /* 机型："Boeing 747" 与 "B747" 是同一句，识别常把字母读成机型名 */
    boeing: 'b', airbus: 'a',
    /* 进近类别："CAT II" 与 "category two" 是同一句 */
    category: 'cat', ii: '2', iii: '3'
  };

  /* 报告点方位字母与单词互换：42N = 42 North、150W = 150 West */
  var DIR = { n: 'north', s: 'south', e: 'east', w: 'west' };

  var RUNWAY_LETTER = { l: 'left', r: 'right', c: 'center' };

  /* 功能词：冠词、介词、助动词、代词——读漏/识别漏都不该毁掉整句 */
  var STOP = {};
  ('a an the of to and or but is are was were be been being am do does did ' +
   'will would shall should can could may might must have has had having ' +
   'we you i he she it they them us our your my his her their its this that ' +
   'these those there here as at in on for with from by about please now ' +
   'then so cos because decimal').split(' ').forEach(function (w) { STOP[w] = 1; });

  /* 数字/否定：权重加倍，读错就是错 */
  var CRITICAL = { not: 1, no: 1, never: 1, without: 1, unable: 1 };

  /* 一串数字词 -> 单个数字串
   *  three one zero      -> 310     （逐位读）
   *  three thousand      -> 3000
   *  two hundred fifty   -> 250
   *  three ten           -> 310
   */
  function mergeRun(nums) {
    var total = 0, chunk = '', afterScale = false;
    for (var i = 0; i < nums.length; i++) {
      var v = nums[i];
      if (v >= 1000) {
        total += (chunk === '' ? 1 : parseInt(chunk, 10)) * v;
        chunk = ''; afterScale = false;
      } else if (v === 100) {
        chunk = String((chunk === '' ? 1 : parseInt(chunk, 10)) * 100);
        afterScale = true;
      } else if (v % 10 === 0 && v >= 20 && v <= 90 &&
                 i + 1 < nums.length && nums[i + 1] < 10) {
        var add = v + nums[i + 1];
        i++;
        chunk = afterScale ? String((chunk === '' ? 0 : parseInt(chunk, 10)) + add)
                           : chunk + String(add);
      } else {
        chunk = afterScale ? String((chunk === '' ? 0 : parseInt(chunk, 10)) + v)
                           : chunk + String(v);
      }
    }
    return String(total + (chunk === '' ? 0 : parseInt(chunk, 10)));
  }

  /* 连续单字母合并：m e a -> mea；q n h -> qnh */
  function collapseLetters(toks) {
    var out = [], buf = [];
    function flush() {
      if (buf.length >= 2) out.push(buf.join(''));
      else if (buf.length === 1) out.push(buf[0]);
      buf = [];
    }
    for (var i = 0; i < toks.length; i++) {
      var t = String(toks[i]);
      if (/^[a-z]$/.test(t)) buf.push(t);
      else { flush(); out.push(toks[i]); }
    }
    flush();
    return out;
  }

  /* 连续 ICAO 字母词合并：mike quebec romeo -> mqr
   * 单个字母词保持原样（"transponder charlie" 里的 charlie 就是单词本身） */
  function collapseLetterWords(toks) {
    var out = [], buf = [];
    function flush() {
      if (buf.length >= 2) out.push(buf.join(''));
      else if (buf.length === 1) out.push(buf[0]);
      buf = [];
    }
    for (var i = 0; i < toks.length; i++) {
      var t = String(toks[i]);
      if (Object.prototype.hasOwnProperty.call(LETTERS, t)) buf.push(LETTERS[t]);
      else { flush(); out.push(toks[i]); }
    }
    flush();
    return out;
  }

  /* "AlphaKilo" 这类连写的字母词拆成 a k（识别偶尔不给空格） */
  function splitIcao(w) {
    if (w.length < 6) return null;
    var out = [], i = 0;
    while (i < w.length) {
      var hit = null;
      for (var len = 8; len >= 3; len--) {
        var seg = w.substr(i, len);
        if (Object.prototype.hasOwnProperty.call(LETTERS, seg)) { hit = seg; break; }
      }
      if (!hit) return null;
      out.push(LETTERS[hit]);
      i += hit.length;
    }
    return out.length >= 2 ? out : null;
  }

  /* 文本 -> token 数组 */
  function tokenize(text) {
    if (!text) return [];
    var t = ' ' + String(text).toLowerCase() + ' ';
    t = t.replace(/[\u2018\u2019`\u00b4]/g, "'");

    /* 缩写展开：必须在去标点之前做（否则 we're -> we re） */
    t = t.replace(/\bwon't\b/g, 'will not').replace(/\bcan't\b/g, 'can not')
         .replace(/\bcannot\b/g, 'can not')
         .replace(/n't\b/g, ' not')
         .replace(/'re\b/g, ' are').replace(/'ll\b/g, ' will')
         .replace(/'ve\b/g, ' have').replace(/'m\b/g, ' am')
         .replace(/'d\b/g, ' would').replace(/'s\b/g, 's');

    t = t.replace(/\bfl\s?(\d{2,3})\b/g, 'flight level $1')
         .replace(/\bflightlevel\b/g, 'flight level')
         .replace(/\brwy\b/g, 'runway')
         /* 千分位：3,000 -> 3000（必须在标点切分之前） */
         .replace(/(\d{1,3}),(\d{3})\b/g, '$1$2')
         .replace(/(\d{1,3}),(\d{3})\b/g, '$1$2')
         /* "2.70" 这种个位数+两位小数，几乎都是逐位读的高度/速度，直接拼回 270 */
         .replace(/\b(\d)\.(\d{2,3})\b/g, '$1$2')
         .replace(/(\d)\s*\.\s*(\d)/g, '$1 decimal $2')
         .replace(/(\d{2})\s*([lrc])\b/g, function (m, d, c) {
           return d + ' ' + RUNWAY_LETTER[c];
         })
         .replace(/([a-z])(\d)/g, '$1 $2')
         .replace(/(\d)([a-z])/g, '$1 $2')
         /* 连字符/破折号当空白：de-icing -> de icing，8-2 -> 8 2 */
         .replace(/[\u2010\u2011\u2012\u2013\u2014\-\u2015]/g, ' ')
         .replace(/[.,;:!?"'`()[\]{}\/_|]/g, ' | ')
         .replace(/\s+/g, ' ');

    var raw = t.split(' '), out = [], run = [];
    function flush() {
      if (run.length) { out.push(mergeRun(run)); run = []; }
    }
    for (var i = 0; i < raw.length; i++) {
      var w = raw[i];
      if (!w) continue;
      if (w === '|') { flush(); continue; }
      /* ASR 把 "niner zero" 听成 "nine or zero"：数字之间的 or 当零位 */
      if (w === 'or' && run.length && i + 1 < raw.length &&
          (/^\d+$/.test(raw[i + 1]) ||
           Object.prototype.hasOwnProperty.call(NUM_WORDS, raw[i + 1]))) {
        continue;
      }
      if (/^\d+$/.test(w)) { run.push(parseInt(w, 10)); continue; }
      if (Object.prototype.hasOwnProperty.call(NUM_WORDS, w) && w !== 'o' && w !== 'oh') {
        run.push(NUM_WORDS[w]); continue;
      }
      flush();
      var al = ALIAS[w] || w;
      var parts = splitIcao(al);
      if (parts) { for (var k = 0; k < parts.length; k++) out.push(parts[k]); }
      else out.push(al);
    }
    flush();
    return collapseLetters(collapseLetterWords(out));
  }

  /* 词形归一：复数/时态/同义拼写 */
  function key(tok) {
    var s = String(tok);
    if (/^\d+$/.test(s)) return '#' + s;
    s = ALIAS[s] || s;
    if (s.length <= 1) return s;
    s = s.replace(/ph/g, 'f').replace(/ck/g, 'k').replace(/qu/g, 'kw')
         .replace(/wh/g, 'w').replace(/x/g, 'ks')
         .replace(/([a-z])\1+/g, '$1');
    if (s.length >= 4 && !/(ss|us|is|ous|ics)$/.test(s)) s = s.replace(/s$/, '');
    if (s.length >= 5) s = s.replace(/(ing|ed)$/, '');
    s = s.replace(/e$/, '');
    return s;
  }

  /* 辅音骨架：吸收近音误识别（right/write、weather/whether、to/too）
   * 识别器把 "descend" 写成 "they sent"、"three" 写成 "tree" 这类，
   * 差别都在 th / 软音 c / 清浊辅音上，先按发音归一再取骨架。 */
  function skel(tok) {
    var s = key(tok).replace(/[^a-z]/g, '');
    if (s.length <= 2) return s;
    s = s.replace(/^kn/, 'n').replace(/^wr/, 'r')
         .replace(/ph/g, 'f')
         .replace(/th/g, 't')          // they -> tey、three -> tree
         .replace(/sh/g, 's')
         .replace(/ch/g, 'k')
         .replace(/ck/g, 'k')
         .replace(/q/g, 'k')
         .replace(/z/g, 's').replace(/v/g, 'f').replace(/b/g, 'p')
         .replace(/d/g, 't').replace(/g/g, 'k')
         /* c 在 e/i/y 前读 /s/（descend 的 sc），其余读 /k/ */
         .replace(/c(?=[eiy])/g, 's').replace(/c/g, 'k');
    s = s.replace(/([a-z])\1+/g, '$1');
    var out = s.charAt(0);
    for (var i = 1; i < s.length; i++) {
      if ('aeiouy'.indexOf(s.charAt(i)) < 0) out += s.charAt(i);
    }
    return out.replace(/([a-z])\1+/g, '$1');
  }

  function lev(a, b) {
    var m = a.length, n = b.length;
    if (!m) return n;
    if (!n) return m;
    var prev = new Array(n + 1), cur = new Array(n + 1), i, j;
    for (j = 0; j <= n; j++) prev[j] = j;
    for (i = 1; i <= m; i++) {
      cur[0] = i;
      for (j = 1; j <= n; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1,
          prev[j - 1] + (a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1));
      }
      var tmp = prev; prev = cur; cur = tmp;
    }
    return prev[n];
  }

  function isLetterWord(w) {
    return Object.prototype.hasOwnProperty.call(LETTERS, w);
  }

  /* 实测过的"识别把字母代码听少一个"：
   * 只收真实出现过的组合，不做通用规则——否则 RVSM 少一个 S 也会被放行，
   * 那属于真的读错，不能放过。 */
  var ASR_CODE = { qh: 'qnh', qnh: 'qnh', qn: 'qnh' };

  /* token 相似度：1 完全一致 / 0.9 近音 / 0.55 勉强 / 0 错 */
  function sim(a, b) {
    if (a === b) return 1;
    /* 单字母 vs ICAO 字母词：C / Charlie 等价 */
    if (a.length === 1 && isLetterWord(b) && LETTERS[b] === a) return 1;
    if (b.length === 1 && isLetterWord(a) && LETTERS[a] === b) return 1;
    if (ASR_CODE[a] && ASR_CODE[a] === ASR_CODE[b]) return 1;
    /* 方位字母 ↔ 单词：N / North、W / West */
    if (DIR[a] && DIR[a] === b) return 1;
    if (DIR[b] && DIR[b] === a) return 1;
    if (DIR[a] && DIR[a] === DIR[b]) return 1;

    var ka = key(a), kb = key(b);
    if (ka === kb) return 1;

    var da = /^#?\d+$/.test(ka), db = /^#?\d+$/.test(kb);
    if (da || db) {
      if (!(da && db)) return 0;          // 数字 vs 文字，肯定不是同一个词
      var sa = ka.replace('#', ''), sb = kb.replace('#', '');
      if (sa === sb) return 1;
      var dn = lev(sa, sb), ln = Math.max(sa.length, sb.length);
      return (1 - dn / ln) >= 0.8 ? 0.55 : 0;   // 高度/频率错一位不能算对
    }

    var d = lev(ka, kb), L = Math.max(ka.length, kb.length);
    var r = L ? 1 - d / L : 0;
    if (r >= 0.8) return 0.9;
    if (skel(a) === skel(b)) return 0.9;
    if (r >= 0.62) return 0.55;
    return 0;
  }

  /* 功能词判定：先按原形查，再按归一形查（key 会砍掉词尾 e，the -> th） */
  function isStop(tok) {
    var t = String(tok);
    return !!(STOP[t] || STOP[key(t)]);
  }

  function weightOf(tok) {
    var k = key(tok);
    /* 每个词等权：Level 3 要求"一个词都不能错"，功能词不能打折；
     * 数字与否定词仍略加权，让 Level 4 的百分比更贴近实际严重程度。 */
    if (CRITICAL[k] || CRITICAL[tok]) return 1.6;
    if (/^\d/.test(k)) return 1.4;
    return 1;
  }

  /* 期望串 vs 识别串：加权保序对齐
   *
   * 除了常规的 1↔1 匹配、漏词、多词，还支持"识别把单词切成了两半"：
   *   expected: descend        got: they sent
   * 这类错误在识别结果里很常见（连读、词边界判断），单靠 1↔1 对齐会整句判错。
   * 合并匹配的权重仍按被匹配的那个期望词算，分母不变，不会稀释严格度。 */
  function align(expected, got) {
    var m = expected.length, n = got.length;
    var dp = [], how = [], i, j;
    for (i = 0; i <= m; i++) {
      dp.push(new Array(n + 1).fill(0));
      how.push(new Array(n + 1).fill(0));
    }
    var sims = [];
    for (i = 0; i < m; i++) {
      sims.push(new Array(n));
      for (j = 0; j < n; j++) sims[i][j] = sim(expected[i], got[j]);
    }
    for (i = 1; i <= m; i++) how[i][0] = 2;      // 剩下的期望词都算漏读

    /* how: 1 多出一个识别词 / 2 漏词 / 3 合并两个识别词 / 4 一对一匹配 */
    for (i = 1; i <= m; i++) {
      var wi = weightOf(expected[i - 1]);
      for (j = 1; j <= n; j++) {
        var best = dp[i][j - 1], h = 1;
        if (dp[i - 1][j] > best) { best = dp[i - 1][j]; h = 2; }
        if (j >= 2) {
          var sm = sim(expected[i - 1], String(got[j - 2]) + String(got[j - 1]));
          if (sm > 0) {
            var cm = dp[i - 1][j - 2] + wi * sm;
            if (cm > best) { best = cm; h = 3; }
          }
        }
        if (sims[i - 1][j - 1] > 0) {
          var c = dp[i - 1][j - 1] + wi * sims[i - 1][j - 1];
          if (c > best) { best = c; h = 4; }
        }
        dp[i][j] = best; how[i][j] = h;
      }
    }

    /* 回溯 */
    var detail = new Array(m);
    i = m; j = n;
    while (i > 0 && j > 0) {
      var hv = how[i][j];
      if (hv === 4) {
        detail[i - 1] = { w: expected[i - 1], ok: sims[i - 1][j - 1], got: got[j - 1],
                          wgt: weightOf(expected[i - 1]) };
        i--; j--;
      } else if (hv === 3) {
        var joined = String(got[j - 2]) + String(got[j - 1]);
        detail[i - 1] = { w: expected[i - 1], ok: sim(expected[i - 1], joined),
                          got: got[j - 2] + ' ' + got[j - 1],
                          wgt: weightOf(expected[i - 1]), merged: true };
        i--; j -= 2;
      } else if (hv === 2) {
        detail[i - 1] = { w: expected[i - 1], ok: 0, got: null, wgt: weightOf(expected[i - 1]) };
        i--;
      } else {
        j--;
      }
    }
    while (i > 0) {
      detail[i - 1] = { w: expected[i - 1], ok: 0, got: null, wgt: weightOf(expected[i - 1]) };
      i--;
    }

    /* 准确率按全部词统计（含冠词/介词/助动词）：
     * 0.9 的近音/词形差异（malfunction / malfunctioned）计为正确，
     * 0.55 的勉强对、0 的错/漏都算错——Level 3 要求一个词都不错。 */
    var sum = 0, tw = 0, miss = 0, near = 0;
    for (i = 0; i < m; i++) {
      var d = detail[i], s = d.ok >= 0.85 ? 1 : d.ok;
      sum += d.wgt * s; tw += d.wgt;
      if (d.ok < 0.85) miss++;
      else if (d.ok < 1) near++;
    }
    var acc = tw ? sum / tw : 0;
    return {
      acc: acc,
      core: acc,
      detail: detail,
      total: m,
      miss: miss,
      near: near
    };
  }

  /* 规则打分：Level 3 一个词都不能错（含冠词/介词）；Level 4+ 90% / 60% 两档 */
  function grade(level, r) {
    var acc = r.acc;
    if (level <= 3) return acc >= 0.999 ? 1 : 0;
    if (acc >= 0.9) return 1;
    if (acc >= 0.6) return 0.5;
    return 0;
  }

  /* 数字合并变体：118 decimal 35 -> 11835
   * 识别结果有时把小数拆开、有时又粘在一起，两种写法都当作同一句话 */
  function digitMerged(toks) {
    var out = [], buf = '';
    for (var i = 0; i < toks.length; i++) {
      var t = String(toks[i]);
      if (/^\d+$/.test(t)) { buf += t; continue; }
      if (t === 'decimal' && buf) continue;
      if (buf) { out.push(buf); buf = ''; }
      out.push(t);
    }
    if (buf) out.push(buf);
    return out;
  }

  /* 把相邻两个词拼起来，前提是拼出的形式在对端词表里存在
   *  center + line -> centerline（识别常把复合词写成一个词） */
  function joinByPeer(seq, peerSet) {
    var out = [], i = 0, changed = false;
    while (i < seq.length) {
      var a = String(seq[i]), b = i + 1 < seq.length ? String(seq[i + 1]) : '';
      if (b && /^[a-z]+$/.test(a) && /^[a-z]+$/.test(b) && peerSet[a + b]) {
        out.push(a + b); i += 2; changed = true;
      } else {
        out.push(seq[i]); i++;
      }
    }
    return changed ? out : seq;
  }

  function sameSeq(a, b) {
    if (a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  /* 对外：一次评分 */
  function evaluate(item, asrText) {
    var exp = tokenize(item.s || item.en || '');
    var got = tokenize(asrText);

    var expSet = {}, gotSet = {};
    exp.forEach(function (t) { expSet[t] = 1; });
    got.forEach(function (t) { gotSet[t] = 1; });

    var exps = [exp, digitMerged(exp), joinByPeer(exp, gotSet)];
    var gots = [got, digitMerged(got), joinByPeer(got, expSet)];

    var best = null, bestScore = -1;
    for (var a = 0; a < exps.length; a++) {
      for (var b = 0; b < gots.length; b++) {
        var r = align(exps[a], gots[b]);
        var sc = grade(item.lv, r);
        if (sc > bestScore || (sc === bestScore && (!best || r.acc > best.acc))) {
          best = r; bestScore = sc;
        }
      }
    }
    if (!best) best = align(exp, got);
    return {
      acc: best.acc,
      core: best.core,
      score: bestScore < 0 ? grade(item.lv, best) : bestScore,
      detail: best.detail,
      expected: exp,
      got: got,
      miss: best.miss,
      near: best.near
    };
  }

  /* 多个识别候选，取最好的一版（离线识别常把同一句给出 2~3 种写法） */
  function evaluateBest(item, texts) {
    var best = null;
    for (var i = 0; i < (texts || []).length; i++) {
      var txt = texts[i];
      if (!txt) continue;
      var r = evaluate(item, txt);
      r.recognized = txt;
      if (!best || r.score > best.score || (r.score === best.score && r.acc > best.acc)) best = r;
    }
    return best || evaluate(item, '');
  }

  /* 声学近似评分（无语音识别时）：按"朗读时长覆盖度"折算 */
  function acousticScore(item, voicedMs, expectedMs) {
    var ratio = expectedMs > 0 ? voicedMs / expectedMs : 0;
    var acc;
    if (ratio <= 0.05) acc = 0;
    else if (ratio < 0.45) acc = ratio / 0.45 * 0.5;
    else if (ratio <= 1.55) acc = 0.75 + 0.25 * (1 - Math.abs(1 - ratio) / 0.55);
    else acc = Math.max(0.5, 0.9 - (ratio - 1.55) * 0.3);
    acc = Math.min(1, Math.max(0, acc));
    var r = { acc: acc };
    return { acc: acc, score: grade(item.lv, r), acoustic: true };
  }

  global.Aviation = {
    tokenize: tokenize,
    key: key,
    skel: skel,
    sim: sim,
    align: align,
    grade: grade,
    evaluate: evaluate,
    evaluateBest: evaluateBest,
    acousticScore: acousticScore,
    NUM_WORDS: NUM_WORDS
  };
})(typeof window !== 'undefined' ? window : globalThis);
