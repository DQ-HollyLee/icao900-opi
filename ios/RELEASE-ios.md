## ICAO 900 · OPI — iOS / iPadOS beta

与 Android 版同一套网页前端，iOS 侧用 WKWebView + 原生 Swift 桥重写实现：

- **录音**：AVAudioEngine 采集 16k/单声道，与 Android 相同的静音检测、自动停止、响度归一（80Hz 高通 + RMS 归一 + 软限幅）
- **语音识别**：SFSpeechRecognizer（en-US），与录音共用同一音频引擎、并行识别
- **AI 转写 / 模拟对话**：URLSession 移植，支持任意 OpenAI 兼容接口
- **不包含** Android 版的本地 llama 模型（Qwen3-ASR）：iOS 上自动降级为「系统识别 / AI 云端转写」
- 考官 TTS 女声/男声、900 句练习、OPI 练习、模拟对话六维评分 + ICAO 等级全部可用

### 安装（自签名，无需 App Store）

ipa 是 **ad-hoc 签名**，用你手上的工具重新签名后安装即可：

| 工具 | 平台 | 说明 |
|---|---|---|
| **Sideloadly** | Windows / macOS | 拖入 ipa，填自己的 Apple ID，免费账号 7 天一签 |
| **AltStore / SideStore** | Windows / macOS | 需要 AltServer，可自动续签 |
| **TrollStore** | 设备 | 支持的系统版本可直接装（无需签名） |
| **证书签名工具**（如轻松签等） | 设备 | 有企业/个人证书时使用 |

免费 Apple ID 的注意事项：
- 应用有效期 7 天，到期需重新签名（AltStore 可自动续）
- 免费账号同时最多 3 个自签应用、10 个 App ID
- 首次启动请允许「麦克风」和「语音识别」权限，否则录音评分不可用

### 与 Android 版的差异

- 包名 `com.icao.opi.ios`，可与 Android 版同时存在（不同设备）
- 不支持本地离线大模型识别；模拟对话需要配置对话模型接口，语音识别建议先在设置里配好 AI 转写（云端）以获得更准的评分
- 数据（练习记录、成绩、录音）保存在系统沙盒内，卸载即清除
