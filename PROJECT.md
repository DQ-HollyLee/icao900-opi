# ICAO 900 · OPI 口语练习

- 仓库：<https://github.com/DQ-HollyLee/icao900-opi>（公开，MIT）
- Release v1.0.0：<https://github.com/DQ-HollyLee/icao900-opi/releases/tag/v1.0.0>

在 900 句学习器基础上加 **OPI（PEPEC 口试面试）** 模块的测试版，与发行版 `com.icao.n900`
包名不同（`com.icao.opi`），可同机共存。

- 900 句部分：沿用 ASR 测试版（离线 Qwen3-ASR + 可选 AI 转写 + 组卷考试）
- **OPI 练习**：按 6 大类 / 69 话题的卡片练习（问题语音 / 文本 / 示例答案 / 翻译），
  录音回放，只有 **Pass**（计数）与 **收藏** 两个键，没有"已掌握/未掌握"
- **OPI 收藏夹**：按话题分类，入口在首页"已掌握 / 未掌握"下方，用分割区与 900 句隔开
- **模拟对话**：入口在「组卷」板块（属于口试考试），LLM 扮演考官，抽 3~4 个话题、≤15 问，
  逐题六维打分（2~5，语法不深究、其余照常），结束后给答题记录、文字总评与雷达图；录音只保留最近 5 次演练

---

## 1. 目录结构

```
icao900-opi-beta/
├─ app/
│  ├─ AndroidManifest.xml          com.icao.opi · 1.0.0 (8)
│  ├─ java/com/icao/opi/
│  │  ├─ MainActivity.java         WebView 外壳 + 虚拟域名资源分发 + 权限
│  │  ├─ TurnController.java       录音(AudioRecord→WAV，RMS 归一) + exam/opic 录音清理
│  │  ├─ LocalAsr.java             Qwen3-ASR 离线识别（模型下载 / 转写）
│  │  ├─ AiClient.java             OpenAI 兼容 /audio/transcriptions（可选）
│  │  └─ ChatClient.java           新增：OpenAI 兼容 /chat/completions（模拟对话）
│  ├─ res/                         图标、主题、字符串（应用名 ICAO900 OPI 测试）
│  └─ assets/
│     ├─ index.html                http 预览时额外加载 mock-bridge.js
│     ├─ css/app.css               900 句样式 + OPI/对话/雷达图样式
│     ├─ js/aviation.js            航空发音规则 + 评分引擎（900 句用）
│     ├─ js/app.js                 界面 / 状态 / 考试 / OPI 模块（单文件 IIFE）
│     ├─ data.json                 900 句
│     ├─ audio/0001.mp3 … 0900.mp3
│     ├─ opi.json                  OPI 题库（6 大类 / 69 话题 / 352 问）
│     └─ opi/611-01.mp3 …          352 条考官提问 TTS
├─ tools/
│  ├─ parse_opi.py                 PDF → opi_raw.md → 问答对（清洗音标/断行/中文注释）
│  ├─ opi_zh.py                    补齐缺失中文翻译
│  ├─ build_opi.py                 组装 opi.json + edge-tts 生成提问语音
│  └─ preview.py                   本地预览 / 截图（覆盖式同步 assets 与 preview）
├─ preview/                        只用于本地预览与自测，不进 APK
│  ├─ selftest.html                900 句回归（75 项）
│  ├─ opitest.html                 OPI 模块（41 项）
│  ├─ chattest.html                模拟对话全链路（25 项，配 mock-bridge.js）
│  ├─ mock-bridge.js               预览用假原生桥（http 才加载）
│  └─ shotview.html                按视图截图
├─ libs/lib/arm64-v8a/             13 个 native 库（llama.cpp / ggml / mtmd）
├─ dist/ICAO900-OPI.apk            217MB，debug 签名
└─ build.sh                        aapt2 → javac → d8 → 打包 dex+so → zipalign → apksigner
```

## 2. OPI 数据

来源：`2_opi最终打印口试版本—小郗运动了吗.pdf`，`tools/parse_opi.py` 解析。

