package com.icao.opi;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/**
 * AI 语音转写：调用 OpenAI 兼容的 /audio/transcriptions 接口。
 *
 * 独立成一个类（不依赖 Android API），既方便在桌面上用本地 mock 服务验证
 * multipart 拼装是否正确，也避免 TurnController 里混入太多网络细节。
 */
final class AiClient {

    private AiClient() {}

    static String transcribe(File wav, String baseUrl, String model, String key) throws Exception {
        String base = baseUrl.trim();
        while (base.endsWith("/")) base = base.substring(0, base.length() - 1);
        String endpoint = base.endsWith("/audio/transcriptions")
                ? base : base + "/audio/transcriptions";
        String boundary = "----ICAO900" + System.currentTimeMillis();

        // 先把 multipart 体拼好，用固定长度发送：不少服务端不接受 chunked 上传
        ByteArrayOutputStream body = new ByteArrayOutputStream(1024 * 1024);
        field(body, boundary, "model", model);
        field(body, boundary, "language", "en");
        // 给识别模型一点领域提示：民航无线电通话里的固定说法
        field(body, boundary, "prompt",
                "Aviation radiotelephony. Flight levels, headings, frequencies, QNH, "
                        + "runway numbers, ICAO alphabet, standard phraseology.");
        body.write(("--" + boundary + "\r\n"
                + "Content-Disposition: form-data; name=\"file\"; filename=\"clip.wav\"\r\n"
                + "Content-Type: audio/wav\r\n\r\n").getBytes(StandardCharsets.UTF_8));
        try (FileInputStream in = new FileInputStream(wav)) {
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) body.write(buf, 0, n);
        }
        body.write(("\r\n--" + boundary + "--\r\n").getBytes(StandardCharsets.UTF_8));
        byte[] payload = body.toByteArray();

        HttpURLConnection c = (HttpURLConnection) new URL(endpoint).openConnection();
        c.setRequestMethod("POST");
        c.setDoOutput(true);
        c.setConnectTimeout(15000);
        c.setReadTimeout(90000);
        c.setRequestProperty("Authorization", "Bearer " + key);
        c.setRequestProperty("Content-Type", "multipart/form-data; boundary=" + boundary);
        c.setFixedLengthStreamingMode(payload.length);
        try (OutputStream os = c.getOutputStream()) {
            os.write(payload);
        }

        int code = c.getResponseCode();
        InputStream res = code >= 200 && code < 300 ? c.getInputStream() : c.getErrorStream();
        StringBuilder sb = new StringBuilder();
        if (res != null) {
            try (BufferedReader r = new BufferedReader(
                    new InputStreamReader(res, StandardCharsets.UTF_8))) {
                String line;
                while ((line = r.readLine()) != null) {
                    /* 响应体不设上限的话，接口返回异常大内容会把内存吃光 */
                    if (sb.length() + line.length() > 1024 * 1024) {
                        throw new Exception("接口返回内容过长（超过 1MB）");
                    }
                    sb.append(line);
                }
            }
        }
        String respBody = sb.toString();
        if (code < 200 || code >= 300) {
            String hint = respBody.length() > 160 ? respBody.substring(0, 160) : respBody;
            throw new Exception("HTTP " + code + (hint.isEmpty() ? "" : " " + hint));
        }
        JSONObject j = new JSONObject(respBody);
        String text = j.optString("text", "");
        if (text.isEmpty()) {
            // 少数兼容接口把结果包在 data 里
            JSONObject d = j.optJSONObject("data");
            if (d != null) text = d.optString("text", "");
        }
        if (text.isEmpty()) throw new Exception("接口没有返回文本");
        return text.trim();
    }

    private static void field(OutputStream os, String boundary, String name, String value)
            throws Exception {
        os.write(("--" + boundary + "\r\n"
                + "Content-Disposition: form-data; name=\"" + name + "\"\r\n\r\n"
                + value + "\r\n").getBytes(StandardCharsets.UTF_8));
    }
}
