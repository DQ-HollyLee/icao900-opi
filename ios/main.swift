//
//  ICAO 900 · OPI — iOS / iPadOS 壳（对应 Android 的 MainActivity + TurnController
//  + ChatClient + AiClient 四个类，合并为一个文件）。
//
//  结构：WKWebView 加载 app://local/（自定义 scheme，WKURLSchemeHandler 读
//  Bundle 内的 assets/ 与 Documents/rec/ 里的录音），网页与原生之间用
//  window.webkit.messageHandlers 代替 Android 的 addJavascriptInterface。
//  录音：AVAudioEngine 采集 16k/单声道/Int16 + 与 Android 相同的
//  静音检测 / 自动停止 / 响度归一 / WAV 写盘。
//  识别：SFSpeechRecognizer（en-US），与录音共用同一条音频引擎。
//  网络：ICAOChat（OpenAI 兼容 /chat/completions）与 AI 转写
//  （/audio/transcriptions，multipart）用 URLSession 移植。
//  本地 llama 模型（Android 的 ICAOAsr）在 iOS 上不提供：前端会自动
//  降级到"系统识别 / AI 云端转写"。
//
//  编译：ios/build_ios.sh（macOS + Xcode 命令行工具）
//

import UIKit
import WebKit
import AVFoundation
import Speech

// MARK: - 入口

UIApplicationMain(CommandLine.argc, CommandLine.unsafeArgv,
                 nil, NSStringFromClass(AppDelegate.self))

// MARK: - AppDelegate

final class AppDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?

    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        window = UIWindow(frame: UIScreen.main.bounds)
        window?.rootViewController = ViewController()
        window?.makeKeyAndVisible()
        return true
    }
}

// MARK: - ViewController（承载 WebView + 桥路由）

final class ViewController: UIViewController, WKScriptMessageHandler, WKNavigationDelegate {
    var webView: WKWebView!
    var turn: TurnEngine!
    var chatClient: ChatClient!
    private var schemeHandler: AssetSchemeHandler!

    override var preferredStatusBarStyle: UIStatusBarStyle { .lightContent }
    override var prefersHomeIndicatorAutoHidden: Bool { false }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(red: 0.043, green: 0.122, blue: 0.227, alpha: 1)  // #0B1F3A

        let cfg = WKWebViewConfiguration()
        schemeHandler = AssetSchemeHandler()
        cfg.setURLSchemeHandler(schemeHandler, forURLScheme: "app")
        cfg.mediaTypesRequiringUserActionForPlayback = []          // 考官提问要能自动播
        let ucc = WKUserContentController()
        ucc.add(self, name: "icao")
        ucc.addUserScript(WKUserScript(source: ViewController.bridgeScript(),
                                        injectionTime: .atDocumentStart,
                                        forMainFrameOnly: true))
        cfg.userContentController = ucc

        webView = WKWebView(frame: view.bounds, configuration: cfg)
        webView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        webView.navigationDelegate = self
        webView.scrollView.bounces = false
        webView.isOpaque = false
        webView.backgroundColor = UIColor(red: 0.957, green: 0.973, blue: 0.992, alpha: 1)  // #F4F8FD
        view.addSubview(webView)

        turn = TurnEngine(self)
        chatClient = ChatClient(self)

        // 只允许 app:// 内部导航
        webView.load(URLRequest(url: URL(string: "app://local/index.html")!))

        // 麦克风 + 语音识别授权（与 Android onCreate 里请求权限对应）
        requestPermissions()