| 字段 | 含义 |
|---|---|
| `groups[]` | 6 个大类：飞机与飞机系统 / 飞行环境 / 飞行程序 / 飞行相关人员 / 常用缩略词 / 其他话题 |
| `topics[]` | 69 个话题，`{id:"6.1.1", name:"飞机机型", group:"6.1", items[]}` |
| `items[]` | `{n:"611-01", q:"英文问题", cn:"中文翻译", a:"示例答案", au:"opi/611-01.mp3"}` |
| `count` | 352 |

解析时踩过的坑：PDF 里音标 `/.../`、中文注释、跨行断句混在问句里；问号断句不能跨句号；
连续追问要合并。现在 352 张卡片的 `q / cn / a / au` 四项都齐全（`opitest.html` 有断言）。

## 3. OPI 模块实现

### 3.1 首页入口

`renderHome()` 在"重点复习（已掌握 / 未掌握）"之后插入：

```
── OPI 口语部分 ──（中性细线分割，不另起配色）
OPI 口语练习
[OPI 话题目录]  [OPI 收藏夹]      ← 与上面的章节卡完全同款
```

两张卡**直接复用 `.ch-card` 结构**：蓝色小号编号（TOPICS / FAVORITES）、
右上角环形进度里放数字、深色名称、底部信息行。早期版本给 OPI 单独做了紫色
`OPI`/`★` 圆环 + 长英文编号，结果文案换行压到圆环上、卡片整体变灰，
与 900 句观感割裂——已改回同款样式。分割线也从中性色，不再用紫色胶囊。

**模拟对话入口在「组卷」页**（`renderExam`），用与等级卡同族的 `.lv-card` 白卡呈现，
因为它属于口试考试，不该跟首页的练习目录放一起。

### 3.2 话题目录 / 卡片

- 目录按 `groups` 分节，每节下是话题双列卡片（题数、Pass 数、收藏星标）
- 卡片复用 900 句的 `.flip` 3D 翻面与录音控件：
  - 正面：问题语音（`opi/xxx.mp3`）+ 波形
  - 背面：问题文本、中文翻译、示例答案（绿色块）、重听小喇叭
  - 下方：录音 + 回放（**「重听问题」键已移除**——卡片正面有播放提问、背面有小喇叭，
    二者已能重听 TTS，不再重复）；`Pass`（累计次数，存 `opi900.pass`）、`收藏`（存 `opi900.fav`）
- 录音走 `S.ctx='opi'`，复用 `startTurn/stopTurn/finalizeTurn`；练习不评分、不做识别
- **录音手动停止**：`setAutoStop` 对 OPI 练习与模拟对话均关闭（`manualStop = chatTurn || ctx==='opi'`），
  点麦克风开始、说完再点一次才结束；900 句练习与考试仍自动停。前版 OPI 练习误用了自动停，表现为"自己停下"
- **注意**：`playAudio()` 必须取 `ctxItem()` 而不是 `curItem()`。后者只查 `S.deck`（900 句），
  OPI 卡片下为 null，表现为"点了播放没声音"。已修，自测里直接 spy `Audio` 构造参数断言 URL 以 `opi/` 开头。

### 3.2.1 考官 TTS 语音
- 题库 352 问的提问语音用 edge-tts 预生成：`app/assets/opi/{n}.mp3`（女声 en-US-AriaNeural，语速 `+0%` 原速——用户确认 1.0 播放下原速刚好，不放慢）；
  另生成 `app/assets/opi_m/{n}.mp3`（男声 en-US-GuyNeural，同样原速）。
- 设置页新增「OPI 考官语音」选项（女声/男声），存 `S.settings.opiVoice`；播放时 `opiAu()` 把 `opi/` 切换为 `opi_m/`（只影响 OPI 音频，900 句的 `audio/` 不动）。
- 模拟对话里考官读题也走同一条音频（受 voice 设置影响）。生成脚本：`tools/gen_opi_tts.py`（女声沿用现有 `opi/` 不重生成、男声始终重新生成到 `opi_m/`）。
- 注：早期曾把女声用 `-15%` 慢速生成到 `opi_f/`，用户反馈 1.0 播放下原速刚好后废弃，`opi_f/` 已删除。

### 3.3 收藏夹

