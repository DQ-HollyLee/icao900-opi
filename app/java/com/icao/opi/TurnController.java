package com.icao.opi;

import android.Manifest;
import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.media.AudioFormat;
import android.media.AudioManager;
import android.media.AudioRecord;
import android.media.MediaRecorder;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import android.util.Log;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;

/**
 * 一次"朗读"的完整回合：录音（AudioRecord -> WAV，可回放）+ 语音识别（SpeechRecognizer）。
 * 两者尽力并行；若系统只允许一个客户端占用麦克风，识别或录音之一会失败，
 * 前端会退化为"离线近似评分"或"仅回放"。
 */
public class TurnController {

    private static final String TAG = "ICAO900";
    private static final int SR_RATE = 16000;   // 采样率：16k 足够语音、文件小，兼容性最好
    private static final long REC_CAP = 60L * 1024 * 1024;   // 录音目录上限，兜底防止无限增长

    private final Activity act;
    private final WebView web;
    private final Handler ui = new Handler(Looper.getMainLooper());

    private AudioRecord arec;
    private Thread recThread;
    private volatile boolean recording = false;
    private ByteArrayOutputStream pcm;
    private long t0, voicedMs, lastLoudAt, firstLoudAt;
    private long maxMs = 20000;
    private boolean autoStop = true;   // 默认自动停；模拟对话由前端关掉

    private SpeechRecognizer sr;
    private boolean asrOn = false;
    private boolean asrGot = false;
    private int asrSeq = -1;        // 本次识别属于第几轮，用来丢弃迟到的上一题结果
    private String asrText = null;

    private long expectedMs = 3000;
    private int seq = 0;
    private boolean preferOnline = true;   // 在线识别明显更准，默认走在线，无网时系统自动回落离线
    private boolean autoOffline = false;   // 在线识别报网络/服务错误后，本次会话自动降级到离线
    private String clipName = null;        // 非空则按此名保存录音（考试用，不清理旧文件）
    private double lastGainDb = 0;
    private String srcName = "";           // 实际用到的采集音源，便于排查"声音小"
    private double lastInPeakDb = -120;    // 归一化前的峰值电平（dBFS）
    private double lastOutPeakDb = -120;   // 归一化后的峰值电平
    private double lastRmsDb = -120;       // 语音段平均电平（归一化后）
    private double noiseFloor = -1;        // 底噪跟踪（0~1 的线性 RMS），用于自适应发声判定

    // 识别方式：系统识别（可能在线）/ AI 转写（OpenAI 兼容接口）/ 都不开（只录音）
    private boolean asrEnabled = true;
    private boolean aiEnabled = false;
    private String aiBase = "";
    private String aiModel = "";
    private String aiKey = "";

    TurnController(Activity a, WebView w) {
        this.act = a;
        this.web = w;
    }

    /* ------------------------------------------------------------ JS 接口 */

    @JavascriptInterface
    public void ready() {
        ui.post(() -> emit("Host.onReady&&Host.onReady()"));
    }

    @JavascriptInterface
    public boolean asrAvailable() {
        try {
            return SpeechRecognizer.isRecognitionAvailable(act);
        } catch (Throwable t) {
            return false;
        }
    }

    @JavascriptInterface
    public String deviceInfo() {
        return Build.MANUFACTURER + " " + Build.MODEL + " / Android " + Build.VERSION.RELEASE;
    }

    /** 练习模式不需要识别，只录音；考试才开 */
    @JavascriptInterface
    public void setAsrEnabled(boolean v) {
        asrEnabled = v;
    }

    /** AI 评分：OpenAI 兼容的 /audio/transcriptions 接口 */
    @JavascriptInterface
    public void setAi(boolean enabled, String base, String model, String key) {
        aiEnabled = enabled;
        aiBase = base == null ? "" : base.trim();
        aiModel = model == null ? "" : model.trim();
        aiKey = key == null ? "" : key.trim();
    }

    /**
     * 把已经存盘的 WAV 交给 AI 转写（在后台线程做 HTTP，结果走 Host.onAiAsr）。
     * 之所以不用系统识别：非母语口音在离线模型上错得离谱，在线大模型明显更准。
     */
    @JavascriptInterface
    public void aiTranscribe(String url) {
        if (url == null || url.isEmpty()) {
            emitAi(false, "", "没有可用的录音文件", null);
            return;
        }
        if (!aiEnabled) { emitAi(false, "", "AI 识别未开启", null); return; }
        if (aiKey.isEmpty()) { emitAi(false, "", "还没有填 API Key", null); return; }
        if (aiBase.isEmpty() || aiModel.isEmpty()) {
            emitAi(false, "", "AI 接口地址或模型名没填", null);
            return;
        }
        int k = url.lastIndexOf("rec/");
        final String name = k >= 0 ? url.substring(k + 4) : url.substring(url.lastIndexOf('/') + 1);
        final File f = new File(new File(act.getFilesDir(), "rec"), name);
        if (!f.exists()) { emitAi(false, "", "录音文件不存在", name); return; }
        new Thread(() -> {
            try {
                String text = aiUpload(f);
                ui.post(() -> emitAi(true, text, "", name));
            } catch (Throwable t) {
                Log.w(TAG, "ai transcribe failed", t);
                String m = t.getMessage();
                ui.post(() -> emitAi(false, "", "AI 识别失败：" + (m == null ? "网络错误" : m), name));
            }
        }, "icao-ai").start();
    }