        // 切后台 / 来电：中断录音并通知前端（对应 Android onPause 的 hardStop）
        NotificationCenter.default.addObserver(
            self, selector: #selector(onResignActive),
            name: UIApplication.willResignActiveNotification, object: nil)
    }

    @objc private func onResignActive() { turn.hardStop() }

    private func requestPermissions() {
        let sess = AVAudioSession.sharedInstance()
        sess.requestRecordPermission { [weak self] ok in
            DispatchQueue.main.async {
                guard let self = self else { return }
                self.js("Host.onPermission&&Host.onPermission(\(ok))")
                if !ok {
                    self.js("Host.onError&&Host.onError('没有麦克风权限，录音评分不可用')")
                }
            }
        }
        SFSpeechRecognizer.requestAuthorization { [weak self] st in
            DispatchQueue.main.async {
                let ok = st == .authorized
                self?.js("window.__asrOK=\(ok)")
            }
        }
    }

    // MARK: 桥脚本（在 document.start 注入，等价 Android 的三个 addJavascriptInterface）

    static func bridgeScript() -> String {
        let ver = (Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String) ?? "1.0.0"
        let dev = "\(UIDevice.current.name) / iOS \(UIDevice.current.systemVersion)"
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "'", with: "\\'")
        return """
        (function () {
          if (window.__icaoBridgeInstalled) return; window.__icaoBridgeInstalled = true;
          function nb(m, a) { try { window.webkit.messageHandlers.icao.postMessage({ m: m, a: a || [] }); } catch (e) {} }
          window.__devInfo = '\(dev)';
          window.__asrOK = false;
          window.__chatBusy = false;
          window.ICAOMeta = { version: function () { return '\(ver)'; } };
          window.ICAOBridge = {
            ready: function () { nb('ready'); },
            deviceInfo: function () { return window.__devInfo; },
            asrAvailable: function () { return window.__asrOK === true; },
            setAsrEnabled: function (v) { nb('setAsrEnabled', [v]); },
            setAi: function (e, b, m, k) { nb('setAi', [e, b, m, k]); },
            setPreferOnline: function (v) { nb('setPreferOnline', [v]); },
            setClip: function (n) { nb('setClip', [n]); },
            setAutoStop: function (v) { nb('setAutoStop', [v]); },
            pruneExamAudio: function (ids) { nb('pruneExamAudio', [ids]); },
            pruneChatAudio: function (ids) { nb('pruneChatAudio', [ids]); },
            startTurn: function (ms) { nb('startTurn', [ms]); },
            stopTurn: function () { nb('stopTurn'); },
            cancelTurn: function () { nb('cancelTurn'); },
            aiTranscribe: function (u) { nb('aiTranscribe', [u]); }
          };
          window.ICAOChat = {
            isBusy: function () { return window.__chatBusy === true; },
            chat: function (mj, b, m, k, t, tag) { nb('chat', [mj, b, m, k, t, tag]); }
          };
        })();
        """
    }

    // MARK: WKScriptMessageHandler —— 把 JS 调用路由到引擎

    func userContentController(_ userContentController: WKUserContentController,
                               didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any],
              let m = body["m"] as? String,
              let a = body["a"] as? [Any] else { return }

        func str(_ i: Int) -> String { i < a.count ? (a[i] as? String ?? "") : "" }
        func bool(_ i: Int) -> Bool {
            if i >= a.count { return false }
            if let v = a[i] as? Bool { return v }
            if let v = a[i] as? NSNumber { return v.boolValue }
            return false
        }
        func dbl(_ i: Int) -> Double {
            if i >= a.count { return 0 }
            if let v = a[i] as? NSNumber { return v.doubleValue }
            return 0
        }

        switch m {
        case "ready":           js("Host.onReady&&Host.onReady()")
        case "setAsrEnabled":   turn.asrEnabled = bool(0)
        case "setAi":           turn.setAi(bool(0), str(1), str(2), str(3))
        case "setPreferOnline": turn.preferOnline = bool(0)
        case "setClip":         turn.setClip(str(0))
        case "setAutoStop":     turn.autoStop = bool(0)
        case "pruneExamAudio":  turn.prune("exam_", keep: str(0), idParts: 2)
        case "pruneChatAudio":  turn.prune("opic_", keep: str(0), idParts: 1)
        case "startTurn":       turn.start(Int(dbl(0)))
        case "stopTurn":        turn.stop()
        case "cancelTurn":      turn.cancel()
        case "aiTranscribe":    turn.aiTranscribe(str(0))
        case "chat":            chatClient.chat(str(0), base: str(1), model: str(2),
                                                key: str(3), temp: dbl(4), tag: str(5))
        default: break
        }
    }

    // MARK: 导航限制

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if navigationAction.request.url?.scheme == "app" {
            decisionHandler(.allow)
        } else {
            decisionHandler(.cancel)   // 外部链接一律不跳（本应用也没有）
        }
    }

    // MARK: JS 注入

    func js(_ code: String) {
        if Thread.isMainThread {
            webView.evaluateJavaScript(code, completionHandler: nil)
        } else {
            DispatchQueue.main.async { self.webView.evaluateJavaScript(code, completionHandler: nil) }
        }
    }
}

// MARK: - 资源 scheme：app://local/ → Bundle/assets + Documents/rec