- 入口在首页 OPI 区第二张卡；列表按 **话题** 分类（不按时间、不混 900 句）
- 每个话题显示收藏数量，点进去的卡片序列只含已收藏的那几张
- 收藏状态与 900 句的"已掌握/未掌握"完全独立（不同 localStorage 键）

### 3.4 模拟对话

**抽题（本地完成，不交给模型）**：打乱 69 个话题取 3~4 个，每个话题内打乱取若干问，
均分并截断到 ≤15 问。这样题目一定来自题库、覆盖面可控，模型只负责提问措辞与评分。

**流程**：

```
开始演练 → 考官展示第 1 问（文字 + TTS 小喇叭）→ 用户点麦克风开始
        → 用户说完**再点一次麦克风**才结束（不会自动停）
        → 转写（本地 Qwen3-ASR 优先，其次 AI 转写）
        → ChatClient 请求六维评分（JSON，语法宽松、其余标准）→ 气泡展示六维分数 + 一句简评
        → 下一问 …… 全部答完 → 请求总评 → 报告页
```

**录音手动结束**：`TurnController.setAutoStop(false)` 关掉"静音 1.2s / 20s 自动停"，
只保留 5 分钟安全上限。口试回答里长考、停顿、重复组织语言都很正常，自动收会把回答腰斩；
现在第一次点开始、第二次点才 `stopTurn()` 触发转写评分。900 句练习/组卷考试仍用自动停
（`startTurn` 每次都会重设 `autoStop`）。

**评分口径（用户定调：语法不深究，其余照常）**：
- 只有 **结构 struct（语法/句型/时态）** 宽松——提示词写明"只要句子能达意、不影响理解就给 4 分，
  只有结构混乱到难以理解才降至 3"；前端兜底在此维度强制 ≥4（回答 ≥5 词且 `comp>=3` 时）。
- **发音 / 词汇 / 流畅 / 理解 / 应对** 五维恢复标准 ICAO 评分、有区分度：
  一般 3、较好 4、明显优秀才 5、答非所问或无法完成交际给 2。前端不做任何强制抬升。
- `comment` 仍是 30 字内一句简评。

**确定性校正**（防模型不听话，仅作用于结构）：解析完分数后，若回答 ≥5 词且模型给的 `comp >= 3`，
把 `struct` 抬到至少 4；其他维度完全保留模型评分。模型判"答非所问/几乎没说"时尊重低分。

**总评提示词**（`CHAT_FINAL_SYS`）：给每问的回答与分数，要求 150~250 字专业、直接、具体的中文总评：
ICAO 等级判断、六维优缺点、两三条最值得练的建议；注明语法维度不作主要短板、不因小错过度苛责。

**报告页**：六维平均分 + 纯 SVG 雷达图（`radarSvg`，2~5 分四层刻度，含各维度数值标签）
+ 总评 + 逐题答题记录（问题 / 翻译 / 我的回答 / 六维网格）。
**评级显示（用户要求：结束不能只给合格/不合格）**：报告页头部与历史列表每条都按均分映射并显示**具体 ICAO 等级**
（`chatIcaoText`/`chatIcaoLevel`，取整，等级名用民航局译法：3.6→ICAO 3 次工作级、4.2→ICAO 4 工作级、4.5+→ICAO 5 扩展级），
不再用模糊的"优秀/良好/合格"。

**保留策略**：

- 录音命名 `opic_{会话id}_{题号}.wav`，只保留最近 5 次演练
  （`TurnController.pruneChatAudio(最近5个id)`，交卷时调用）
- 历史记录存 `opi900.chats`（最多 20 条），超出 5 次的录音按钮自动隐藏；
  总评与雷达图始终保留，可随时回看

**依赖**：设置页「模拟对话模型」三项（接口地址 / 模型 / API Key，任意 OpenAI 兼容服务），
以及一种语音识别（本地模型或 AI 转写）。两项齐了「开始演练」才可点。
设置里的「AI 语音转写（识别兜底）」开关（原误称"AI 识别评分"）只是把语音转成文字交给考官判分的**兜底通道**，
不是考试评分接口——发行版删掉的线上评分与此无关，本开关不参与任何评分计算。

## 4. 与发行版的差异

