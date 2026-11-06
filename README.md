# ICAO 900 · OPI 口语练习

面向民航飞行员 / 空管的**离线优先**英语学习应用：900 句跟读练习 + PEPEC OPI 口语面试演练 + AI 考官模拟对话。

> **平台**：Android（`app/` + `build.sh`，侧载 APK）· iOS / iPadOS（`ios/`，自签名 ipa，见 [iOS 版](#ios--ipados-版)）

<p>
  <img src="docs/screenshots/01_home.png" width="200" alt="首页">
  <img src="docs/screenshots/02_opi_card.png" width="200" alt="OPI 卡片">
  <img src="docs/screenshots/03_chat_report.png" width="200" alt="演练报告">
  <img src="docs/screenshots/04_settings.png" width="200" alt="设置">
</p>

## 功能

**900 句练习**
- 按 ICAO 发音规则逐词评分（数字逐位读、连字符、缩写、runners/niner 同化等）
- 3D 翻面卡片：正面语音 + 波形，背面英文 / 中文 / 发音要点
- 已掌握 / 未掌握标记、章节进度记忆、组卷考试（3 级组 / 4 级组，录音存档 + 人工改判）

**OPI 口语面试（PEPEC）**
- 6 大类 / 69 话题 / 352 问，卡片式练习，考官提问语音（女声 / 男声可切换）
- Pass 计数与收藏夹（独立于 900 句进度）
- **模拟对话**：AI 扮演考官，随机抽 3~4 个话题、≤15 问，逐题六维评分（发音 / 结构 / 词汇 / 流畅 / 理解 / 应对）
- 结束给出**具体 ICAO 等级**（如 ICAO 3 次工作级、ICAO 4 工作级）、六维雷达图、文字总评与逐题记录

**语音识别（两种通道）**
- 本地 **Qwen3-ASR-0.6B**（llama.cpp 推理，完全离线，首次使用在应用内下载约 1 GB 模型）
- 可选 OpenAI 兼容的云端转写接口作为兜底（Key 只存本机）
- 模拟对话需要一种识别通道 + 一个 OpenAI 兼容对话模型（用于提问与评分）

**外观**
- 夜间模式：**纯黑背景 + 白色文字**，可跟随系统，也可固定浅色 / 夜间；切换时整页颜色渐变过渡
- 系统栏（状态栏 / 导航栏）与页面底色同步换色，夜间不留白边

## 下载安装

**Android**：到 [Releases](../../releases) 下载最新 `ICAO900-OPI.apk`：
- Android 7.0+（minSdk 24），仅 **arm64-v8a**
- 侧载安装，无需 root；本应用不联网也能完成 900 句练习，仅模拟对话 / 云端转写 / 模型下载需要网络

**iOS / iPadOS**：见下节。

## iOS / iPadOS 版

同一套网页前端，iOS 侧用 **WKWebView + 原生 Swift 桥**重写（录音 = AVAudioEngine，识别 = SFSpeechRecognizer，
网络 = URLSession），不经过 App Store，**自签名安装**。

```bash
# 需要 macOS + Xcode 命令行工具；本机没有 Mac 时由 GitHub Actions 的 macOS runner 构建
bash ios/build_ios.sh          # → ios/dist/ICAO900-OPI-ios-<版本>.ipa
```

也可在仓库 **Actions → iOS beta build → Run workflow** 手动触发云端构建，从 Artifacts 下载 ipa。

安装（任选其一，都是用自己的 Apple ID 重签）：

| 工具 | 平台 | 说明 |
|---|---|---|
| **Sideloadly** | Windows / macOS | 拖入 ipa + 自己的 Apple ID，免费账号 7 天一签 |
| **AltStore / SideStore** | Windows / macOS | 配 AltServer，可自动续签 |
| **TrollStore** | 设备 | 支持的系统版本可直接安装 |
| 证书签名工具 | 设备 | 有企业 / 个人证书时使用 |

- 免费 Apple ID：7 天有效期、最多 3 个自签应用；首次启动需允许「麦克风」「语音识别」
- **不含** Android 版的本地 llama 模型（Qwen3-ASR）：iOS 上自动降级为「系统识别 / AI 云端转写」，
  建议在设置里配好 AI 转写接口以获得更准的评分
- 其余功能（900 句、OPI 卡片、考官双嗓音 TTS、模拟对话六维评分 + ICAO 等级）与 Android 版一致

## 从源码构建

无 Gradle，`build.sh` 手写调用 SDK 工具链（aapt2 → javac → d8 → 打包 dex + so → zipalign → apksigner）。

依赖：
- JDK 17（`javac` / `jar` / `java`）
- Android SDK build-tools（`aapt2`、`d8.jar`、`zipalign`、`apksigner.jar`）与 `android.jar`（API 34）
- Python 3（仅打包步骤里合并 dex 与 native 库时用到）

```bash
# 指向你自己的 SDK 缓存目录（需包含 sdk_bt / sdk_jdk / sdk_plat 三个子目录）
export ICAO_SDK_CACHE=/path/to/sdk-cache
bash build.sh
# 产物：dist/ICAO900-OPI.apk
```

> 若没有现成的 `ICAO_SDK_CACHE` 结构，可直接改 `build.sh` 顶部的 `JDK` / `BT` / `PLATFORM` 三行指向本机 SDK 路径。

## 项目结构

```
app/
  assets/            前端（HTML/CSS/JS 单页应用）+ 900 句数据与音频 + OPI 题库与 TTS
  java/com/icao/opi/ MainActivity（WebView 外壳）、TurnController（录音）、
                     LocalAsr（离线识别）、AiClient（云端转写）、ChatClient（对话模型）
  res/               图标与主题
libs/                llama.cpp / ggml / mtmd 的 arm64-v8a 预编译库
ios/                 iOS/iPadOS 壳：main.swift（WKWebView + 原生桥）、Info.plist、图标、build_ios.sh
.github/workflows/   CI：ios.yml 在 macOS runner 上构建 ipa
tools/               PDF 题库解析、中文翻译补全、OPI 组装与 TTS 生成、本地预览与自测
preview/            前端自测页（selftest / opitest / chattest）与截图页，不进 APK
build.sh            构建脚本
```

## 数据与素材说明

- **900 句题库与真人录音**：整理自公开的民航英语学习资料（内容源自 ICAO Doc 9835 附件常用语句），本项目仅做整理与离线打包。
- **OPI 题库**：由 `tools/parse_opi.py` 从网络公开流传的 PEPEC OPI 面试资料整理为结构化 JSON，并补全中文翻译。
- **考官提问语音**：由本项目用 Microsoft edge-tts 自行合成（`en-US-AriaNeural` 女声 / `en-US-GuyNeural` 男声），非任何第三方音频。
- **本地识别模型**：Qwen3-ASR-0.6B（通义千问开源，Apache-2.0），以 llama.cpp 在设备端推理。

## 免责声明

本项目为个人学习交流用途，**非官方、非商业化**，与 ICAO、CAAC 及任何培训机构无关。
题库与音频资料的版权归各自权利人所有，本项目仅为学习目的整理；如有侵权，请联系删除。
考试评级与评分仅为练习参考，不代表任何官方成绩。

## License

[MIT](LICENSE) © 2026 DQ-HollyLee