final class AssetSchemeHandler: NSObject, WKURLSchemeHandler {
    private final class Box {
        var cancelled = false
        var finished = false
    }
    private var boxes = [ObjectIdentifier: Box]()   // 只在主线程访问

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        let box = Box()
        boxes[ObjectIdentifier(task)] = box
        let url = task.request.url

        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            let result = Self.resolve(url)
            DispatchQueue.main.async {
                guard let self = self else { return }
                self.boxes.removeValue(forKey: ObjectIdentifier(task))
                guard !box.cancelled, !box.finished else { return }
                switch result {
                case .ok(let data, let mime):
                    let resp = HTTPURLResponse(url: url ?? URL(string: "app://local/")!,
                                               statusCode: 200, httpVersion: "HTTP/1.1",
                                               headerFields: ["Content-Type": mime,
                                                              "Content-Length": "\(data.count)",
                                                              "Cache-Control": "no-cache"])!
                    task.didReceive(resp)
                    task.didReceive(data)
                    task.didFinish()
                    box.finished = true
                case .notFound:
                    let resp = HTTPURLResponse(url: url ?? URL(string: "app://local/")!,
                                               statusCode: 404, httpVersion: "HTTP/1.1",
                                               headerFields: ["Content-Type": "text/plain"])!
                    task.didReceive(resp)
                    task.didReceive(Data())
                    task.didFinish()
                    box.finished = true
                }
            }
        }
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {
        // stop 可能在任意线程回调；只标记这一个任务
        let key = ObjectIdentifier(urlSchemeTask)
        DispatchQueue.main.async { [weak self] in
            self?.boxes[key]?.cancelled = true
        }
    }

    private enum Resolved { case ok(Data, String), notFound }

    private static func resolve(_ url: URL?) -> Resolved {
        var path = url?.path ?? ""
        if path.hasPrefix("/") { path.removeFirst() }
        if path.isEmpty { path = "index.html" }

        let fileURL: URL
        if path.hasPrefix("rec/") {
            // 录音：Documents/rec/…（不允许 ../ 跳出）
            if path.contains("..") { return .notFound }
            let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first!
            fileURL = docs.appendingPathComponent(path)
        } else {
            // 静态资源：Bundle 内 assets/…
            if path.contains("..") { return .notFound }
            fileURL = URL(fileURLWithPath: Bundle.main.bundlePath).appendingPathComponent("assets/\(path)")
        }
        guard let data = try? Data(contentsOf: fileURL) else { return .notFound }
        return .ok(data, mime(of: path))
    }

    private static func mime(of p: String) -> String {
        let l = p.lowercased()
        if l.hasSuffix(".html") || l.hasSuffix(".htm") { return "text/html" }
        if l.hasSuffix(".css") { return "text/css" }
        if l.hasSuffix(".js") { return "application/javascript" }
        if l.hasSuffix(".json") { return "application/json" }
        if l.hasSuffix(".mp3") { return "audio/mpeg" }
        if l.hasSuffix(".wav") { return "audio/wav" }
        if l.hasSuffix(".png") { return "image/png" }
        if l.hasSuffix(".svg") { return "image/svg+xml" }
        if l.hasSuffix(".ico") { return "image/x-icon" }
        return "application/octet-stream"
    }
}

// MARK: - JSON 工具

func json(_ obj: Any) -> String {
    guard let d = try? JSONSerialization.data(withJSONObject: obj,
                                              options: [.sortedKeys]) else { return "{}" }
    return String(data: d, encoding: .utf8) ?? "{}"
}

// MARK: - 录音回合引擎（对应 Android TurnController）

final class TurnEngine {
    private static let rate = 16000.0
    private static let recCap = 60 * 1024 * 1024   // 录音目录上限 60MB

    private weak var vc: ViewController?
    private var js: (String) -> Void { return { [weak self] code in self?.vc?.js(code) } }

    // 状态（与 Android 字段一一对应）
    private var recording = false
    private var pcmData = [Int16]()
    private let pcmLock = NSLock()
    private var t0: TimeInterval = 0
    private var voicedMs: Double = 0
    private var firstLoudAt: TimeInterval = 0
    private var lastLoudAt: TimeInterval = 0
    var autoStop = true
    private var expectedMs: Double = 3000
    private var seq = 0
    private var clipName: String?

    // 识别开关
    var asrEnabled = true
    var preferOnline = true
    private var aiEnabled = false
    private var aiBase = ""
    private var aiModel = ""
    private var aiKey = ""

    // 归一化统计（回报前端）
    private var lastGainDb = 0.0
    private var lastInPeakDb = -120.0
    private var lastOutPeakDb = -120.0
    private var lastRmsDb = -120.0

    // 音频引擎 + 识别
    private let engine = AVAudioEngine()
    private var outFormat: AVAudioFormat?
    private var converter: AVAudioConverter?
    private var recognizer: SFSpeechRecognizer?
    private var recRequest: SFSpeechAudioBufferRecognitionRequest?
    private var recTask: SFSpeechRecognitionTask?
    private var asrGot = false
    private var asrSeq = -1

    init(_ vc: ViewController) {
        self.vc = vc
        recognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US"))
    }

    // MARK: JS 调用的状态设置

