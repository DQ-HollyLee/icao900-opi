package com.icao.opi;

import android.app.Activity;
import android.app.ActivityManager;
import android.content.Context;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * 本地离线语音识别：Qwen3-ASR-0.6B（GGUF）+ llama.cpp 的 llama-mtmd-cli。
 *
 * <p>为什么要单独一个进程：llama.cpp 是 C++ 的（这里没有 NDK 自编译条件），官方发布的
 * Android arm64 可执行文件直接随 APK 打包成 {@code lib/arm64-v8a/libmtmdcli.so}，
 * 系统会把它解压到 nativeLibraryDir（只有这个目录允许执行 ELF），然后用 ProcessBuilder 调起。
 * 模型文件体积太大（约 1GB）不适合塞进 APK，改成应用内首次下载。</p>
 */
class LocalAsr {

    private static final String TAG = "ICAO900ASR";

    static final String MODEL = "Qwen3-ASR-0.6B-Q8_0.gguf";
    static final long MODEL_BYTES = 804749248L;
    static final String MMPROJ = "mmproj-Qwen3-ASR-0.6B-Q8_0.gguf";
    static final long MMPROJ_BYTES = 214392480L;
    private static final String REPO = "https://hf-mirror.com/ggml-org/Qwen3-ASR-0.6B-GGUF/resolve/main/";

    private final Activity act;
    private final WebView web;
    private final Handler ui = new Handler(Looper.getMainLooper());
    private final File dir;

    private volatile boolean downloading = false;
    private volatile boolean transcribing = false;
    private volatile boolean timedOut = false;
    private volatile Process proc;
    private Thread dlThread;
    private Thread asrThread;

    LocalAsr(Activity a, WebView w) {
        act = a;
        web = w;
        dir = new File(a.getFilesDir(), "asr");
        if (!dir.exists()) dir.mkdirs();
    }

    /* ------------------------------------------------------------- 设备能力 */

    /** 给界面的能力探测：能不能跑、差多少 */
    @JavascriptInterface
    public String info() {
        JSONObject o = new JSONObject();
        try {
            ActivityManager am = (ActivityManager) act.getSystemService(Context.ACTIVITY_SERVICE);
            ActivityManager.MemoryInfo mi = new ActivityManager.MemoryInfo();
            long totalMb = 0, availMb = 0;
            if (am != null) {
                am.getMemoryInfo(mi);
                totalMb = mi.totalMem / 1048576L;
                availMb = mi.availMem / 1048576L;
            }
            String abi = Build.SUPPORTED_ABIS.length > 0 ? Build.SUPPORTED_ABIS[0] : "";
            o.put("abi", abi);
            o.put("cores", Runtime.getRuntime().availableProcessors());
            o.put("totalMb", totalMb);
            o.put("availMb", availMb);
            o.put("freeDiskMb", dir.getUsableSpace() / 1048576L);
            o.put("sdk", Build.VERSION.SDK_INT);
            o.put("device", Build.MANUFACTURER + " " + Build.MODEL);
            o.put("arm64", abi.contains("arm64"));
            // 跑 0.6B Q8 的实测占用约 1.2~1.5GB，总内存低于 4GB 基本没戏
            boolean memOk = totalMb >= 3800;
            boolean diskOk = dir.getUsableSpace() >= (MODEL_BYTES + MMPROJ_BYTES) * 3 / 2;
            o.put("memOk", memOk);
            o.put("diskOk", diskOk);
            o.put("ok", o.getBoolean("arm64") && memOk && diskOk);
            String why = "";
            if (!o.getBoolean("arm64")) why = "这台设备的 ABI 是 " + abi + "，本地模型只提供 arm64 版本";
            else if (!memOk) why = "总内存只有 " + totalMb + " MB，本地模型需要 4GB 以上（建议 8GB）";
            else if (!diskOk) why = "存储剩余 " + (dir.getUsableSpace() / 1048576L) + " MB，至少需要 1.8GB";
            o.put("reason", why);
            o.put("modelReady", modelReady());
            o.put("modelBytes", fileLen(new File(dir, MODEL)));
            o.put("mmprojBytes", fileLen(new File(dir, MMPROJ)));
            o.put("modelTotal", MODEL_BYTES);
            o.put("mmprojTotal", MMPROJ_BYTES);
            o.put("downloading", downloading);
        } catch (Throwable t) {
            try { o.put("ok", false); o.put("reason", "读取设备信息失败"); } catch (Exception ignore) {}
        }
        return o.toString();
    }

