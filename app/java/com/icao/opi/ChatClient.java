package com.icao.opi;

import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/**
 * 模拟对话的对话模型客户端：OpenAI 兼容的 /chat/completions 接口。
 *
 * 前端把整段 messages（JSON 数组，含 system / user / assistant 历史）发过来，
 * 这里在后台线程 POST 出去，结果走 Host.onChat({ok, text, msg, tag}) 回前端。
 * tag 用来区分是"评分请求"还是"总评请求"，防止慢网络下串台。
 */
public class ChatClient {

    private final WebView web;
    private final android.os.Handler ui = new android.os.Handler(android.os.Looper.getMainLooper());
    private volatile boolean busy = false;

    ChatClient(WebView web) {
        this.web = web;
    }

    /** 是否有请求在途：同一时间只允许一个对话请求，前端据此禁用按钮 */
    @JavascriptInterface
    public boolean isBusy() {
        return busy;
    }

    /**
     * 发起一次对话请求。
     *
     * @param messagesJson JSON 数组字符串，元素 {role, content}
     * @param base         接口地址（到 /v1 为止）
     * @param model        模型名
     * @param key          API Key
     * @param temperature  采样温度（0~2），传 0 用默认
     * @param tag          回传标记（前端用来区分用途）
     */
    @JavascriptInterface
    public void chat(final String messagesJson, final String base, final String model,
                     final String key, final double temperature, final String tag) {
        if (busy) {
            emit(false, "", "上一个请求还没返回，请稍等", tag);
            return;
        }
        if (key == null || key.trim().isEmpty()) {
            emit(false, "", "还没有配置对话模型的 API Key", tag);
            return;
        }
        if (base == null || base.trim().isEmpty() || model == null || model.trim().isEmpty()) {
            emit(false, "", "对话模型的接口地址或模型名没有填", tag);
            return;
        }
        busy = true;
        new Thread(() -> {
            try {
                String text = complete(messagesJson, base.trim(), model.trim(), key.trim(), temperature);
                ui.post(() -> { busy = false; emit(true, text, "", tag); });
            } catch (Throwable t) {
                final String m = t.getMessage() == null ? "网络错误" : t.getMessage();
                ui.post(() -> { busy = false; emit(false, "", "对话模型请求失败：" + m, tag); });
            }
        }, "opi-chat").start();
    }

    /** 真正的 HTTP 调用（后台线程）。独立成静态方法便于桌面 mock 验证。 */
    static String complete(String messagesJson, String baseUrl, String model, String key,
                           double temperature) throws Exception {
        JSONArray msgs;
        try {
            msgs = new JSONArray(messagesJson);
        } catch (Exception e) {
            throw new Exception("对话内容格式错误");
        }
        if (msgs.length() == 0) throw new Exception("对话内容为空");

        JSONObject payload = new JSONObject();
        payload.put("model", model);
        payload.put("messages", msgs);
        payload.put("temperature", temperature > 0 ? temperature : 0.4);
        payload.put("stream", false);
        byte[] body = payload.toString().getBytes(StandardCharsets.UTF_8);

        String base = baseUrl;
        while (base.endsWith("/")) base = base.substring(0, base.length() - 1);
        // 允许用户把完整 endpoint 直接填进来
        String endpoint = base.endsWith("/chat/completions")
                ? base : base + "/chat/completions";

        HttpURLConnection c = (HttpURLConnection) new URL(endpoint).openConnection();
        c.setRequestMethod("POST");
        c.setDoOutput(true);
        c.setConnectTimeout(20000);
        c.setReadTimeout(120000);
        c.setRequestProperty("Authorization", "Bearer " + key);
        c.setRequestProperty("Content-Type", "application/json; charset=utf-8");
        c.setFixedLengthStreamingMode(body.length);
        try (OutputStream os = c.getOutputStream()) {
            os.write(body);
        }

        int code = c.getResponseCode();
        InputStream res = code >= 200 && code < 300 ? c.getInputStream() : c.getErrorStream();
        String respBody = readAll(res);
        if (code < 200 || code >= 300) {
            String hint = respBody.length() > 200 ? respBody.substring(0, 200) : respBody;
            throw new Exception("HTTP " + code + (hint.isEmpty() ? "" : " " + hint));
        }
        JSONObject j = new JSONObject(respBody);
        JSONObject ch = j.optJSONObject("choices");
        // 少数兼容接口包在 data 里
        if (ch == null) {
            JSONObject d = j.optJSONObject("data");
            if (d != null) ch = d.optJSONObject("choices");
        }
        if (ch != null) {
            // choices 可能是对象（OpenAI 兼容主流）或数组
            if (ch.has("message")) {
                JSONObject m = ch.getJSONObject("message");
                String t = m.optString("content", "");
                if (!t.isEmpty()) return t.trim();
            }
        }
        JSONArray arr = j.optJSONArray("choices");
        if (arr == null) arr = (j.optJSONObject("data") != null)
                ? j.optJSONObject("data").optJSONArray("choices") : null;
        if (arr != null && arr.length() > 0) {
            JSONObject m = arr.getJSONObject(0).optJSONObject("message");
            if (m != null) {
                String t = m.optString("content", "");
                if (!t.isEmpty()) return t.trim();
            }
        }
        throw new Exception("接口没有返回回复内容");
    }

    private static String readAll(InputStream res) throws Exception {
        if (res == null) return "";
        StringBuilder sb = new StringBuilder();
        try (BufferedReader r = new BufferedReader(
                new InputStreamReader(res, StandardCharsets.UTF_8))) {
            String line;
            while ((line = r.readLine()) != null) {
                if (sb.length() + line.length() > 1024 * 1024) {
                    throw new Exception("接口返回内容过长（超过 1MB）");
                }
                sb.append(line);
            }
        }
        return sb.toString();
    }

    private void emit(boolean ok, String text, String msg, String tag) {
        JSONObject o = new JSONObject();
        try {
            o.put("ok", ok);
            o.put("text", text == null ? "" : text);
            o.put("msg", msg == null ? "" : msg);
            o.put("tag", tag == null ? "" : tag);
        } catch (Exception ignore) {}
        try {
            web.evaluateJavascript("Host.onChat&&Host.onChat(" + o + ")", null);
        } catch (Throwable ignore) {}
    }

    void release() {
        busy = false;
    }
}