    func setAi(_ enabled: Bool, _ base: String, _ model: String, _ key: String) {
        aiEnabled = enabled
        aiBase = base.trimmingCharacters(in: .whitespacesAndNewlines)
        aiModel = model.trimmingCharacters(in: .whitespacesAndNewlines)
        aiKey = key.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    func setClip(_ name: String) {
        let n = name.trimmingCharacters(in: .whitespaces)
        clipName = n.isEmpty ? nil : n
    }

    // MARK: 回合控制

    func start(_ expMs: Int) {
        expectedMs = expMs > 0 ? Double(expMs) : 3000
        if recording { stopRecording() }   // 上一轮没收尾先收掉
        if !hasMic() {
            js("Host.onPermission&&Host.onPermission(false)")
            js("Host.onError&&Host.onError('没有麦克风权限')")
            return
        }
        seq += 1
        let mySeq = seq
        t0 = Date().timeIntervalSince1970
        voicedMs = 0
        firstLoudAt = 0
        lastLoudAt = 0
        pcmLock.lock(); pcmData = []; pcmLock.unlock()
        asrGot = aiEnabled || !asrEnabled    // 不识别则视为已完成

        js("Host.onTurnStart&&Host.onTurnStart()")
        startRecording(mySeq)
    }

    func stop() {
        if !recording {
            // 页面切走后状态不同步：也要回空结果，否则前端一直"识别中"
            let o: [String: Any] = ["url": "", "ms": 0, "voicedMs": 0, "err": "没有录到声音"]
            js("Host.onRecord&&Host.onRecord(\(json(o)))")
            return
        }
        let dur = (Date().timeIntervalSince1970 - t0) * 1000
        stopRecording()
        stopAsr()

        var data = [Int16]()
        pcmLock.lock(); data = pcmData; pcmData = []; pcmLock.unlock()

        var urlStr = ""
        var ms = dur
        if !data.isEmpty {
            data = normalize(data)
            let dir = recDir()
            let name = clipName ?? ("turn\(seq)")
            let file = dir.appendingPathComponent("\(name).wav")
            if writeWav(data, to: file) {
                urlStr = "app://local/rec/\(name).wav"
                ms = Double(data.count) * 1000.0 / TurnEngine.rate
                // 练习模式只留最近一条；考试按题命名全部保留
                if clipName == nil {
                    prunePracticeKeep(file)
                }
                trimRecDir(dir)
            }
        }
        let o: [String: Any] = [
            "url": urlStr,
            "ms": Int(ms.rounded()),
            "voicedMs": Int(voicedMs.rounded()),
            "gainDb": (lastGainDb * 10).rounded() / 10,
            "inPeakDb": (lastInPeakDb * 10).rounded() / 10,
            "outPeakDb": (lastOutPeakDb * 10).rounded() / 10,
            "rmsDb": (lastRmsDb * 10).rounded() / 10,
            "src": "MIC", "rate": 16000
        ]
        js("Host.onRecord&&Host.onRecord(\(json(o)))")

        // 识别结果迟迟不来时兜底通知前端
        if asrEnabled && !aiEnabled {
            let mySeq = seq
            DispatchQueue.main.asyncAfter(deadline: .now() + 4.5) { [weak self] in
                guard let self = self, mySeq == self.seq, !self.asrGot else { return }
                self.asrGot = true
                self.emitAsr(ok: false, text: "", msg: "语音识别超时，请重试或改用 AI 识别")
            }
        }
    }

    func cancel() {
        stopRecording()
        stopAsr()
    }

    /// 切后台 / 来电中断：半截数据丢掉并复位前端
    func hardStop() {
        let wasBusy = recording
        stopRecording()
        stopAsr()
        if wasBusy {
            pcmLock.lock(); pcmData = []; pcmLock.unlock()
            js("Host.onTurnAbort&&Host.onTurnAbort('录音被中断')")
        }
    }

    // MARK: 采集

    private var hasMic: () -> Bool = {
        AVAudioSession.sharedInstance().recordPermission == .granted
    }

    private func startRecording(_ mySeq: Int) {
        let sess = AVAudioSession.sharedInstance()
        do {
            try sess.setCategory(.playAndRecord, mode: .default,
                                 options: [.defaultToSpeaker, .allowBluetooth])
            try sess.setActive(true)
        } catch {
            js("Host.onError&&Host.onError('音频会话启动失败：\(esc(error.localizedDescription))')")
            return
        }

        let input = engine.inputNode
        let inFmt = input.outputFormat(forBus: 0)
        guard inFmt.sampleRate > 0, inFmt.channelCount > 0 else {
            js("Host.onError&&Host.onError('录音设备初始化失败')")
            return
        }
        let out = AVAudioFormat(standardFormatWithSampleRate: TurnEngine.rate, channels: 1)!
        outFormat = out
        converter = AVAudioConverter(from: inFmt, to: out)

        recording = true

        // 识别与录音共用这条引擎（Android：先录音再开识别）
        if asrEnabled && !aiEnabled, let rec = recognizer, rec.isAvailable {
            startAsr()
        }

        input.installTap(onBus: 0, bufferSize: 4096, format: inFmt) { [weak self] buffer, _ in
            guard let self = self, self.recording, mySeq == self.seq else { return }
            self.handleBuffer(buffer)
        }
        do {
            engine.prepare()
            try engine.start()
        } catch {
            recording = false
            input.removeTap(onBus: 0)
            js("Host.onError&&Host.onError('无法启动录音')")
        }
    }

    private func stopRecording() {
        guard recording else { return }
        recording = false
        engine.inputNode.removeTap(onBus: 0)
        if engine.isRunning { engine.stop() }
        converter = nil
    }

    /// 每个 tap 回调：降采样到 16k 单声道，算电平 / 静音检测 / 超时停
    private func handleBuffer(_ buffer: AVAudioPCMBuffer) {
        guard let conv = converter, let outFmt = outFormat else { return }

        // 1) 喂识别器（原始 buffer，任何格式都接受）
        recRequest?.append(buffer)

        // 2) 转 16k mono float
        let ratio = TurnEngine.rate / buffer.format.sampleRate
        let cap = AVAudioFrameCount((Double(buffer.frameLength) * ratio).rounded(.up)) + 32
        guard let out = AVAudioPCMBuffer(pcmFormat: outFmt, frameCapacity: cap) else { return }
        var err: NSError?
        var consumed = false
        let status = conv.convert(to: out, error: &err, withInputFrom: { _, outStatus in
            if consumed { outStatus.pointee = .noDataNow; return nil }
            consumed = true
            outStatus.pointee = .haveData
            return buffer
        })
        if status == .error || err != nil || out.frameLength == 0 { return }

        let n = Int(out.frameLength)
        guard let f = f32(out) else { return }
        var samples = [Int16](repeating: 0, count: n)
        var sum = 0.0
        for i in 0..<n {
            let v = f[i]
            samples[i] = Int16(max(-32768, min(32767, (v * 32767).rounded())))
            sum += Double(v) * Double(v)
        }
        pcmLock.lock(); pcmData.append(contentsOf: samples); pcmLock.unlock()

        let rms = (sum / Double(max(1, n))).squareRoot()
        let now = Date().timeIntervalSince1970
        if rms > 0.012 {
            lastLoudAt = now
            if firstLoudAt == 0 { firstLoudAt = now }
            voicedMs += Double(n) * 1000.0 / TurnEngine.rate
        }
        let lv = min(1.0, rms * 9.0)
        js("Host.onLevel&&Host.onLevel(\(String(format: "%.3f", lv)))")

        let dur = (now - t0) * 1000
        let limit: Double = autoStop ? 20000 : 300000
        if dur > limit {
            DispatchQueue.main.async { self.stop() }
            return
        }
        if autoStop && firstLoudAt > 0 && (now - lastLoudAt) > 1.2 && voicedMs > 450 {
            DispatchQueue.main.async { self.stop() }
        }
    }

    private func f32(_ buf: AVAudioPCMBuffer) -> [Float]? {
        guard let ch = buf.floatChannelData else { return nil }
        let n = Int(buf.frameLength)
        var out = [Float](repeating: 0, count: n)
        for i in 0..<n { out[i] = ch[0][i] }
        return out
    }

    // MARK: 系统识别（SFSpeechRecognizer）

    private func startAsr() {
        guard let rec = recognizer, rec.isAvailable else {
            emitAsr(ok: false, text: "", msg: "本机语音识别不可用")
            return
        }
        let req = SFSpeechAudioBufferRecognitionRequest()
        req.shouldReportPartialResults = false
        recRequest = req
        asrSeq = seq
        recTask = rec.recognitionTask(with: req) { [weak self] result, error in
            guard let self = self else { return }
            if self.asrSeq != self.seq || self.asrGot { return }   // 丢弃迟到结果
            if let r = result, r.isFinal {
                self.asrGot = true
                let t = r.bestTranscription.formattedString.trimmingCharacters(in: .whitespacesAndNewlines)
                self.emitAsr(ok: !t.isEmpty, text: t, msg: t.isEmpty ? "没有听清，请再说一遍" : "")
            } else if let e = error {
                // cancel/endAudio 引发的 203(Retry)/216(Cancelled) 不是真失败：
                // 忽略，交给 stop() 里的 4.5s 兜底超时
                let code = (e as NSError).code
                if code == 203 || code == 216 { return }
                self.asrGot = true
                self.emitAsr(ok: false, text: "", msg: "识别失败：" + e.localizedDescription)
            }
        }
    }

    private func stopAsr() {
        recRequest?.endAudio()
        recRequest = nil
        recTask?.cancel()   // cancel 也会触发一次 final/error 回调，由 seq/asrGot 过滤
        recTask = nil
    }

    private func emitAsr(ok: Bool, text: String, msg: String) {
        let o: [String: Any] = [
            "ok": ok,
            "text": text,
            "alts": text.isEmpty ? [String]() : [text],
            "conf": -1,
            "msg": msg
        ]
        js("Host.onAsr&&Host.onAsr(\(json(o)))")
    }

    // MARK: AI 转写（对应 Android AiClient + aiTranscribe）

    func aiTranscribe(_ url: String) {
        if url.isEmpty {
            emitAi(ok: false, text: "", msg: "没有可用的录音文件", name: "")
            return
        }
        if !aiEnabled { emitAi(ok: false, text: "", msg: "AI 识别未开启", name: ""); return }
        if aiKey.isEmpty { emitAi(ok: false, text: "", msg: "还没有填 API Key", name: ""); return }
        if aiBase.isEmpty || aiModel.isEmpty {
            emitAi(ok: false, text: "", msg: "AI 接口地址或模型名没填", name: ""); return
        }
        let name = (url as NSString).lastPathComponent
        let file = recDir().appendingPathComponent(name)
        guard FileManager.default.fileExists(atPath: file.path) else {
            emitAi(ok: false, text: "", msg: "录音文件不存在", name: name); return
        }
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            do {
                let text = try AiClient.transcribe(file, base: self?.aiBase ?? "",
                                                   model: self?.aiModel ?? "", key: self?.aiKey ?? "")
                self?.emitAi(ok: true, text: text, msg: "", name: name)
            } catch {
                self?.emitAi(ok: false, text: "", msg: "AI 识别失败：\(error.localizedDescription)", name: name)
            }
        }
    }