    private String aiUpload(File f) throws Exception {
        return AiClient.transcribe(f, aiBase, aiModel, aiKey);
    }

    private void emitAi(boolean ok, String text, String msg, String name) {
        JSONObject o = new JSONObject();
        try {
            o.put("ok", ok);
            o.put("text", text == null ? "" : text);
            o.put("msg", msg == null ? "" : msg);
            o.put("ai", true);
            o.put("name", name == null ? "" : name);   // 前端用它判断结果是不是当前这道题的
        } catch (Exception ignore) {}
        js("Host.onAiAsr&&Host.onAiAsr(" + o + ")");
    }

    /** 前端设置：是否优先走在线识别（更准） */
    @JavascriptInterface
    public void setPreferOnline(boolean v) {
        preferOnline = v;
        if (v) autoOffline = false;
    }

    /** 只保留指定考试 id 的录音，其余 exam_*.wav 删掉（控制占用） */
    @JavascriptInterface
    public void pruneExamAudio(String keepIds) {
        prunePrefixed("exam_", keepIds, 2);
    }

    /** 模拟对话录音：只保留指定会话 id 的 opic_*.wav（id 格式 {id}_{qi}） */
    @JavascriptInterface
    public void pruneChatAudio(String keepIds) {
        prunePrefixed("opic_", keepIds, 1);
    }

    /**
     * 通用清理：删掉 {prefix}{id}_{sep 段} 命名里 id 不在 keepIds 的录音。
     *
     * @param idParts id 与题号之间的下划线段数（exam_{id}_{gi}_{qi} 是 2 段，
     *                opic_{id}_{qi} 是 1 段；id 本身形如 1762248500000）
     */
    private void prunePrefixed(String prefix, String keepIds, int idParts) {
        Set<String> keep = new HashSet<>();
        if (keepIds != null) {
            for (String s : keepIds.split(",")) {
                if (!s.trim().isEmpty()) keep.add(s.trim());
            }
        }
        File dir = new File(act.getFilesDir(), "rec");
        File[] fs = dir.listFiles();
        if (fs == null) return;
        int removed = 0;
        for (File f : fs) {
            String n = f.getName();
            if (!n.startsWith(prefix) || !n.endsWith(".wav")) continue;
            String body = n.substring(prefix.length(), n.length() - 4);
            // 从尾部往前去掉 idParts 段，剩下的是会话 id
            int cut = body.length();
            for (int i = 0; i < idParts; i++) {
                cut = body.lastIndexOf('_', cut - 1);
                if (cut <= 0) { cut = -1; break; }
            }
            String id = cut > 0 ? body.substring(0, cut) : "";
            if (!keep.contains(id) && f.delete()) removed++;
        }
        if (removed > 0) Log.i(TAG, "pruned " + removed + " chat clips");
    }

    /** 指定本次录音的保存名（不含扩展名）；空串表示沿用练习模式的轮换文件 */
    @JavascriptInterface
    public void setClip(String name) {
        clipName = (name == null || name.trim().isEmpty()) ? null : name.trim();
    }

    /**
     * 是否允许"说完自动停"。模拟对话必须关掉：考生长考、停顿、重复组织语言都很常见，
     * 静音 1.2 秒就自动收掉会把回答腰斩。关掉后只能由用户再点一次录音键（stopTurn）结束，
     * 仅保留 5 分钟的安全上限防止忘记点而一直占用麦克风。
     */
    @JavascriptInterface
    public void setAutoStop(boolean v) {
        autoStop = v;
    }

    @JavascriptInterface
    public void startTurn(long expMs) {
        expectedMs = expMs > 0 ? expMs : 3000;
        ui.post(this::doStart);
    }

    @JavascriptInterface
    public void stopTurn() {
        ui.post(this::doStop);
    }

    @JavascriptInterface
    public void cancelTurn() {
        ui.post(() -> {
            stopRecording();
            stopAsr();
        });
    }