    private static long fileLen(File f) {
        return f.exists() ? f.length() : 0L;
    }

    boolean modelReady() {
        File m = new File(dir, MODEL), p = new File(dir, MMPROJ);
        return m.exists() && m.length() >= MODEL_BYTES - 1024
                && p.exists() && p.length() >= MMPROJ_BYTES - 1024;
    }

    /* ------------------------------------------------------------- 模型下载 */

    @JavascriptInterface
    public void download() {
        if (downloading) return;
        if (!new File(dir, MODEL).exists() && dir.getUsableSpace() < MODEL_BYTES + MMPROJ_BYTES + (64L << 20)) {
            emitStatus("磁盘空间不足，至少需要 1.8GB 空闲");
            return;
        }
        downloading = true;
        dlThread = new Thread(() -> {
            try {
                fetch(MODEL, MODEL_BYTES);
                fetch(MMPROJ, MMPROJ_BYTES);
                downloading = false;
                emitProgress("done", 1, 1);
                emitStatus(modelReady() ? "" : "下载完成但文件大小不对，请重试");
                emit("Host.onAsrReady&&Host.onAsrReady(" + info() + ")");
            } catch (Throwable t) {
                downloading = false;
                String m = t.getMessage();
                Log.w(TAG, "download failed", t);
                emitStatus("下载失败：" + (m == null ? "网络错误" : m));
                emit("Host.onAsrReady&&Host.onAsrReady(" + info() + ")");
            }
        }, "icao-asr-dl");
        dlThread.start();
    }

    @JavascriptInterface
    public void cancelDownload() {
        downloading = false;
    }

    /** 单文件下载，支持断点续传（.part 临时文件） */
    private void fetch(String name, long expect) throws Exception {
        File dst = new File(dir, name);
        if (dst.exists() && dst.length() >= expect) {
            emitProgress(name, expect, expect);
            return;
        }
        File part = new File(dir, name + ".part");
        long have = part.exists() ? part.length() : 0;
        if (have > expect) { part.delete(); have = 0; }

        HttpURLConnection c = (HttpURLConnection) new URL(REPO + name).openConnection();
        c.setConnectTimeout(20000);
        c.setReadTimeout(60000);
        c.setRequestProperty("User-Agent", "ICAO900-Android");
        if (have > 0) c.setRequestProperty("Range", "bytes=" + have + "-");
        c.connect();
        int code = c.getResponseCode();
        if (code == 416) {                          // 已经下完但长度不符，重来
            part.delete();
            throw new IOException("服务器拒绝续传，请重试");
        }
        if (code != 200 && code != 206) throw new IOException("HTTP " + code);
        long start = code == 206 ? have : 0;
        if (code == 200 && have > 0) {
            part.delete();                           // 服务器不支持续传，从头写
        }
        long total = expect;
        long cl = c.getContentLength();
        if (code == 206 && cl > 0) total = start + cl;

        InputStream in = c.getInputStream();
        OutputStream out = new FileOutputStream(part, start > 0);
        byte[] buf = new byte[64 * 1024];
        long done = start, lastEmit = 0;
        try {
            int n;
            while ((n = in.read(buf)) > 0) {
                if (!downloading) throw new IOException("已取消");
                out.write(buf, 0, n);
                done += n;
                long now = System.currentTimeMillis();
                if (now - lastEmit > 400 || done >= total) {
                    lastEmit = now;
                    emitProgress(name, done, total);
                }
            }
        } finally {
            try { in.close(); } catch (Exception ignore) {}
            try { out.close(); } catch (Exception ignore) {}
            c.disconnect();
        }
        if (part.length() < expect - 1024) throw new IOException("文件不完整（" + part.length() + "/" + expect + "）");
        if (!part.renameTo(dst)) {
            // 某些机型 rename 覆盖失败，退化为复制
            throw new IOException("保存模型文件失败");
        }
        emitProgress(name, expect, expect);
    }

    @JavascriptInterface
    public void deleteModels() {
        downloading = false;
        File[] fs = dir.listFiles();
        if (fs != null) for (File f : fs) f.delete();
        emit("Host.onAsrReady&&Host.onAsrReady(" + info() + ")");
    }

    /* ------------------------------------------------------------- 转写 */