    private func emitAi(ok: Bool, text: String, msg: String, name: String) {
        let o: [String: Any] = ["ok": ok, "text": text, "msg": msg, "ai": true, "name": name]
        js("Host.onAiAsr&&Host.onAiAsr(\(json(o)))")
    }

    // MARK: 录音清理（对应 Android prune / trimRecDir）

    private func recDir() -> URL {
        let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first!
        let d = docs.appendingPathComponent("rec")
        if !FileManager.default.fileExists(atPath: d.path) {
            try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        }
        return d
    }

    /// 只保留指定会话 id 的录音，其余 {prefix}* 的删掉
    func prune(_ prefix: String, keep keepIds: String, idParts: Int) {
        let keep = Set(keepIds.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty })
        let fm = FileManager.default
        guard let files = try? fm.contentsOfDirectory(at: recDir(),
                                                      includingPropertiesForKeys: nil) else { return }
        for f in files {
            let n = f.lastPathComponent
            guard n.hasPrefix(prefix), n.hasSuffix(".wav") else { continue }
            var body = String(n.dropFirst(prefix.count).dropLast(4))
            var cut = body.count
            var ok = true
            for _ in 0..<idParts {
                guard let r = body.prefix(cut).lastIndex(of: "_") else { ok = false; break }
                cut = body.distance(from: body.startIndex, to: r)
            }
            if ok { body = String(body.prefix(cut)) }
            if !keep.contains(body) { try? fm.removeItem(at: f) }
        }
    }

    /// 练习模式：删掉除当前文件外的非考试录音
    private func prunePracticeKeep(_ keep: URL) {
        let fm = FileManager.default
        guard let files = try? fm.contentsOfDirectory(at: recDir(),
                                                      includingPropertiesForKeys: nil) else { return }
        for f in files where f != keep && !f.lastPathComponent.hasPrefix("exam_") {
            try? fm.removeItem(at: f)
        }
    }

    /// 录音目录总量兜底：超 60MB 时从最老的 exam_*.wav 删到 48MB
    private func trimRecDir(_ dir: URL) {
        let fm = FileManager.default
        guard let files = try? fm.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil),
              files.count >= 6 else { return }
        var total = 0
        var exams = [(URL, Date, Int)]()
        for f in files {
            let len = (try? fm.attributesOfItem(atPath: f.path)[.size] as? Int) ?? 0
            total += len
            if f.lastPathComponent.hasPrefix("exam_") {
                let date = (try? fm.attributesOfItem(atPath: f.path)[.modificationDate] as? Date) ?? Date()
                exams.append((f, date, len))
            }
        }
        if total <= TurnEngine.recCap { return }
        exams.sort { $0.1 < $1.1 }
        let low = TurnEngine.recCap * 4 / 5
        for (f, _, len) in exams {
            if total <= low { break }
            if (try? fm.removeItem(at: f)) != nil { total -= len }
        }
    }

    // MARK: 归一化（移植 Android TurnController.normalize：80Hz 高通 + 响度归一 + 软限幅）

    private func normalize(_ pcm: [Int16]) -> [Int16] {
        let n = pcm.count
        lastGainDb = 0
        lastInPeakDb = -120; lastOutPeakDb = -120; lastRmsDb = -120
        let sr = TurnEngine.rate
        if Double(n) < sr / 10 { return pcm }

        var x = [Double](repeating: 0, count: n)
        for i in 0..<n { x[i] = Double(pcm[i]) / 32768.0 }

        // 一阶高通 80Hz
        let a = exp(-2.0 * .pi * 80.0 / sr)
        var px = 0.0, py = 0.0, rawPeak = 0.0
        for i in 0..<n {
            let cur = a * (py + x[i] - px)
            px = x[i]; py = cur; x[i] = cur
            let av = Swift.abs(cur)
            if av > rawPeak { rawPeak = av }
        }
        lastInPeakDb = db(rawPeak)

        // 20ms 帧统计
        let frame = max(1, Int(sr / 50))
        let frames = max(1, n / frame)
        var fr = [Double](repeating: 0, count: frames)
        var fe = [Double](repeating: 0, count: frames)
        for f in 0..<frames {
            let st = f * frame, en = min(n, st + frame)
            var mx = 0.0, sum = 0.0
            for i in st..<en {
                let av = Swift.abs(x[i])
                if av > mx { mx = av }
                sum += x[i] * x[i]
            }
            fr[f] = mx
            fe[f] = (sum / Double(max(1, en - st))).squareRoot()
        }

        // 峰值参考取 98 分位
        let sortedPk = fr.sorted()
        let pkRef = sortedPk[min(frames - 1, Int(Double(frames) * 0.98))]

        // 语音帧门限：最响帧低 20dB
        let maxRms = fe.max() ?? 0
        let gate = max(0.00126, maxRms * 0.10)
        var voiced = fe.filter { $0 >= gate }
        if voiced.count < 3 {   // 几乎没说话，保持原样
            lastOutPeakDb = lastInPeakDb
            lastRmsDb = db(fe.reduce(0, +) / Double(max(1, fe.count)))
            return pcm
        }
        voiced.sort()
        let refRms = voiced[Int(Double(voiced.count) * 0.75)]

        let target = 0.15                       // ≈ -16 dBFS
        var gain = target / max(refRms, 1e-9)
        let peakCap = 0.97 / max(pkRef, 1e-9) * 2.0
        if gain > peakCap { gain = peakCap }
        if gain < 1.0 { gain = 1.0 }
        if gain > 79.0 { gain = 79.0 }
        lastGainDb = 20 * log10(gain)

        var out = [Int16](repeating: 0, count: n)
        var outPeak = 0.0
        for i in 0..<n {
            var v = x[i] * gain
            let av = Swift.abs(v)
            if av > 0.85 {                       // 0.85 以上 tanh 软饱和
                let z = (av - 0.85) / 0.15
                v = (v < 0 ? -1.0 : 1.0) * (0.85 + 0.15 * tanh(z * 1.2))
            }
            if v > 0.999 { v = 0.999 }
            if v < -0.999 { v = -0.999 }
            let a2 = Swift.abs(v)
            if a2 > outPeak { outPeak = a2 }
            out[i] = Int16(max(-32768, min(32767, (v * 32767).rounded())))
        }
        lastOutPeakDb = db(outPeak)
        lastRmsDb = db(min(0.99, refRms * gain))
        return out
    }

    private func db(_ amp: Double) -> Double {
        return amp <= 1e-9 ? -120.0 : 20 * log10(amp)
    }

    // MARK: WAV（16k / 16bit / 单声道，44 字节头）

    private func writeWav(_ pcm: [Int16], to url: URL) -> Bool {
        let dataLen = pcm.count * 2
        var d = Data(capacity: 44 + dataLen)
        func le32(_ v: Int) { d.append(UInt8(v & 0xff)); d.append(UInt8((v >> 8) & 0xff))
                               d.append(UInt8((v >> 16) & 0xff)); d.append(UInt8((v >> 24) & 0xff)) }
        d.append(contentsOf: [UInt8]("RIFF".utf8))
        le32(36 + dataLen)
        d.append(contentsOf: [UInt8]("WAVE".utf8))
        d.append(contentsOf: [UInt8]("fmt ".utf8))
        le32(16)
        d.append(1); d.append(0)          // PCM
        d.append(1); d.append(0)          // 单声道
        le32(16000); le32(32000)
        d.append(2); d.append(0)          // block align
        d.append(16); d.append(0)         // 16 bit
        d.append(contentsOf: [UInt8]("data".utf8))
        le32(dataLen)
        if pcm.count > 0 {
            pcm.withUnsafeBufferPointer { buf in
                d.append(UnsafeBufferPointer(start: UnsafeRawPointer(buf.baseAddress!)
                                                .assumingMemoryBound(to: UInt8.self),
                                             count: dataLen))
            }
        }
        do { try d.write(to: url); return true } catch { return false }
    }
}

