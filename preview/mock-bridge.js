/* 本地预览用的假原生桥（只在 preview 目录，不会打进 APK）。
   preview 的 stage() 会把它复制到站点根，index.html 在 http: 下才加载它。 */
(function () {
  var recN = 0;

  window.ICAOBridge = {
    ready: function () { window.Host && Host.onReady && Host.onReady(); },
    deviceInfo: function () { return 'Preview Browser / mock'; },
    setClip: function (name) { window.__clip = name || ''; },
    setAutoStop: function (v) { window.__autoStop = v; },
    setAsrEnabled: function () {},
    setAi: function () {},
    setPreferOnline: function () {},
    asrAvailable: function () { return false; },
    pruneExamAudio: function (ids) { window.__prunedExam = ids; },
    pruneChatAudio: function (ids) { window.__prunedChat = ids; },
    startTurn: function (expMs) {
      window.__turnMs = expMs;
      setTimeout(function () { Host.onTurnStart && Host.onTurnStart(); }, 30);
      /* 手动模式：startTurn 不再自动回 onRecord，只有 stopTurn 才回 */
    },
    stopTurn: function () {
      recN++;
      setTimeout(function () {
        Host.onRecord && Host.onRecord({
          url: 'rec/mock' + recN + '.wav', ms: 2600, voicedMs: 2200,
          inPeakDb: -18, outPeakDb: -3, rmsDb: -19, gainDb: 6, src: 'UNPROCESSED', rate: 16000
        });
      }, 150);
    },
    cancelTurn: function () { clearTimeout(window.__turnTimer); },
    /* 假 AI 转写：模拟网络延迟后回一段像样的回答 */
    aiTranscribe: function (url) {
      setTimeout(function () {
        Host.onAiAsr && Host.onAiAsr({
          ok: true, ai: true, name: String(url).split('/').pop(),
          text: 'I have flown the Cessna 172 during training and the DA42 for multi engine.'
        });
      }, 200);
    }
  };

  window.ICAOAsr = {
    info: function () {
      return JSON.stringify({
        abi: 'arm64-v8a', cores: 8, totalMb: 11724, availMb: 6421, freeDiskMb: 58200,
        sdk: 35, device: 'Preview', arm64: true, memOk: true, diskOk: true, ok: true,
        reason: '', modelReady: false,
        modelBytes: 0, mmprojBytes: 0, modelTotal: 804749248, mmprojTotal: 214392480,
        downloading: false
      });
    },
    download: function () {}, cancelDownload: function () {}, deleteModels: function () {},
    transcribe: function () {}
  };

  /* 假对话模型：score 请求回六维 JSON，final 请求回一段总评 */
  window.ICAOChat = {
    isBusy: function () { return false; },
    chat: function (messagesJson, base, model, key, temp, tag) {
      window.__chatCalls = (window.__chatCalls || 0) + 1;
      window.__chatLastTag = tag;
      setTimeout(function () {
        if (tag === 'final') {
          Host.onChat && Host.onChat({
            ok: true, tag: 'final',
            text: '整体水平接近 ICAO 4 级。发音清晰、理解准确是你最大的优势；' +
              '结构上时态偶有跳跃，词汇层面航空术语储备偏少，流畅度受自我修正影响。' +
              '建议：① 用完整句回答并注意时态一致；② 按话题积累机务与气象术语；' +
              '③ 练习 30 秒连续陈述，减少中途改口。'
          });
        } else {
          Host.onChat && Host.onChat({
            ok: true, tag: tag,
            text: JSON.stringify({
              pron: 3, struct: 3, vocab: 4, fluency: 3, comp: 5, inter: 4,
              comment: '回答切题，机型名称准确，句子可再完整一些。'
            })
          });
        }
      }, 180);
    }
  };
})();