    /**
     * @param url 形如 https://app.local/rec/xxx.wav，只取文件名
     */
    @JavascriptInterface
    public void transcribe(String url) {
        if (transcribing) { emitAsr(false, "", "上一句还在转写，请稍等"); return; }
        if (!modelReady()) { emitAsr(false, "", "本地模型还没下载完"); return; }
        String name = url == null ? "" : url.substring(url.lastIndexOf('/') + 1);
        final File wav = new File(new File(act.getFilesDir(), "rec"), name);
        if (!wav.exists()) { emitAsr(false, "", "录音文件不存在"); return; }

        transcribing = true;
        final long t0 = System.currentTimeMillis();
        asrThread = new Thread(() -> {
            String err = null, text = "";
            try {
                text = runCli(wav);
            } catch (Throwable t) {
                Log.w(TAG, "local asr failed", t);
                err = t.getMessage() == null ? "本地识别失败" : t.getMessage();
            }
            transcribing = false;
            proc = null;
            long ms = System.currentTimeMillis() - t0;
            emitAsr(err == null, text, err == null ? "" : err, ms);
        }, "icao-asr-run");
        asrThread.start();
    }

    @JavascriptInterface
    public void cancelAsr() {
        transcribing = false;
        Process p = proc;
        if (p != null) { try { p.destroy(); } catch (Throwable ignore) {} }
    }

    /** 跑一次 llama-mtmd-cli，从输出里取 <asr_text> 后面的内容 */
    private String runCli(File wav) throws Exception {
        timedOut = false;
        String libDir = act.getApplicationInfo().nativeLibraryDir;
        File cli = new File(libDir, "libmtmdcli.so");
        if (!cli.exists()) throw new IOException("缺少本地识别组件（libmtmdcli.so）");

        int cores = Runtime.getRuntime().availableProcessors();
        int threads = Math.max(2, Math.min(6, cores - 1));

        /* 首选从 nativeLibraryDir 直接执行（系统解压出来的只读目录，最稳）。
         * 万一动态库解析不到（不同 ROM 的 linker 行为不一致），把整套 so 复制到
         * files/asr/bin 再从那里执行一次。 */
        String raw;
        int code;
        Object[] r0 = exec(cli, libDir, wav, threads);
        code = (Integer) r0[0];
        raw = (String) r0[1];
        if (timedOut) throw new IOException("本地识别超时（90 秒），建议改用 AI 识别或系统识别");
        if (!transcribing) throw new IOException("已取消");
        if (code != 0 && !raw.contains("<asr_text>") && raw.contains(".so")) {
            Log.w(TAG, "fallback to copied libs, first attempt said: " + raw.substring(0, Math.min(300, raw.length())));
            File bin = stageLibs();
            Object[] r = exec(new File(bin, "libmtmdcli.so"), bin.getAbsolutePath(), wav, threads);
            code = (Integer) r[0];
            raw = (String) r[1];
        }
        if (timedOut) throw new IOException("本地识别超时（90 秒），建议改用 AI 识别或系统识别");
        if (!transcribing) throw new IOException("已取消");
        Log.i(TAG, "cli exit=" + code + " out=" + raw.replace('\n', ' '));
        if (code != 0 && !raw.contains("<asr_text>")) {
            String tip = raw.length() > 160 ? raw.substring(raw.length() - 160) : raw;
            throw new IOException("本地识别失败（退出码 " + code + "）" + tip.replace('\n', ' ').trim());
        }

        String t = raw;
        int k = t.indexOf("<asr_text>");
        if (k >= 0) t = t.substring(k + "<asr_text>".length());
        t = t.trim();
        // "language English" 前缀（没有 asr_text 标记时才会残留）
        if (t.toLowerCase(Locale.US).startsWith("language ")) {
            int sp = t.indexOf(' ', 9);
            if (sp > 0) t = t.substring(sp + 1).trim();
        }
        t = t.replaceAll("^[\\s\\p{Punct}]+", "").trim();
        if (t.isEmpty()) throw new IOException("没有识别出文本（退出码 " + code + "）");
        return t;
    }