    /* ------------------------------------------------------------ 内部实现 */

    private boolean hasMic() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return true;
        return act.checkSelfPermission(Manifest.permission.RECORD_AUDIO)
                == PackageManager.PERMISSION_GRANTED;
    }

    private void doStart() {
        /* 上一轮还没正常收尾（比如前端切页/退考试时没来得及 stop）就先收掉，
         * 否则这里直接 return 会让前端以为在录，实际什么都没录。 */
        if (recording) stopRecording();
        if (!hasMic()) {
            emitPermission(false);
            js("Host.onError&&Host.onError('没有麦克风权限')");
            return;
        }
        seq++;
        final int mySeq = seq;
        t0 = System.currentTimeMillis();
        voicedMs = 0;
        firstLoudAt = 0;
        lastLoudAt = 0;
        noiseFloor = -1;                 // 每轮重新估底噪
        pcm = new ByteArrayOutputStream(32000 * 2 * 10);
        asrText = null;
        asrGot = false;

        emit("Host.onTurnStart&&Host.onTurnStart()");

        // 先开录音，再开识别（部分机型后启动者拿到麦克风，识别优先，保证能评分）
        // 识别启动晚于录音 60ms：留出设备初始化时间，但不至于吃掉句首第一个词
        startRecording(mySeq);
        if (!asrEnabled || aiEnabled) {
            // 练习模式只录音；AI 模式在录音存盘后上传转写，不抢麦克风
            asrGot = true;
        } else {
            ui.postDelayed(() -> { if (recording && mySeq == seq) startAsr(); }, 60);
        }
    }

    /** 设备是否支持"未经处理"的原始麦克风信号（API 24+，Android 7 起多数机型支持） */
    private boolean unprocessedSupported() {
        try {
            AudioManager am = (AudioManager) act.getSystemService(Context.AUDIO_SERVICE);
            return am != null && "true".equals(
                    am.getProperty(AudioManager.PROPERTY_SUPPORT_AUDIO_SOURCE_UNPROCESSED));
        } catch (Throwable t) {
            return false;
        }
    }

    private static String srcName(int src) {
        switch (src) {
            case MediaRecorder.AudioSource.UNPROCESSED: return "UNPROCESSED";
            case MediaRecorder.AudioSource.MIC: return "MIC";
            case MediaRecorder.AudioSource.VOICE_RECOGNITION: return "VOICE_RECOGNITION";
            default: return "SRC" + src;
        }
    }

    private AudioRecord openRecorder(int source, int min) {        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            return new AudioRecord.Builder()
                    .setAudioSource(source)
                    .setAudioFormat(new AudioFormat.Builder()
                            .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                            .setSampleRate(SR_RATE)
                            .setChannelMask(AudioFormat.CHANNEL_IN_MONO)
                            .build())
                    .setBufferSizeInBytes(min * 2)
                    .build();
        }
        return new AudioRecord(source, SR_RATE, AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT, min * 2);
    }

    private void startRecording(final int mySeq) {
        try {
            int min = AudioRecord.getMinBufferSize(SR_RATE, AudioFormat.CHANNEL_IN_MONO,
                    AudioFormat.ENCODING_PCM_16BIT);
            if (min < 2048) min = 2048;

            /* 采集音源顺序很关键（用户反馈"录音比自带录音机小"）：
             * VOICE_RECOGNITION 是给识别用的，很多 ROM 会加降噪/AGC/通话带通，电平被压、高频被削，
             * 回放出来又闷又小声。优先要未经处理的原始信号，最后才退到语音识别音源。 */
            int[] chain = unprocessedSupported()
                    ? new int[]{MediaRecorder.AudioSource.UNPROCESSED,
                                MediaRecorder.AudioSource.MIC,
                                MediaRecorder.AudioSource.VOICE_RECOGNITION}
                    : new int[]{MediaRecorder.AudioSource.MIC,
                                MediaRecorder.AudioSource.VOICE_RECOGNITION};
            arec = null;
            srcName = "";
            for (int src : chain) {
                AudioRecord r = openRecorder(src, min);
                if (r != null && r.getState() == AudioRecord.STATE_INITIALIZED) {
                    arec = r;
                    srcName = srcName(src);
                    break;
                }
                if (r != null) r.release();
            }
            if (arec == null) {
                js("Host.onError&&Host.onError('录音设备初始化失败')");
                return;
            }
            Log.i(TAG, "rec source " + srcName + " @" + SR_RATE);
            recording = true;
            arec.startRecording();

            recThread = new Thread(() -> {
                short[] buf = new short[1024];
                int errs = 0;          // 连续读失败的次数
                try {
                    while (recording && mySeq == seq) {
                        int n;
                        try {
                            n = arec.read(buf, 0, buf.length);
                        } catch (Throwable t) {
                            n = -1;        // 设备被释放/抢占（stopRecording 里置空 arec）
                        }
                        /* read 返回负数表示设备出错（被别的 App 抢占、蓝牙切换、ERROR_DEAD_OBJECT）。
                         * 原来 n<=0 直接 continue，会立刻再次 read 再次失败 —— CPU 空转死循环，
                         * 而且 continue 跳过了后面的超时/静音判断，录音永远停不下来。 */
                        if (n <= 0) {
                            if (++errs >= 20) {
                                final String why = "录音被系统中断（麦克风被占用？）";
                                ui.post(() -> {
                                    js("Host.onError&&Host.onError('" + why + "')");
                                    js("Host.onTurnAbort&&Host.onTurnAbort('" + why + "')");
                                    doStop();
                                });
                                break;
                            }
                            try { Thread.sleep(30); } catch (InterruptedException ignore) { break; }
                            continue;
                        }
                        errs = 0;
                        byte[] bytes = new byte[n * 2];
                        double sum = 0;
                        for (int i = 0; i < n; i++) {
                            short v = buf[i];
                            bytes[i * 2] = (byte) (v & 0xff);
                            bytes[i * 2 + 1] = (byte) ((v >> 8) & 0xff);
                            sum += (double) v * v;
                        }
                        synchronized (TurnController.this) {
                            if (pcm != null) pcm.write(bytes, 0, bytes.length);
                        }
                        double rms = Math.sqrt(sum / n) / 32768.0;
                        long now = System.currentTimeMillis();

                        /* 底噪跟踪：下落快、上升慢。固定阈值 0.012（-38 dBFS）在低灵敏度
                         * 手机/平板上永远判不出"在说话"，表现为电平条几乎不动、自动停止
                         * 也不触发；改成按本机底噪自适应，安静环境与嘈杂环境都能用。 */
                        if (noiseFloor < 0) noiseFloor = rms;
                        else if (rms < noiseFloor) noiseFloor = noiseFloor * 0.7 + rms * 0.3;
                        else noiseFloor = noiseFloor * 0.999 + rms * 0.001;
                        double voiceThr = Math.max(0.0035, noiseFloor * 2.5);
                        if (rms > voiceThr) {
                            lastLoudAt = now;
                            if (firstLoudAt == 0) firstLoudAt = now;
                            voicedMs += (long) (n * 1000.0 / SR_RATE);
                        }
                        /* 电平条按 dB 映射（-58 dBFS → 0，-14 dBFS → 1）：线性映射下
                         * 小声说话（-45 dBFS 左右）只有 2% 高度，看起来像没在录。 */
                        double lvDb = 20 * Math.log10(Math.max(rms, 1e-6));
                        final float lv = (float) Math.max(0, Math.min(1, (lvDb + 58) / 44));
                        ui.post(() -> js("Host.onLevel&&Host.onLevel(" + lv + ")"));
                        final long dur = now - t0;
                        /* 手动模式只有 5 分钟安全上限，不按静音自动收；
                           autoStop 模式沿用 20s 上限 + 静音 1.2s 自动停 */
                        long limit = autoStop ? maxMs : 300000L;
                        if (dur > limit) { ui.post(this::doStop); break; }
                        if (autoStop && firstLoudAt > 0 && now - lastLoudAt > 1200 && voicedMs > 450) {
                            ui.post(this::doStop);
                            break;
                        }
                    }
                } catch (Throwable t) {
                    Log.w(TAG, "rec thread died", t);
                }
            }, "icao-rec");
            recThread.start();
        } catch (Throwable t) {
            Log.w(TAG, "startRecording failed", t);
            js("Host.onError&&Host.onError('无法启动录音')");
        }
    }

    private void stopRecording() {
        recording = false;
        try {
            if (arec != null) {
                try { arec.stop(); } catch (Throwable ignore) {}
                arec.release();
            }
        } catch (Throwable ignore) {}
        arec = null;
        if (recThread != null) {
            try { recThread.join(600); } catch (InterruptedException ignore) {}
            recThread = null;
        }
    }

    private void startAsr() {
        if (!SpeechRecognizer.isRecognitionAvailable(act)) {
            emitAsr(false, "", "本机未安装语音识别服务");
            return;
        }
        try {
            if (sr == null) {
                sr = SpeechRecognizer.createSpeechRecognizer(act);
                sr.setRecognitionListener(new RecognitionListener() {
                    public void onReadyForSpeech(Bundle p) {}
                    public void onBeginningOfSpeech() {}
                    public void onRmsChanged(float v) {}
                    public void onBufferReceived(byte[] b) {}
                    public void onEndOfSpeech() {}
                    public void onEvent(int t, Bundle p) {}

                    public void onError(int err) {
                        asrOn = false;
                        if (asrSeq != seq) return;      // 上一题迟到的失败，别影响这一题
                        if (asrGot) return;
                        asrGot = true;
                        String msg = asrErrorText(err);
                        if (preferOnline && !autoOffline &&
                                (err == SpeechRecognizer.ERROR_NETWORK
                                        || err == SpeechRecognizer.ERROR_NETWORK_TIMEOUT
                                        || err == SpeechRecognizer.ERROR_SERVER
                                        || err == SpeechRecognizer.ERROR_CLIENT)) {
                            autoOffline = true;
                            msg = msg + "（在线识别不可用，后续改用本机离线识别）";
                        }
                        emitAsr(false, "", msg);
                    }

                    public void onResults(Bundle b) {
                        asrOn = false;
                        if (asrSeq != seq) return;      // 上一题迟到的结果，别安到这一题头上
                        if (asrGot) return;
                        asrGot = true;
                        ArrayList<String> list = b == null ? null
                                : b.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
                        if (list == null) list = new ArrayList<String>();
                        float[] conf = b == null ? null
                                : b.getFloatArray(SpeechRecognizer.CONFIDENCE_SCORES);
                        emitAsrList(list, conf, null);
                    }

                    public void onPartialResults(Bundle b) {}
                });
            }
            Intent i = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
            i.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
            i.putExtra(RecognizerIntent.EXTRA_LANGUAGE, "en-US");
            i.putExtra(RecognizerIntent.EXTRA_LANGUAGE_PREFERENCE, "en-US");
            i.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, false);
            i.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 3);
            i.putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, !(preferOnline && !autoOffline));
            i.putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, act.getPackageName());
            i.putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS, 1500);
            i.putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS, 1200);
            asrOn = true;
            asrSeq = seq;
            sr.startListening(i);
        } catch (Throwable t) {
            Log.w(TAG, "startAsr failed", t);
            emitAsr(false, "", "语音识别启动失败");
        }
    }

    private void stopAsr() {
        if (sr != null && asrOn) {
            try { sr.stopListening(); } catch (Throwable ignore) {}
        }
        asrOn = false;
    }

    private String asrErrorText(int err) {
        switch (err) {
            case SpeechRecognizer.ERROR_AUDIO:
                return "麦克风被录音占用，识别失败";
            case SpeechRecognizer.ERROR_NO_MATCH:
                return "没有听清，请再说一遍";
            case SpeechRecognizer.ERROR_SPEECH_TIMEOUT:
                return "没有检测到语音";
            case SpeechRecognizer.ERROR_NETWORK:
            case SpeechRecognizer.ERROR_NETWORK_TIMEOUT:
                return "识别服务需要网络，已失败";
            case SpeechRecognizer.ERROR_RECOGNIZER_BUSY:
                return "识别服务忙，请稍后重试";
            case SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS:
                return "识别服务缺少麦克风权限";
            default:
                return "语音识别不可用";
        }
    }

    private void doStop() {
        if (!recording && pcm == null) {
            /* 没有在进行中的录音（多半是页面切走后状态不同步）：也要回一个空结果，
             * 否则前端会一直停在"编码中…/识别中…"，只能退出页面才能恢复。 */
            JSONObject e = new JSONObject();
            try {
                e.put("url", "");
                e.put("ms", 0);
                e.put("voicedMs", 0);
                e.put("err", "没有录到声音");
            } catch (Exception ignore) {}
            js("Host.onRecord&&Host.onRecord(" + e + ")");
            return;
        }
        long dur = System.currentTimeMillis() - t0;
        stopRecording();
        stopAsr();

        byte[] data;
        synchronized (this) {
            data = pcm == null ? new byte[0] : pcm.toByteArray();
            pcm = null;
        }
        String url = null;
        long ms = dur;
        if (data.length > 0) {
            data = normalize(data);
            File dir = new File(act.getFilesDir(), "rec");
            if (!dir.exists()) dir.mkdirs();
            String name = clipName != null ? clipName : ("turn" + seq);
            File f = new File(dir, name + ".wav");
            // 练习模式只保留最近一条；考试按题命名，全部保留供人工评卷
            if (clipName == null) {
                File[] olds = dir.listFiles();
                if (olds != null) {
                    for (File o : olds) {
                        if (!o.equals(f) && !o.getName().startsWith("exam_")) o.delete();
                    }
                }
            }
            try (FileOutputStream out = new FileOutputStream(f)) {
                writeWav(out, data);
                url = MainActivity.HOST + "rec/" + f.getName();
                ms = data.length / 2L * 1000L / SR_RATE;
            } catch (Throwable t) {
                Log.w(TAG, "save wav failed", t);
            }
            trimRecDir(dir);
        }
        JSONObject o = new JSONObject();
        try {
            o.put("url", url == null ? "" : url);
            o.put("ms", ms);
            o.put("voicedMs", voicedMs);
            o.put("gainDb", Math.round(lastGainDb * 10) / 10.0);
            o.put("inPeakDb", round1(lastInPeakDb));
            o.put("outPeakDb", round1(lastOutPeakDb));
            o.put("rmsDb", round1(lastRmsDb));
            o.put("src", srcName);
            o.put("rate", SR_RATE);
        } catch (Exception ignore) {}
        js("Host.onRecord&&Host.onRecord(" + o + ")");

        // 识别结果迟迟不来时，兜底通知前端（AI 模式由前端自己等，不插手）
        if (asrEnabled && !aiEnabled) {
            final int mySeq = seq;
            ui.postDelayed(() -> {
                if (mySeq == seq && !asrGot) {
                    asrGot = true;
                    emitAsr(false, "", "语音识别超时，请重试或改用 AI 识别");
                }
            }, 4500);
        }
    }

    /**
     * 录音电平后处理：80Hz 高通（去直流/低频轰鸣）+ <b>响度归一</b>，不是峰值归一。
     *
     * <p>旧版按"帧峰值的 95 分位"归一到 -1 dBFS，看似把峰值拉满了，但人耳听的是平均能量：
     * 一句话里只要有一个碰麦/咳嗽的瞬态，峰值就顶到 0 dBFS，主体语音的 RMS 仍在 -30 dBFS 左右，
     * 回放出来照样小声。现在改成按<b>语音帧的 RMS 中位数</b>拉到约 -16 dBFS（正常语音/播客水平）。</p>
     *
     * <p>1.1.1 又修了两个会让"增益 = 0 dB 但录音很小声"的问题：</p>
     * <ul>
     *   <li>门限/峰值参考改成<b>跳过开头 150 ms + 90 分位</b>。开头那声爆音会把"最响帧"顶高，
     *       旧版据此算门限，人声全部落到门限以下，语音帧不足 3 个就直接原样返回（增益 0）。</li>
     *   <li>语音帧不足时不再原样返回，而是退回全帧统计，把增益推到 +38 dB 上限。</li>
     *   <li>峰值参考限制在 8 倍 RMS 的合理峰值因数内，瞬态不再压住增益，改由 tanh 软限幅兜住。</li>
     * </ul>
     */
    private byte[] normalize(byte[] pcm) {
        int n = pcm.length / 2;
        lastGainDb = 0;
        lastInPeakDb = lastOutPeakDb = lastRmsDb = -120;
        if (n < SR_RATE / 10) return pcm;

        double[] x = new double[n];
        for (int i = 0; i < n; i++) {
            x[i] = ((pcm[i * 2] & 0xff) | (pcm[i * 2 + 1] << 8)) / 32768.0;
        }
        double a = Math.exp(-2 * Math.PI * 80.0 / SR_RATE);
        double px = 0, py = 0;
        double rawPeak = 0;
        for (int i = 0; i < n; i++) {
            double cur = a * (py + x[i] - px);
            px = x[i];
            py = cur;
            x[i] = cur;
            double av = Math.abs(cur);
            if (av > rawPeak) rawPeak = av;
        }
        lastInPeakDb = db(rawPeak);

        int frame = Math.max(1, SR_RATE / 50);          // 20 ms
        int frames = Math.max(1, n / frame);
        double[] fr = new double[frames];               // 每帧峰值
        double[] fe = new double[frames];               // 每帧 RMS
        for (int f = 0; f < frames; f++) {
            int st = f * frame, en = Math.min(n, st + frame);
            double mx = 0, sum = 0;
            for (int i = st; i < en; i++) {
                double av = Math.abs(x[i]);
                if (av > mx) mx = av;
                sum += x[i] * x[i];
            }
            fr[f] = mx;
            fe[f] = Math.sqrt(sum / Math.max(1, en - st));
        }

        /* 统计从 150 ms 之后开始：麦克风刚打开时常有一声爆音/直流台阶，这一下会把
         * "最响帧"和门限一起抬高，让整句人声都被判成静音。旧版正是栽在这里——
         * 语音帧数不足 3，函数原样返回，于是出现"增益 0 dB，但录音还是很小声"。 */
        int skip = Math.min(frames / 2, (int) (SR_RATE * 0.15) / frame);
        if (frames - skip < 3) skip = 0;

        // 帧 RMS 的 90 分位当作"最响"：几个爆音/碰麦帧改不动它
        double[] se = new double[frames - skip];
        System.arraycopy(fe, skip, se, 0, se.length);
        java.util.Arrays.sort(se);
        double hiRms = se[Math.min(se.length - 1, (int) (se.length * 0.90))];
        double gate = Math.max(0.00126, hiRms * 0.10);   // 比最响低 20 dB 以内算在说话

        double[] voiced = new double[frames - skip];
        int vc = 0;
        for (int f = skip; f < frames; f++) {
            if (fe[f] >= gate) voiced[vc++] = fe[f];
        }
        if (vc < 3) {
            /* 没有稳定的语音帧（极小声，或人声被爆音压住）：退回用全部帧做参考。
             * 宁可把增益推到上限，也不要原样返回一段听不清的录音。 */
            vc = 0;
            for (int f = skip; f < frames; f++) voiced[vc++] = fe[f];
        }
        java.util.Arrays.sort(voiced, 0, vc);
        double refRms = voiced[Math.min(vc - 1, (int) (vc * 0.75))];   // 语音帧 RMS 的 75 分位
        if (refRms < 1e-5) {                            // 数字静音：放大只会把底噪拉满
            lastOutPeakDb = lastInPeakDb;
            lastRmsDb = db(mean(fe));
            return pcm;
        }
        double inRms = mean(fe);

        double target = 0.15;                           // ≈ -16 dBFS，正常语音/播客响度
        double gain = target / Math.max(refRms, 1e-9);

        /* 峰值参考同样取 90 分位，并限制在"合理峰值因数"内：超过 8 倍 RMS 的尖峰
         * 视为碰麦/爆音等瞬态，不让它压住增益（否则一声咳嗽就把整句打回原样），
         * 交给后面的 tanh 软限幅兜住。peakCap 允许峰值略过 1.2，也是留给软限幅。 */
        double[] sp = new double[frames - skip];
        System.arraycopy(fr, skip, sp, 0, sp.length);
        java.util.Arrays.sort(sp);
        double pkRef = sp[Math.min(sp.length - 1, (int) (sp.length * 0.90))];
        if (pkRef > refRms * 8) pkRef = refRms * 8;
        double peakCap = 1.2 / Math.max(pkRef, 1e-9);
        if (gain > peakCap) gain = peakCap;
        if (gain < 1.0) gain = 1.0;                     // 已经够响就不衰减
        if (gain > 79.0) gain = 79.0;                   // 上限约 +38 dB
        lastGainDb = 20 * Math.log10(gain);

        byte[] out = new byte[n * 2];
        double outPeak = 0;
        for (int i = 0; i < n; i++) {
            double v = x[i] * gain;
            double av = Math.abs(v);
            if (av > 0.85) {                            // 0.85 以下线性，以上 tanh 平滑饱和
                double z = (av - 0.85) / 0.15;
                v = Math.signum(v) * (0.85 + 0.15 * Math.tanh(z * 1.2));
            }
            if (v > 0.999) v = 0.999;
            if (v < -0.999) v = -0.999;
            double a2 = Math.abs(v);
            if (a2 > outPeak) outPeak = a2;
            int s = (int) Math.round(v * 32767);
            out[i * 2] = (byte) (s & 0xff);
            out[i * 2 + 1] = (byte) ((s >> 8) & 0xff);
        }
        lastOutPeakDb = db(outPeak);
        // 报告"语音平均电平"用归一化后的语音帧电平（含静音的全体均值会低 6~10 dB，容易误导）
        lastRmsDb = db(Math.min(0.99, refRms * gain));
        Log.i(TAG, "rec norm src=" + srcName + " inPeak=" + round1(lastInPeakDb)
                + "dB inRms=" + round1(db(inRms)) + "dB gain=" + round1(lastGainDb)
                + "dB outPeak=" + round1(lastOutPeakDb) + "dB outRms=" + round1(lastRmsDb) + "dB");
        return out;
    }

    /**
     * 录音目录总量兜底：考试录音只有在交卷时才会按记录 id 清理，中途弃考的录音会一直躺着。
     * 这里在每次存盘后检查总量，超过 60MB 就按修改时间从最老的 exam_*.wav 开始删到 50MB 以下。
     */
    private void trimRecDir(File dir) {
        File[] fs = dir.listFiles();
        if (fs == null || fs.length < 6) return;
        long total = 0;
        java.util.ArrayList<File> exams = new java.util.ArrayList<File>();
        for (File f : fs) {
            total += f.length();
            if (f.getName().startsWith("exam_")) exams.add(f);
        }
        if (total <= REC_CAP) return;
        java.util.Collections.sort(exams, new java.util.Comparator<File>() {
            public int compare(File a, File b) {
                long x = a.lastModified(), y = b.lastModified();
                return x < y ? -1 : (x > y ? 1 : 0);
            }
        });
        long low = REC_CAP * 4 / 5;
        for (File f : exams) {
            if (total <= low) break;
            long len = f.length();
            if (f.delete()) total -= len;
        }
        Log.i(TAG, "rec dir trimmed to " + (total / 1024) + " KB");
    }

    private static double db(double amp) {        return amp <= 1e-9 ? -120.0 : 20 * Math.log10(amp);
    }

    private static double mean(double[] a) {
        if (a.length == 0) return 0;
        double s = 0;
        for (double v : a) s += v;
        return s / a.length;
    }

    private static double round1(double v) {
        return Math.round(v * 10) / 10.0;
    }

    /** 插入 44 字节 WAV 头（16k / 16bit / 单声道） */
    private static void writeWav(FileOutputStream out, byte[] pcm) throws Exception {
        int dataLen = pcm.length;
        int byteRate = SR_RATE * 2;
        byte[] h = new byte[44];
        h[0] = 'R'; h[1] = 'I'; h[2] = 'F'; h[3] = 'F';
        putInt(h, 4, 36 + dataLen);
        h[8] = 'W'; h[9] = 'A'; h[10] = 'V'; h[11] = 'E';
        h[12] = 'f'; h[13] = 'm'; h[14] = 't'; h[15] = ' ';
        putInt(h, 16, 16);
        h[20] = 1; h[21] = 0;
        h[22] = 1; h[23] = 0;
        putInt(h, 24, SR_RATE);
        putInt(h, 28, byteRate);
        h[32] = 2; h[33] = 0;
        h[34] = 16; h[35] = 0;
        h[36] = 'd'; h[37] = 'a'; h[38] = 't'; h[39] = 'a';
        putInt(h, 40, dataLen);
        out.write(h);
        out.write(pcm);
    }

    private static void putInt(byte[] b, int off, int v) {
        b[off] = (byte) (v & 0xff);
        b[off + 1] = (byte) ((v >> 8) & 0xff);
        b[off + 2] = (byte) ((v >> 16) & 0xff);
        b[off + 3] = (byte) ((v >> 24) & 0xff);
    }

    void hardStop() {
        ui.post(() -> {
            boolean wasBusy = recording || asrOn;
            stopRecording();
            stopAsr();
            if (wasBusy) {
                /* 切后台/来电把录音打断：半截数据直接丢掉，并通知前端复位，
                 * 否则前端会一直停在"录音中/识别中"，回来点按钮只会发 stopTurn。 */
                synchronized (this) { pcm = null; }
                js("Host.onTurnAbort&&Host.onTurnAbort('录音被中断')");
            }
        });
    }

    void release() {
        hardStop();
        ui.post(() -> {
            if (sr != null) {
                try { sr.destroy(); } catch (Throwable ignore) {}
                sr = null;
            }
        });
    }

    void emitPermission(boolean granted) {
        js("Host.onPermission&&Host.onPermission(" + granted + ")");
    }

    private void emitAsr(boolean ok, String text, String msg) {
        ArrayList<String> one = new ArrayList<String>();
        if (text != null && !text.isEmpty()) one.add(text);
        emitAsrList(ok ? one : new ArrayList<String>(), null, msg);
    }

    /** 把全部识别候选一起给前端：离线识别常把同一句给出 2~3 种写法，取最贴合的一条 */
    private void emitAsrList(ArrayList<String> list, float[] conf, String msg) {
        JSONObject o = new JSONObject();
        JSONArray arr = new JSONArray();
        String first = "";
        float firstConf = -1;
        for (int i = 0; i < list.size(); i++) {
            String s = list.get(i);
            if (s == null || s.trim().isEmpty()) continue;
            if (first.isEmpty()) {
                first = s;
                if (conf != null && i < conf.length) firstConf = conf[i];
            }
            arr.put(s.trim());
        }
        try {
            o.put("ok", !first.isEmpty());
            o.put("text", first);
            o.put("alts", arr);
            o.put("conf", firstConf);
            o.put("msg", msg == null ? (first.isEmpty() ? "没有听清，请再说一遍" : "") : msg);
        } catch (Exception ignore) {}
        js("Host.onAsr&&Host.onAsr(" + o + ")");
    }

    private void js(final String code) {
        if (Looper.myLooper() != Looper.getMainLooper()) {
            ui.post(() -> {
                try { web.evaluateJavascript(code, null); } catch (Throwable ignore) {}
            });
            return;
        }
        try { web.evaluateJavascript(code, null); } catch (Throwable ignore) {}
    }

    private void emit(String code) { js(code); }
}