// MARK: - ChatClient（对应 Android ChatClient：OpenAI 兼容 /chat/completions）

final class ChatClient {
    private weak var vc: ViewController?
    private var busy = false

    init(_ vc: ViewController) { self.vc = vc }

    func chat(_ messagesJson: String, base: String, model: String, key: String,
              temp: Double, tag: String) {
        if busy {
            emit(ok: false, text: "", msg: "上一个请求还没返回，请稍等", tag: tag); return
        }
        if key.trimmingCharacters(in: .whitespaces).isEmpty {
            emit(ok: false, text: "", msg: "还没有配置对话模型的 API Key", tag: tag); return
        }
        if base.trimmingCharacters(in: .whitespaces).isEmpty ||
           model.trimmingCharacters(in: .whitespaces).isEmpty {
            emit(ok: false, text: "", msg: "对话模型的接口地址或模型名没有填", tag: tag); return
        }
        guard let msgs = try? JSONSerialization.jsonObject(with: Data(messagesJson.utf8)),
              (msgs as? [[String: Any]]) != nil else {
            emit(ok: false, text: "", msg: "对话内容格式错误", tag: tag); return
        }
        busy = true
        vc?.js("window.__chatBusy=true")

        let payload: [String: Any] = [
            "model": model.trimmingCharacters(in: .whitespaces),
            "messages": msgs,
            "temperature": temp > 0 ? temp : 0.4,
            "stream": false
        ]
        var b = base.trimmingCharacters(in: .whitespaces)
        while b.hasSuffix("/") { b.removeLast() }
        let endpoint = b.hasSuffix("/chat/completions") ? b : b + "/chat/completions"
        guard let url = URL(string: endpoint) else {
            finish(ok: false, text: "", msg: "接口地址不合法", tag: tag); return
        }

        var req = URLRequest(url: url, timeoutInterval: 120)
        req.httpMethod = "POST"
        req.setValue("Bearer \(key.trimmingCharacters(in: .whitespaces))", forHTTPHeaderField: "Authorization")
        req.setValue("application/json; charset=utf-8", forHTTPHeaderField: "Content-Type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: payload)

        URLSession.shared.dataTask(with: req) { [weak self] data, resp, err in
            guard let self = self else { return }
            if let err = err {
                self.finish(ok: false, text: "", msg: "对话模型请求失败：" + err.localizedDescription, tag: tag)
                return
            }
            let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
            let body = String(data: data ?? Data(), encoding: .utf8) ?? ""
            if !(200..<300).contains(code) {
                let hint = String(body.prefix(200))
                self.finish(ok: false, text: "", msg: "HTTP \(code) \(hint)", tag: tag)
                return
            }
            guard let j = try? JSONSerialization.jsonObject(with: Data(body.utf8)) as? [String: Any] else {
                self.finish(ok: false, text: "", msg: "接口没有返回回复内容", tag: tag); return
            }
            // choices 可能是对象或数组，可能包在 data 里
            var text = ""
            var choices: Any? = j["choices"]
            if choices == nil, let dd = j["data"] as? [String: Any] { choices = dd["choices"] }
            if let c1 = choices as? [String: Any],
               let m = c1["message"] as? [String: Any],
               let t = m["content"] as? String, !t.isEmpty { text = t }
            if text.isEmpty, let c2 = choices as? [[String: Any]], let m = c2.first?["message"] as? [String: Any],
               let t = m["content"] as? String, !t.isEmpty { text = t }
            if text.isEmpty {
                self.finish(ok: false, text: "", msg: "接口没有返回回复内容", tag: tag)
            } else {
                self.finish(ok: true, text: text.trimmingCharacters(in: .whitespacesAndNewlines),
                            msg: "", tag: tag)
            }
        }.resume()
    }

    private func finish(ok: Bool, text: String, msg: String, tag: String) {
        busy = false
        vc?.js("window.__chatBusy=false")
        emit(ok: ok, text: text, msg: msg, tag: tag)
    }

    private func emit(ok: Bool, text: String, msg: String, tag: String) {
        let o: [String: Any] = ["ok": ok, "text": text, "msg": msg, "tag": tag]
        vc?.js("Host.onChat&&Host.onChat(\(json(o)))")
    }
}

// MARK: - AiClient（对应 Android AiClient：/audio/transcriptions multipart）

enum AiClient {
    static func transcribe(_ wav: URL, base: String, model: String, key: String) throws -> String {
        var b = base.trimmingCharacters(in: .whitespaces)
        while b.hasSuffix("/") { b.removeLast() }
        let endpoint = b.hasSuffix("/audio/transcriptions") ? b : b + "/audio/transcriptions"
        guard let url = URL(string: endpoint) else {
            throw NSError(domain: "icao", code: 1,
                          userInfo: [NSLocalizedDescriptionKey: "接口地址不合法"])
        }
        let boundary = "----ICAO900\(Int(Date().timeIntervalSince1970 * 1000))"
        var body = Data()
        func field(_ name: String, _ value: String) {
            body.append(Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"\(name)\"\r\n\r\n\(value)\r\n".utf8))
        }
        field("model", model)
        field("language", "en")
        field("prompt", "Aviation radiotelephony. Flight levels, headings, frequencies, QNH, "
                         + "runway numbers, ICAO alphabet, standard phraseology.")
        body.append(Data(("--\(boundary)\r\nContent-Disposition: form-data; name=\"file\"; "
                         + "filename=\"clip.wav\"\r\nContent-Type: audio/wav\r\n\r\n").utf8))
        body.append(try Data(contentsOf: wav))
        body.append(Data("\r\n--\(boundary)--\r\n".utf8))