    /** 执行一次 CLI；返回 {exitCode, 全部输出（stdout+stderr 合并）} */
    private Object[] exec(File cli, String libPath, File wav, int threads) throws Exception {
        List<String> cmd = new ArrayList<String>();
        cmd.add(cli.getAbsolutePath());
        cmd.add("-m");
        cmd.add(new File(dir, MODEL).getAbsolutePath());
        cmd.add("--mmproj");
        cmd.add(new File(dir, MMPROJ).getAbsolutePath());
        cmd.add("--audio");
        cmd.add(wav.getAbsolutePath());
        cmd.add("-p");
        cmd.add(" ");                    // 必须非空，否则 CLI 会进交互式 chat 模式卡住
        cmd.add("-n");
        cmd.add("128");
        cmd.add("-t");
        cmd.add(String.valueOf(threads));
        cmd.add("--no-warmup");

        ProcessBuilder pb = new ProcessBuilder(cmd);
        pb.directory(dir);
        /* 日志和结果都走同一个管道：llama.cpp 往 stderr 刷大量进度信息，
         * 只读 stdout 会把 64KB 管道写满，子进程直接卡死。 */
        pb.redirectErrorStream(true);
        pb.environment().put("LD_LIBRARY_PATH", libPath);
        pb.environment().put("GGML_BACKEND_PATH", libPath);
        Process p = pb.start();
        proc = p;

        final Process fp = p;
        ui.postDelayed(() -> {
            if (proc == fp && transcribing) {
                timedOut = true;
                transcribing = false;
                try { fp.destroy(); } catch (Throwable ignore) {}
            }
        }, 90000);

        StringBuilder out = new StringBuilder();
        InputStream is = p.getInputStream();
        byte[] buf = new byte[8192];
        int n;
        try {
            while ((n = is.read(buf)) > 0) {
                out.append(new String(buf, 0, n, "UTF-8"));
                if (out.length() > 400000) break;
            }
        } finally {
            try { is.close(); } catch (Exception ignore) {}
        }
        int code = p.waitFor();
        return new Object[]{code, out.toString()};
    }

    /** 把 CLI 和依赖库复制到 files/asr/bin（回退方案用） */
    private File stageLibs() throws Exception {
        File bin = new File(dir, "bin");
        if (!bin.exists()) bin.mkdirs();
        String libDir = act.getApplicationInfo().nativeLibraryDir;
        File src = new File(libDir);
        File[] fs = src.listFiles();
        if (fs == null) throw new IOException("读取 native 库目录失败");
        for (File f : fs) {
            if (!f.getName().endsWith(".so")) continue;
            File dst = new File(bin, f.getName());
            if (dst.exists() && dst.length() == f.length()) continue;
            copy(f, dst);
        }
        File cli = new File(bin, "libmtmdcli.so");
        cli.setExecutable(true, false);
        return bin;
    }

    private static void copy(File a, File b) throws Exception {
        InputStream in = new java.io.FileInputStream(a);
        OutputStream out = new FileOutputStream(b);
        try {
            byte[] buf = new byte[64 * 1024];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        } finally {
            try { in.close(); } catch (Exception ignore) {}
            try { out.close(); } catch (Exception ignore) {}
        }
    }

    /* ------------------------------------------------------------- 回调 */

    private void emitStatus(String msg) {
        try {
            JSONObject o = new JSONObject();
            o.put("msg", msg == null ? "" : msg);
            o.put("downloading", downloading);
            emit("Host.onAsrStatus&&Host.onAsrStatus(" + o + ")");
        } catch (Exception ignore) {}
    }

    private void emitProgress(String name, long done, long total) {
        try {
            JSONObject o = new JSONObject();
            o.put("name", name);
            o.put("done", done);
            o.put("total", total);
            emit("Host.onAsrProgress&&Host.onAsrProgress(" + o + ")");
        } catch (Exception ignore) {}
    }

    private void emitAsr(boolean ok, String text, String msg) {
        emitAsr(ok, text, msg, 0);
    }

    private void emitAsr(boolean ok, String text, String msg, long ms) {
        try {
            JSONObject o = new JSONObject();
            o.put("ok", ok);
            o.put("text", text == null ? "" : text);
            o.put("msg", msg == null ? "" : msg);
            o.put("ms", ms);
            o.put("local", true);
            emit("Host.onLocalAsr&&Host.onLocalAsr(" + o + ")");
        } catch (Exception ignore) {}
    }

    private void emit(String js) {
        ui.post(() -> {
            try { web.evaluateJavascript(js, null); } catch (Throwable ignore) {}
        });
    }

    void release() {
        downloading = false;
        transcribing = false;
        Process p = proc;
        if (p != null) { try { p.destroy(); } catch (Throwable ignore) {} }
    }
}