| 功能 | 发行版 2.0.0 | 本应用 1.0.0 |
|---|---|---|
| 900 句练习 / 考试 / 记录 | ✅ | ✅ |
| 语音识别 | 仅本地 Qwen3-ASR | 本地 ASR + 系统识别 + AI 转写（保留测试开关） |
| OPI 练习 / 收藏夹 | ❌ | ✅ |
| 模拟对话（LLM 考官 + 雷达图） | ❌ | ✅ |
| 包名 | `com.icao.n900` | `com.icao.opi` |

## 5. 构建与自测

```bash
bash build.sh                       # → dist/ICAO900-OPI.apk（约 217MB）
python tools/preview.py             # http://127.0.0.1:8765
# 三套前端自测（headless Chrome 打开对应页面读取结果）
#   selftest.html  75 项（900 句回归）
#   opitest.html   41 项（OPI 数据 / 目录 / 卡片 + TTS URL / Pass / 收藏 / 收藏夹 / 卡片同款 / 组卷入口 / 报告）
#   chattest.html  25 项（模拟对话全链路 + 手动点两次 + 结构兜底，依赖 mock-bridge.js）
```

`preview.py` 采用**覆盖式同步**（不做 `rmtree`）：本机安全钩子会拦批量删除，
而且 `shutil.copytree(dirs_exist_ok=True)` 已经能保证拿到最新前端文件。

## 6. 已知限制 / 待办

- [ ] 未在真机验证：OPI 录音链路与 ChatClient 的真实服务商联调（预览用 mock 桥验证了请求/回包结构）
- [ ] 示例答案来自 PDF 原文，个别大小写不规范（如 `sr20`），如需可加清洗规则
- [ ] 雷达图目前是"六维平均"，可扩展到每题的六维趋势
- [ ] 模拟对话的追问（follow-up）目前不含模型自主追问，严格按抽好的题目走
- [ ] 话题内题目顺序随机，未做"同一话题连续提问"的语境铺垫

## 7. WebView 壳生命周期（息屏/切屏白屏修复）

用户真机反馈：切屏、息屏后回来**有几率整页白屏**，返回上一页再重进（JS 重新渲染）才恢复。
根因与修法（0.2.4-beta 起修复，1.0.0 起转正）：

- **不再调用 `web.onPause()`**：它会让 WebView 停止绘制，部分机型息屏时渲染面（surface）
  在"已暂停"状态下被销毁，回来后 `web.onResume()` 补不回最后一帧 → 白屏。
  屏灭时系统本来就不给 WebView 送帧，`onPause` 里只需 `turn.hardStop()` 停录音。
- **`onResume` 强制重挂**：`requestLayout() + invalidate()`，再 post 一个
  `INVISIBLE→VISIBLE` 可见性切换逼出新帧（同帧内完成，无闪烁），防御个别 ROM 不补画。
- **JS 侧 `visibilitychange` 兜底**：变可见时把 `body.opacity` 抖到 0.999 再还原
  （80ms），用合成层变化强制出帧。opacity 不产生 containing block，比 transform 安全。
- 已知边界：若系统内存压力下把渲染进程整个杀了，`onRenderProcessGone` 未处理（需重建
  WebView，暂未做）；表现为白屏且点页面内按钮无反应，只能重开 App。

## 8. 开源（1.0.0 转正）

- 去掉全部"中飞 ICAO 帮手"音频署名（该音频并非其出品，与其无关），设置页底部只留"数据保存在本机"。
- beta → 正式版：`1.0.0 (8)`，应用名 `ICAO900 OPI`，页面标题 `ICAO 900句 · OPI`，APK 名 `ICAO900-OPI.apk`。
- 协议 **MIT**（可自由修改/商用，但须保留版权声明），版权人 `DQ-HollyLee`，见 `LICENSE`。
- `README.md` 含功能、截图（`docs/screenshots/`）、构建方法、素材来源与免责声明。
- `.gitignore` 排除 `.cache/`（SDK 工具链、调试 keystore、解析中间产物）、`.build/`、`dist/`（APK 走 Release）。
- `build.sh` 的 SDK 路径可用环境变量 `ICAO_SDK_CACHE` 覆盖，便于他人构建。
- 仓库体积约 365MB（音频 173MB + native 库 192MB），最大单文件 86MB（libllama-common.so），未超 GitHub 100MB 硬限。