        var req = URLRequest(url: url, timeoutInterval: 90)
        req.httpMethod = "POST"
        req.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
        req.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        req.httpBody = body

        let sem = DispatchSemaphore(value: 0)
        var outText = ""
        var outErr: Error? = nil
        URLSession.shared.dataTask(with: req) { data, resp, err in
            defer { sem.signal() }
            if let err = err { outErr = err; return }
            let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
            let bodyStr = String(data: data ?? Data(), encoding: .utf8) ?? ""
            if !(200..<300).contains(code) {
                outErr = NSError(domain: "icao", code: 2,
                                 userInfo: [NSLocalizedDescriptionKey: "HTTP \(code) \(String(bodyStr.prefix(160)))"])
                return
            }
            guard let j = try? JSONSerialization.jsonObject(with: Data(bodyStr.utf8)) as? [String: Any] else {
                outErr = NSError(domain: "icao", code: 3,
                                 userInfo: [NSLocalizedDescriptionKey: "接口没有返回文本"])
                return
            }
            var text = j["text"] as? String ?? ""
            if text.isEmpty, let d = j["data"] as? [String: Any] { text = d["text"] as? String ?? "" }
            if text.isEmpty {
                outErr = NSError(domain: "icao", code: 3,
                                 userInfo: [NSLocalizedDescriptionKey: "接口没有返回文本"])
            } else {
                outText = text.trimmingCharacters(in: .whitespacesAndNewlines)
            }
        }.resume()
        sem.wait()
        if let e = outErr { throw e }
        return outText
    }
}

// MARK: - 工具

private func esc(_ s: String) -> String {
    return s.replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "'", with: "\\'")
            .replacingOccurrences(of: "\n", with: " ")
}
