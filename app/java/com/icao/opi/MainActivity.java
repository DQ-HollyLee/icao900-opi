package com.icao.opi;

import android.Manifest;
import android.app.Activity;
import android.content.pm.PackageManager;
import android.content.res.AssetFileDescriptor;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.ConsoleMessage;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.HashMap;
import java.util.Map;

/**
 * 单 Activity + WebView 外壳。
 * UI 在 assets 里（HTML/CSS/JS），音频、录音、语音识别由原生提供。
 * 资源通过虚拟域名 https://app.local/ 提供，避免 file:// 的各种限制。
 */
public class MainActivity extends Activity {

    public static final String HOST = "https://app.local/";
    private static final String TAG = "ICAO900";
    private static final int REQ_MIC = 1101;

    private WebView web;
    private TurnController turn;
    private LocalAsr localAsr;
    private ChatClient chat;
    private boolean pageReady = false;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        requestWindowFeature(Window.FEATURE_NO_TITLE);
        getWindow().setStatusBarColor(0xFF0B1F3A);
        getWindow().setNavigationBarColor(0xFFFFFFFF);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            getWindow().addFlags(WindowManager.LayoutParams.FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS);
        }

        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setCacheMode(WebSettings.LOAD_NO_CACHE);
        s.setTextZoom(100);
        s.setSupportZoom(false);
        s.setUseWideViewPort(false);
        s.setLoadWithOverviewMode(false);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        }

        web.setWebViewClient(new LocalClient());
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onConsoleMessage(ConsoleMessage m) {
                Log.i(TAG, "js: " + m.message() + " @" + m.lineNumber());
                return true;
            }
        });
        web.setBackgroundColor(0xFFF4F8FD);
        web.setOverScrollMode(View.OVER_SCROLL_NEVER);

        turn = new TurnController(this, web);
        web.addJavascriptInterface(turn, "ICAOBridge");

        localAsr = new LocalAsr(this, web);
        web.addJavascriptInterface(localAsr, "ICAOAsr");

        chat = new ChatClient(web);
        web.addJavascriptInterface(chat, "ICAOChat");

        // 只读版本号：设置页底部显示，方便确认装的是哪一版
        final String ver = appVersion();
        web.addJavascriptInterface(new Object() {
            @android.webkit.JavascriptInterface
            public String version() {
                return ver;
            }
        }, "ICAOMeta");

        setContentView(web);
        web.loadUrl(HOST + "index.html");

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M
                && checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, REQ_MIC);
        }
    }

    private String appVersion() {
        try {
            return getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
        } catch (Exception e) {
            return "1.0.0";
        }
    }

    @Override
    public void onRequestPermissionsResult(int code, String[] perms, int[] res) {        super.onRequestPermissionsResult(code, perms, res);
        boolean granted = res.length > 0 && res[0] == PackageManager.PERMISSION_GRANTED;
        turn.emitPermission(granted);
        if (!granted) {
            Toast.makeText(this, "没有麦克风权限，录音评分不可用", Toast.LENGTH_LONG).show();
        }
    }

    @Override
    public void onBackPressed() {
        if (!pageReady) { finish(); return; }
        web.evaluateJavascript("(window.ICAOBack?window.ICAOBack():false)", value -> {
            if (!"true".equals(value)) {
                finish();
            }
        });
    }

    @Override
    protected void onPause() {
        super.onPause();
        /* 不调用 web.onPause()：部分机型息屏/切屏回来后 WebView 渲染面丢失，
         * 表现为整页白屏、要等 JS 重新渲染（返回再重进）才恢复。
         * 屏灭时系统本来就不给 WebView 送帧，这里停掉录音即可。 */
        if (turn != null) turn.hardStop();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (web != null) {
            web.onResume();
            /* 防御：个别 ROM 回前台时不补画最后一帧（渲染面换了没触发重绘），
             * 强制 requestLayout + invalidate，再把可见性切一轮逼出新帧。 */
            web.requestLayout();
            web.invalidate();
            web.post(() -> {
                if (web.getVisibility() == View.VISIBLE) {
                    web.setVisibility(View.INVISIBLE);
                    web.setVisibility(View.VISIBLE);
                }
            });
        }
    }

    @Override
    protected void onDestroy() {
        if (turn != null) turn.release();
        if (localAsr != null) localAsr.release();
        if (chat != null) chat.release();
        if (web != null) {
            web.removeJavascriptInterface("ICAOBridge");
            web.removeJavascriptInterface("ICAOChat");
            web.destroy();
        }
        super.onDestroy();
    }

    void setPageReady() { pageReady = true; }

    /** 拦截虚拟域名，返回 assets / 录音文件 */
    private class LocalClient extends WebViewClient {
        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest req) {
            String url = req.getUrl().toString();
            if (!url.startsWith(HOST)) return null;
            String path = url.substring(HOST.length());
            int q = path.indexOf('?');
            if (q > 0) path = path.substring(0, q);
            try {
                if (path.startsWith("rec/")) {
                    if (path.contains("..")) return notFound();   // 不让 ../ 跳出录音目录
                    File f = new File(getFilesDir(), path);
                    if (!f.exists()) return notFound();
                    Map<String, String> h = new HashMap<>();
                    h.put("Content-Length", String.valueOf(f.length()));
                    h.put("Cache-Control", "no-store");
                    return new WebResourceResponse("audio/wav", null, 200, "OK", h,
                            new FileInputStream(f));
                }
                String name = path.isEmpty() ? "index.html" : path;
                InputStream in = getAssets().open(name);
                Map<String, String> h = new HashMap<>();
                h.put("Cache-Control", "no-cache");
                // 音频需要长度信息，播放器才能正常 seek / 判断时长
                try {
                    AssetFileDescriptor fd = getAssets().openFd(name);
                    long len = fd.getLength();
                    if (len > 0) h.put("Content-Length", String.valueOf(len));
                    fd.close();
                } catch (IOException ignore) {
                    // 压缩资源没有 fd，忽略
                }
                WebResourceResponse r = new WebResourceResponse(mime(name), "UTF-8", 200, "OK",
                        h, in);
                return r;
            } catch (IOException e) {
                return notFound();
            }
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
            return !req.getUrl().toString().startsWith(HOST);
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            setPageReady();
        }
    }

    private WebResourceResponse notFound() {
        return new WebResourceResponse("text/plain", "UTF-8", 404, "Not Found",
                new HashMap<String, String>(), new ByteArrayInputStream(new byte[0]));
    }

    private static String mime(String p) {
        String l = p.toLowerCase();
        if (l.endsWith(".html") || l.endsWith(".htm")) return "text/html";
        if (l.endsWith(".css")) return "text/css";
        if (l.endsWith(".js")) return "application/javascript";
        if (l.endsWith(".json")) return "application/json";
        if (l.endsWith(".mp3")) return "audio/mpeg";
        if (l.endsWith(".wav")) return "audio/wav";
        if (l.endsWith(".png")) return "image/png";
        if (l.endsWith(".svg")) return "image/svg+xml";
        if (l.endsWith(".ico")) return "image/x-icon";
        return "application/octet-stream";
    }
}
