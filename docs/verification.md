# 验收矩阵与安装冒烟（#8）

> 本文记录**可重复执行**的验收矩阵、本机实际结果、环境约束与未覆盖项。
> 一条命令：\`npm run verify\`（内部串行执行 5 组检查，任一失败整体退出码非 0）。
> 真实设备链路另由 env-gated 脚本 scripts/verify/verify-emulator.mjs 覆盖（DSH_PHONE_E2E=1 才跑；默认 SKIP 不碰设备）。
> 未测项一律显式 SKIP 并写明原因，**不允许假绿**；"人工待办"不是已通过。
>
> **v0.4.2（2026-11-10）发布状态**：**#72 安全与生命周期修复**（`phone_key` 注入防护 / 截图真断连
> 502 `E_DEVICE_DISCONNECTED` / booting 断连不假 running / boot 超时先 `cancelBoot` 清理再抛错且预算
> 240s / control 会话 single-flight；PR #116）；**#112 DSH 0.2.2-rc.1 适配**（依赖升级 + 校准 + 文档；
> PR #115）；**#113 仓库卫生**（新组织 URL / 构建期 tag 自动发布 Release asset；PR #114）；
> **#40 真实 emulator 自启（B 分支）首次实测 PASS**（§7.7：插件 owned 启动 → `POST /runtime stop`
> 后 2.0s stopped、pid 退出、adbd 端口关闭、无残留进程；A attach 复核 PASS）。
> 本机 `node --test`：**496 例 / 490 pass / 6 skipped / 0 fail**，`npm run check` 通过
> （182 文件 ≤1000，最大单文件 937 行）；未覆盖项见 §4/§5 与各节 SKIP。
>
> **v0.4.1（2026-10-27）发布状态**：#99 空白桌面应用抽屉（`DrawerActivity`：上滑 / 4 列网格 /
> 搜索 / adb 固定命令）、#100 Host 动作 API（`POST /dsh-phone/api/action {action:'app-drawer'}`；
> 409 `E_APP_DRAWER_UNAVAILABLE` / `E_LIFECYCLE_BUSY`）、#101 面板「应用」按钮（含 409 专属文案与 busy 防重复）。
> 抽屉实测见 **§10**（空白首页 / 上滑打开 / adb 固定命令 / 从抽屉启动「设置」/ 返回 HOME 仍空白，均 PASS）；
> 客户端按钮人工核对清单见 [client.md](client.md) §4.6。
>
> **v0.4.0（2026-10-27）发布状态**：#83 生命周期控制三端已合并（API #84 / UI #85 / runtime #86 /
> 收口修复 #90），单测覆盖 2s 看门狗、owned/adopted 所有权语义、restart 序列、并发动作与 dispose 5s 预算
> （§9.2）；#87 肥鱼手机定制已在真实 emulator 实机验证 **1080x2400 / zh-CN / 空白首页 / 壁纸 111-222 轮换 /
> YouTube 已卸载**（§9.1）；#92 客户端生命周期验收 11 例单测（[client.md](client.md) §4.5）。
> 本机 `node --test`（2026-11-10，rebase 到 5eaa2f2 后复跑）：**496 例 / 490 pass / 6 skipped / 0 fail**；`npm run check` 通过（当前最大单文件 937 行 < 1000）。
>
> **v0.3.0（2026-10-26）发布状态**：#67 emulator 启动专项实测**温启动 ~15s / 暂停恢复 ~19s**
> （冷启动 33–95s 有客观下限，`aosp_atd` 未实测；完整数据与方法见 §8）；#73 视频流 viewer 心跳/
> 引用计数代际/WS 背压/双页 4001 已修复并有单测（§2）。#40 真实环境验收**部分完成**——#58 已实测
> 真实 emulator attach 全链路 **PASS**（§2 行 10–12 与 §7）；剩余 SKIP/人工待办：emulator 自启（B 分支，
> 需停用用户 live 实例）、真实浏览器渲染/WebCodecs/TinyH264、redroid（本机无 Docker）。#56 的 cpu/mem 采样与
> booting `phase` 仍为单测/假环境验证。
>
> **#40 真实环境验收复核（2026-11-10）**：真实 emulator **A 分支（attach 复用已运行实例）**与
> **B 分支（插件自启 owned 实例）**全链路均 **PASS**——截图 1080x2400、Host WS ready + DPH1、
> key/touch/中文 INJECT_TEXT 控制无 error、断开 6.5s 后仍 running、二次连接重建；B 分支另验证
> owned/adopted/pid 与 `POST /runtime stop` 后**进程退出 + 端口关闭 + 无残留进程**。证据见 §7.3–§7.6；
> rebase 到 origin/main 5eaa2f2（#72/#112/#113 已合入）后已复跑 A/B 真实链路与自检（§7.7）。
> 仍未覆盖：真实浏览器渲染/WebCodecs/TinyH264、审批 UI 点击、redroid（本机无 Docker）、Windows/macOS。
> 期间发现「断开后 <2.5s 立即重连」与 scrcpy-server 退出清理删 jar 的瞬态竞态（§7.5），
> harness 已加冷却 + 重试并如实记录。

## 1. 一条命令跑什么

\`\`\`
npm run verify
├── scripts/verify/verify-tools.mjs      假 ctx 加载 apply：9 个 phone_* 工具 / 参数 / phone_shell ask
├── scripts/verify/verify-stream.mjs     createStreamUpgradeRoute + 假 socket：握手 / DPH1 / 5s 宽限 / 断开清理
├── scripts/verify/verify-install.mjs    临时 profile 安装冒烟（dump-config / dump-config-schema / --help / 隔离 web apply）
├── scripts/verify/verify-emulator.mjs   真实 emulator attach/自启链路（DSH_PHONE_E2E=1 + DSH_PHONE_E2E_MODE 才跑；默认 SKIP）
├── scripts/check-file-lines.mjs         单文件 ≤1000 行硬线
└── node --test tests/e2e/*.test.mjs     无真机/容器/浏览器场景显式 SKIP（带原因）
\`\`\`

实现约束：

- 每个脚本可单独运行（\`node scripts/verify/verify-install.mjs\` 等），失败退出码非 0；
- \`verify-install\` 在干净 checkout 首次运行、\`node_modules/\` 缺失时自动 \`npm install --no-audit --no-fund\`，随后总是 \`npm run build\`（\`lib/\` 不入库，必须先构建）；
- 临时 profile 名固定为 \`phone-verify\`（\`$DSH_HOME/profiles/phone-verify\`，默认 \`~/.dsh\`），**不触碰 \`web\` / \`headless\` profile**；进程被 SIGINT/SIGTERM 打断时也会执行清理；
- 阶段 B 使用 \`mkdtemp\` 隔离的临时 \`DSH_HOME\` 启动 web（\`--no-open --port 0\`），不会占用/复用用户 3080 实例；结束删除临时 home 与进程；
- 所有清理经 LIFO \`Cleanup\` 登记，失败只告警不掩盖主失败。

## 2. 本机验收结果（2026-10-25 基线；2026-11-10 #40 复核更新第 10–17 行）

环境（2026-10-25 基线）：Debian 13 / Node v24.21.0 / npm 11.19.0 / pnpm 12.11.2 / dsh 0.2.1-rc.2。
环境（2026-11-10 #40 复核）：Debian 13 / Node v24.21.0 / dsh 0.2.2-rc.1（本机当前）/ Android emulator 37.2.12。
环境（2026-11-10 rebase 后复跑）：origin/main 5eaa2f2（#72/#112/#113 已合入，devDeps 升级 DSH 0.2.2-rc.1），真实链路与自检均在最终代码上重跑（§7.7）。

| # | 验收项 | 命令 | 本机结果 | 环境约束 | 未覆盖 / 备注 |
|---|---|---|---|---|---|
| 1 | 类型检查 | \`npm run typecheck\` | PASS | 无 | — |
| 2 | 单元测试（runtime/adb/host/tools/stream/client） | \`npm test\` | PASS（2026-11-10 rebase 后：**496 例 / 490 pass / 6 skip / 0 fail**） | 无 | 不依赖真机；\`npm run check\` 同跑 |
| 3 | 单文件 ≤1000 行 | \`node scripts/check-file-lines.mjs\` | PASS（182 个文件） | 无 | 目标 ≤300 行/文件由 review 把关 |
| 4 | 构建 | \`npm run build\` | PASS（host=65 file(s), client=bundled） | 需要 \`node_modules\` | \`lib/\` 不提交 |
| 5 | 工具注册（apply） | \`node scripts/verify/verify-tools.mjs\` | PASS | 无 | 9 个工具名/顺序/参数/描述、phone_shell ask/白名单、enabled=false |
| 6 | WS 协议 | \`node scripts/verify/verify-stream.mjs\` | PASS | 假 socket | 101 握手、DPH1、visibility 5s 宽限、断开清理、鉴权 403 |
| 7 | 安装冒烟（profile + dump） | \`node scripts/verify/verify-install.mjs\` | PASS | 本机 dsh + pnpm | 见 §3 证据 |
| 8 | 安装冒烟（web apply） | 同上（阶段 B） | PASS | 临时隔离 \`DSH_HOME\` | 起 web 进程，验证 401/200 与 config 生效 |
| 9 | redroid 真实运行时 | e2e | SKIP | 需 Docker + binder | 本机无 Docker |
| 10 | emulator attach（复用已运行实例，A 分支） | \`DSH_PHONE_E2E=1 node scripts/verify/verify-emulator.mjs\` | **PASS**（2026-11-10 复核：截图 + Host WS ready/DPH1 + 控制 + 释放） | 需 127.0.0.1:5555 有 adbd | 见 §7.3；两次独立运行均通过 |
| 11 | scrcpy 实连（stream 层直连对照） | 同上（脚本内直连 \`src/stream\`） | PASS（2026-11-10：push/start 227–648ms；12–18 帧/5s，keyframe 1，control ≤3ms） | 真实 emulator | Host WS 路径同样 PASS（19–53 帧/10s）；见 §7 |
| 12 | emulator 自启（B 分支，插件 owned 实例） | \`DSH_PHONE_E2E=1 DSH_PHONE_E2E_MODE=emulator node scripts/verify/verify-emulator.mjs\` | **PASS**（2026-11-10 首测：懒启动 + 截图/WS/控制/释放 + \`POST /runtime stop\` 后进程退出、端口关闭、无残留） | 需 5555 空闲（否则明确 SKIP，不 adopt 冒充自启） | 见 §7.4；从此前 SKIP 转为 PASS |
| 13 | 真实 attach（TCP adbd） | \`DSH_PHONE_E2E_ENDPOINT=127.0.0.1:5555 node --test tests/e2e/real-device.test.mjs\` | PASS（2026-11-10：ADB 直连 + getprop + screencap PNG，1.3s） | 127.0.0.1:5555 | 本机为 emulator adbd，非独立真机 |
| 14 | 真实浏览器页面 | 人工 | 人工待办 | 需浏览器/自动化 | 见 §5，不冒充通过 |
| 15 | env-gated e2e（node --test attach） | \`DSH_PHONE_E2E=1 node --test tests/e2e/real-emulator.test.mjs\` | PASS（2026-11-10：36.5s） | 需已运行实例 | 断言截图/runtime 所有权/Host WS/释放 |
| 16 | env-gated e2e（node --test B 分支） | \`DSH_PHONE_E2E=1 DSH_PHONE_E2E_MODE=emulator node --test tests/e2e/real-emulator.test.mjs\` | PASS（2026-11-10：46.4s） | 需 5555 空闲 | 断言 owned/adopted/stop 后 stopped + 端口关闭 |
| 17 | 断开后极短间隔重连 | — | 观察项（非 PASS 项） | — | 曾稳定复现 \`E_STREAM_START_FAILED\`；harness 冷却 + 重试，见 §7.5 |
| 18 | rebase 后真实链路复核（v0.4.2 基线 5eaa2f2，A + B） | 同第 10 / 12 行 | **PASS**（2026-11-10：A 36.1s / B 46.3s） | 含 #72/#112/#113 | 见 §7.7；SKIP 项不变 |

\`npm run verify\` 汇总输出（2026-11-10 实跑）：

\`\`\`
  PASS 工具注册与 phone_shell 审批（verify-tools）
  PASS WS 协议 / DPH1 / 5s 宽限（verify-stream）
  PASS 临时 profile 安装冒烟（verify-install）
  PASS 单文件行数（≤1000 硬线）
  PASS e2e 矩阵（无真机/容器/浏览器，全部带 skip 原因）
验收通过：5/5 项（skip 项见上方 e2e 输出与 docs/verification.md）
\`\`\`

e2e 输出 6 个用例全部 SKIP（未设 \`DSH_PHONE_E2E\` / \`DSH_PHONE_E2E_ENDPOINT\`，且本机按 CONTRIBUTING §4
已删除临时下载的 scrcpy-server jar），skip 原因逐条打印（原文，节选）：

\`\`\`
﹣ 真实运行时：redroid（Docker + binder） # 本机无 Docker（docker version 失败）…
﹣ 真实运行时：Android emulator（AVD headless） # 本机已有 emulator + AVD（dsh-phone-avd）；真实链路默认不跑…
﹣ 真实链路：scrcpy pushServer + 视频/控制 socket # 本机无 scrcpy-server jar（node scripts/fetch-scrcpy-server.mjs 可下载）…
﹣ 真实浏览器：右栏面板 / WebCodecs(Annex-B) / TinyH264 回退 / 设置页 # 本机无浏览器自动化依赖…
﹣ 真实 attach：TCP adbd 连接 + getprop + screencap # 未设置 DSH_PHONE_E2E_ENDPOINT…
﹣ 真实 emulator 全链路：截图 PNG / WS DPH1 / 控制 / 释放 # 未设置 DSH_PHONE_E2E=1…
ℹ tests 6 / pass 0 / fail 0 / skipped 6
\`\`\`


## 3. 安装冒烟关键证据（verify-install 实跑）

### 3.1 dump-config（是否看到 dsh-phone 行）

安装（\`--from-default-profile headless\` 初始化 + \`dsh plugin --profile phone-verify add .\`）后：

\`\`\`
- id: dsh-phone
  name: dsh-phone
\`\`\`

再向**临时 profile** 的 \`cordis.patch.yml\` 写入用户层（仅测试用）后，组合结果包含：

\`\`\`
runtime: attach
maxSize: 640
userHint: 验证用一句话
\`\`\`

即 dump-config 既能看到插件行，也能看到 profile 用户层 config 生效。

### 3.2 dump-config-schema

- \`x-cordis.complete = true\`，无 error 诊断；
- dsh-phone entry 的 config schema 顶层字段：\`enabled/runtime/attach/redroid/emulator/stream/lifecycle/limits\`；
- \`attach.endpoint|userHint|resolved\` 均带 \`x-cordis.volatile: true\`；
- \`stream\` 默认 720/15/2000000，\`lifecycle\` 默认 300000/1800000，\`limits.maxInstances=1\`，runtime 四枚举齐全。

### 3.3 --help（apply 真执行）

\`dsh --profile phone-verify --help\` 退出码 0，stdout 为 headless app 的 usage（说明 profile 成功启动、插件行已 apply）；
stderr 仅有宿主无关警告（本机 \`all_proxy\` 是 SOCKS 的提示），**无 dsh-phone 插件加载错误**。
（\`--help\` 本身不打印工具列表，故另用 §3.4 的隔离 web 启动证明 apply 的副作用。）

### 3.4 隔离 DSH_HOME 的 web apply 冒烟

- 在临时 \`DSH_HOME\` 复制 web 模板 + 安装 dsh-phone + 写用户层，\`dsh --profile phone-verify --no-open --port 0\` 启动；
- 捕获启动 URL 后：
  - \`storages/dsh-phone/agent.json\` 存在，\`baseUrl\` 等于实际监听 origin，token 为 64 位 hex，权限 0600；
  - 未认证 \`GET /dsh-phone/api/config\` → **401** \`E_AUTH\`（路由已注册且有鉴权）；
  - 携带启动 URL 的浏览器 token 换取同源 cookie 后 → **200**，\`{runtime:"attach", stream:{maxSize:640,...}}\`（profile 用户层 config 真实生效）；
- 结束 SIGTERM，web 进程退出码 0，临时 home 与 profile 全部删除。
- **观察项**：本机 SIGTERM 后 \`agent.json\` 仍残留（异步 dispose 未被等待）。文件位于隔离临时 home，随 home 删除，不影响用户；"卸载后 token 文件删除"仍属未验证项（见 §4）。

## 4. 未覆盖项（不得视为通过）

1. **真实运行时**：redroid 未验证（本机无 Docker）；emulator 自启（B 分支）已于 2026-11-10 由插件 owned 启动/停止实测 **PASS**（§7.4）；attach 复用已运行实例 **PASS**（§7.3）。
2. **Host WS 视频流**：真实设备/emulator 上已实测 PASS（#59/#60 修复后：ready + DPH1；2026-11-10 复核 19–53 帧/10s、控制无 error，帧率随屏幕刷新内容波动）；修复前的 FAILED 记录见 §7.2。
3. **phone_shell 审批 UI 往返**：waterfall 返回 ask 的逻辑已验；真实审批 UI 点击「允许一次/拒绝」未跑。
4. **配置 volatile 热更新**：\`ctx.settings.mutate\` 真实写入 + 插件读到新值 + 配置行不重载，未在真实 dsh Web 会话验证（安装冒烟只验证了启动时 profile 用户层 config 生效）。
5. **Agent token 通道**：\`agent.json\` 落盘/0600/loopback+无 Origin 判定已在真实进程验证 token 通道的"未认证 401"分支；\`GET /status\` 已由 2026-11-10 e2e 用 token 跑通；带 token 的 \`POST /attach/verify\`、\`POST /agent/config\` 未在真实设备/真实写配置场景跑通。
6. **attachments 图片内容块**：\`saveImage\` 失败降级有单测；真实模型路由是否接受 image block 未验证。
7. **\`ctx.connection.requestRejection\` 在自定义 prefix/upgrade 的真实行为**：安装冒烟与 e2e 已验证同源 Cookie（GET/WS/POST \`/runtime\`）与 401 路径；401/403 的 Origin/跨站语义未在真实浏览器验证。
8. **卸载/重载清理**：token 文件删除见 §3.4 观察项；HMR 重载后的旧 token 失效未验证。
9. **本地平台限制**：本机无 Docker、无独立真机、无浏览器自动化；emulator + AVD 已具备（§7 实测）；scrcpy-server jar 按 CONTRIBUTING §4 作为临时下载产物在验收后删除，复跑前执行 \`node scripts/fetch-scrcpy-server.mjs\`。
10. **真实缺陷（2026-10-25 发现，已由 #59/#60 修复并复测）**：Host PhoneService 曾把 AdbConnection.raw 传给 stream 层导致真实设备 E_STREAM_START_FAILED；修复后重跑 §7 全链路 PASS，缺陷记录保留在 §7.2 供追溯。
11. **断开后极短间隔重连**：e2e 探针/正式连接间隔 <2.5s 时会命中 scrcpy-server 退出清理删 jar 的瞬态（\`E_STREAM_START_FAILED\`，设备日志 \`ClassNotFoundException\`）；harness 已加冷却 + 单次重试（§7.5），真实浏览器自动重连是否会命中未实测；产品侧兜底未做（\`src/\` 不在本 PR 范围）。


## 5. 人工待办（真实浏览器，禁止当成已通过）

来自 \`docs/client.md §6\`、\`docs/host.md §7\`、\`docs/stream.md §8\`，需在真实 Chrome/Firefox/Safari + 可用 Android 实例上人工执行：

- [ ] 右侧栏面板能打开、标题/主题 token、明暗切换、画布尺寸/DPR 正确；
- [ ] WebCodecs 接受 \`avc.format='annexb'\` + in-band SPS/PPS 并稳定解码 720p/15fps；
- [ ] TinyH264 主线程软解回退路径可播放，CPU/帧率可接受；
- [ ] 面板不可见（tab 切换/折叠/页面隐藏）时 \`IntersectionObserver + visibilitychange\` 双检测触发断流，恢复可见自动重连；
- [ ] 设置页写入 \`attach.userHint\`（同源 cookie，含 409 重试一次）真实落盘并回读；
- [ ] 软解回退发生在流中途时，等待下一个关键帧的实际时延；
- [ ] \`phone_shell\` 审批 UI：非白名单命令弹「允许一次/拒绝」，白名单不弹；
- [ ] 真实实例上 \`phone_screenshot\` 的 image block 被模型路由接受、截图内容正确；
- [ ] 真实实例上 tap/swipe/key/input_text（中文 INJECT_TEXT）/app_launch/uiautomator_dump 的视觉+控件树闭环（设备侧控制通道已由 #40 e2e 验证，工具级模型闭环未跑）；
- [ ] 真实 redroid / Windows(WHPX) / macOS(HVF) 的启动与生命周期；emulator 自启/懒启动、booting 中间态（\`E_BOOTING\`）已由 #40 e2e 覆盖（§7.4），idle→paused→resume 未覆盖；
- [x] scrcpy 实连：pushServer、首帧、控制通道、断开重连（#40 e2e 覆盖，非浏览器路径：§7.3/§7.4）；
- [ ] 真实 dsh 会话中 \`ctx.settings.mutate\` volatile 热更新与配置行不重载。


## 6. 复现方式

\`\`\`sh
# 仓库根目录（干净 checkout 亦可；node_modules 缺失时 verify 会自动 npm install）
npm install          # 可选：verify 会检测缺失后自动安装
npm run verify       # 一条命令：工具/协议/安装冒烟/行数/e2e(skip)
\`\`\`

带真实设备时额外启用（默认 DSH_PHONE_E2E_MODE=auto：5555 可达 → attach，否则 SKIP；不隐式冷启动）：

\`\`\`sh
DSH_PHONE_E2E=1 npm run verify                          # 含 verify-emulator + real-emulator e2e（需已运行实例）
DSH_PHONE_E2E=1 DSH_PHONE_E2E_MODE=attach node scripts/verify/verify-emulator.mjs    # A 分支：复用已运行实例
DSH_PHONE_E2E=1 DSH_PHONE_E2E_MODE=emulator node scripts/verify/verify-emulator.mjs  # B 分支：插件自启 owned 实例（需 5555 空闲）
DSH_PHONE_E2E_ENDPOINT=127.0.0.1:5555 npm run verify     # 独立真机/emulator attach e2e
\`\`\`

单独运行某一项：

\`\`\`sh
node scripts/verify/verify-tools.mjs
node scripts/verify/verify-stream.mjs
node scripts/verify/verify-install.mjs
node --test tests/e2e/*.test.mjs
\`\`\`

清理核对（verify 正常/异常退出后均应成立）：

\`\`\`sh
test ! -e ~/.dsh/profiles/phone-verify && echo "临时 profile 已清理"
ls /tmp | grep -c '^dsh-phone-verify-' || true   # 应为 0（隔离临时 home）
ss -ltn | grep 5555 || echo "无 emulator 监听"    # attach 实例归用户；B 分支结束时插件已 stop
pgrep -af 'qemu-system.*dsh-phone-avd' || echo "无 dsh-phone-avd 残留进程"
\`\`\`



## 7. 真实 emulator 链路实测（#40）

### 7.1 历史：A 分支 attach 首测（2026-10-25）

环境：Debian 13 / Node v24.21.0 / dsh 0.2.1-rc.2；emulator-5554（sdk_gphone64_x86_64，
Physical size: 720x1280）由**用户 live dsh web（3080）会话中的插件拉起**，本验收只复用、
**未启动也未停止**该实例（清理后端口仍可达）。隔离临时 DSH_HOME + 临时 phone-e2e web
profile（--no-open --port 0），onboarding 写 status=accepted / choice=attach +
attach.endpoint=127.0.0.1:5555。

复测：origin/main 29bc9b9（#59/#60 修复）合入后，2026-10-25 15:15 重跑（修复前的失败记录见 §7.2）。

命令：DSH_PHONE_E2E=1 node scripts/verify/verify-emulator.mjs（约 34s；退出码 0）

| 检查项 | 结果 | 实测证据 |
|---|---|---|
| 临时 web apply + 同源鉴权 | PASS | /config 返回 enabled=true, runtime=attach, onboarding={accepted,attach}, attach.endpoint=127.0.0.1:5555, resolved=true |
| GET /screenshot -> PNG | **PASS** | 720x1280，708213 bytes，attempts=1，775ms，保存 /tmp/dsh-phone-e2e/screenshot-*.png |
| WS 握手 + hello | PASS | 带同源 Cookie 的 Upgrade 成功（101），hello 后收 state/ready |
| Host WS 视频流 ready/DPH1 | **PASS** | ready: codec=h264, 720x1280, deviceWidth/Height=720/1280, maxSize=720, maxFps=15；10s 收 **102 帧**（config=1, key=1, delta=100，约 10.2fps），DPH1 头全部合法 |
| stream 层直连对照 | **PASS** | startStream 704ms（含 pushServer），5s 收 51 帧（~10fps）、keyframe 1、video 408x720、deviceWidth/Height=720/1280；injectKey/touch/text 全成功 |
| Host 释放/状态 | **PASS** | WS 关闭 + 6.5s 后 GET /status 仍 running；二次 WS 连接重建成功并收到 31 帧（viewer 已释放） |
| 清理 | PASS | 临时 web 退出码 0、隔离 home/profile 删除；emulator 仍可达=true（未停止用户实例） |
| emulator 自启（B 分支） | SKIP（当时） | 5554/5555 被用户 live 实例占用；按 Lead 决策不 SIGTERM 用户实例（B 分支已于 2026-11-10 覆盖，见 §7.4） |
| 真实浏览器渲染/WebCodecs/TinyH264 | 人工待办 | 见 §5，不冒充通过 |

### 7.2 缺陷记录：host-adb-raw-double-unwrap（已修复）

- 现象：真实设备上右侧栏 WS 视频流启动失败，E_STREAM_START_FAILED: Cannot read properties of undefined (reading sync)。
- 定位：Host 接线把 AdbConnection.raw（已是 Tango Adb 实例）传给 stream 层
  （src/phone/service.ts:331 视频会话、:534 control-only），而 stream 层
  src/stream/scrcpy.ts 期望 AdbConnection 并再次读 adb.raw -> undefined，
  AdbScrcpyClient.pushServer(undefined) 读 .sync 抛错。
- 影响：视频流（WS）与 phone_input_text/触摸控制通道在真实设备不可用；截图/工具 shell 不受影响。
- 处理：已记录 issue #59，由 #59/#60 修复（service.ts 传 AdbConnection 而非 .raw），合并后本脚本重跑 **全链路 PASS**（§7.1/§7.3），缺陷保留记录供追溯。

### 7.3 2026-11-10 复核：A 分支（attach 复用）PASS

环境：Debian 13 / Node v24.21.0 / dsh 0.2.2-rc.1（本机当前）；AVD dsh-phone-avd（android-34
google_apis x86_64，1080x2400 @420dpi）由**本验收手动**用 emulator CLI 启动（-no-window -no-audio
-no-boot-anim -gpu angle_indirect -port 5554）作为「已运行实例」；插件只 attach 复用，**未启动/未停止**
该实例；连续 2 次脚本运行 + 1 次 node --test 后端口仍可达。

命令：DSH_PHONE_E2E=1 node scripts/verify/verify-emulator.mjs（两次约 36.7s / 35.1s；退出码 0）

| 检查项 | 结果 | 实测证据（两次独立运行） |
|---|---|---|
| 临时 web apply + 同源鉴权 | PASS | /config：enabled=true, runtime=attach, onboarding={accepted,attach}, attach.endpoint=127.0.0.1:5555, resolved=true |
| GET /runtime 所有权 | **PASS** | state=running, owned=false, adopted=true, endpoint.port=5555 |
| GET /screenshot -> PNG | **PASS** | 1080x2400，2,239,924 / 2,050,628 bytes，attempts=1，1328 / 1098ms |
| WS 握手 + hello | PASS | 带同源 Cookie 的 Upgrade 101，hello 后收 state/ready |
| Host WS 视频流 ready/DPH1 | **PASS** | ready codec=h264, 720x1280, deviceWidth/Height=1080/2400；10s 收 28 / 31 帧（config=1, key=1, delta=26/29），DPH1 头全部合法 |
| 控制通道 | **PASS** | key:HOME + touch down/up(360,640) + text:你好 e2e → error 帧 0 |
| stream 层直连对照 | **PASS** | startStream 448 / 256ms（含 pushServer）；5s 收 12 帧、keyframe 1、video=328x720、deviceWidth/Height=1080/2400；injectKey/touch/text 全成功 |
| Host 释放/状态 | **PASS** | WS 关闭 + 6.5s 后 state=running；二次 WS 连接重建成功（12 帧） |
| 清理 | PASS | 临时 web 退出码 0、隔离 home/profile 删除；5555 仍可达=true（未停止该实例） |
| env-gated node --test | PASS | DSH_PHONE_E2E=1 node --test tests/e2e/real-emulator.test.mjs（36.5s）；DSH_PHONE_E2E_ENDPOINT=127.0.0.1:5555 node --test tests/e2e/real-device.test.mjs（1.3s，screencap PNG） |
| 真实浏览器渲染/审批 UI | 人工待办 | 见 §5，不冒充通过 |

### 7.4 2026-11-10 首测：B 分支（插件自启 owned emulator）由 SKIP 转 PASS

环境同 §7.3，但 **5555 端口空闲**（先 adb -s emulator-5554 emu kill 并等端口释放）。临时 profile
写 runtime: emulator + onboarding.choice: emulator + emulator.avdName: dsh-phone-avd；首次
GET /screenshot 触发懒启动（等价面板/工具首次交互），插件 spawn：

    qemu-system-x86_64-headless -avd dsh-phone-avd -no-window -no-audio -no-boot-anim -gpu angle_indirect
      -netdelay none -netspeed full -memory 2048 -cores 4 -camera-back none -camera-front none
      -no-metrics -port 5554 -snapshot default_boot

命令：DSH_PHONE_E2E=1 DSH_PHONE_E2E_MODE=emulator node scripts/verify/verify-emulator.mjs
（三次独立运行 130.4s / 45.0s / 46.4s，退出码 0；第 1 次为「快照无效 → 冷启动」，见 §8.6）

| 检查项 | 结果 | 实测证据（快照启动两次） |
|---|---|---|
| 模式决策 | PASS | 端口空闲 → emulator 自启；若端口已可达则明确 SKIP（不 adopt 冒充自启） |
| 懒启动 + 首帧 | **PASS** | 首次 GET /screenshot 阻塞触发启动 → PNG；pid 321506 / 324352，AVD=dsh-phone-avd |
| GET /screenshot -> PNG | **PASS** | 1080x2400，2,226,651 / 2,226,420 bytes，attempts=1，7927 / 9024ms（冷启动轮为 70420ms） |
| GET /runtime 所有权 | **PASS** | state=running, running=true, owned=true, adopted=false, pid=321506/324352, endpoint.port=5555 |
| WS 握手 + hello | PASS | 带同源 Cookie 的 Upgrade 101，hello 后收 state/ready |
| Host WS 视频流 ready/DPH1 | **PASS** | ready codec=h264, 720x1280, deviceWidth/Height=1080/2400；10s 收 20 / 19 帧（config=1, key=1），DPH1 头合法 |
| 控制通道 | **PASS** | key:HOME + touch down/up(360,640) + text:你好 e2e → error 帧 0 |
| stream 层直连对照 | **PASS** | startStream 227 / 288ms；5s 收 12 帧、keyframe 1、video=328x720、deviceWidth/Height=1080/2400 |
| Host 释放/状态 | **PASS** | WS 关闭 + 6.5s 后 state=running；二次 WS 连接重建成功（12 帧） |
| owned stop | **PASS** | POST /runtime stop → 202；state=stopped，2.0s（冷启动轮 9.1s）；pid 已退出；5555 不可达；残留进程 0 |
| 清理 | PASS | 临时 web 退出码 0、隔离 home/profile 删除；无 emulator 监听/进程 |
| env-gated node --test（B） | PASS | DSH_PHONE_E2E=1 DSH_PHONE_E2E_MODE=emulator node --test tests/e2e/real-emulator.test.mjs（46.4s） |
| 真实浏览器渲染/审批 UI | 人工待办 | 见 §5，不冒充通过 |

### 7.5 观察项：断开后极短间隔重连的瞬态竞态（harness 已兜底，产品侧未改）

- 现象（2026-11-10 曾稳定复现）：e2e 的「WS 探针 → 立即正式连接」在探针关闭后 <2s 重连时，
  新连接收到 E_STREAM_START_FAILED: scrcpy server 启动失败: scrcpy server exited prematurely；
  adb logcat 同时出现 java.lang.ClassNotFoundException: com.genymobile.scrcpy.Server。
- 定位：scrcpy-server 3.3.x 启用 cleanup（退出时删除设备上的
  /data/local/tmp/scrcpy-server.jar）；上一个 server 的退出清理与下一个会话的 pushServer/start
  重叠 → 新 server 启动时 jar 已被删。设备侧会话结束后 ls /data/local/tmp 为空，印证该删除行为。
- 处理（本 PR 仅改 harness，不改 src/）：scripts/verify/shared/real-e2e.mjs 在探针关闭后冷却
  2.5s 再建正式连接；命中该瞬态时再冷却 2.5s 重试一次，并打印
  [evidence] host-stream-retry。冷却后连续 A 分支 2 次 + B 分支 3 次运行均未再出现。
- 未决：真实浏览器断流自动重连（带退避，间隔通常 >1s）是否会命中同类竞态未实测；
  若需要产品侧兜底（push 前校验/自动重试），建议另开 issue。

### 7.6 复现与证据（2026-11-10）

```sh
# 0) 准备：scrcpy-server jar（CONTRIBUTING §4：临时产物用完即删，复跑前重新下载）
node scripts/fetch-scrcpy-server.mjs

# A 分支（attach）：先手动起 headless 实例；脚本只 attach，不启动/不停止该实例
~/Android/Sdk/emulator/emulator -avd dsh-phone-avd -no-window -no-audio -no-boot-anim \
  -gpu angle_indirect -no-metrics -camera-back none -camera-front none -port 5554 &
adb devices                      # 等 emulator-5554 device + sys.boot_completed=1
DSH_PHONE_E2E=1 node scripts/verify/verify-emulator.mjs
DSH_PHONE_E2E=1 node --test tests/e2e/real-emulator.test.mjs
DSH_PHONE_E2E_ENDPOINT=127.0.0.1:5555 node --test tests/e2e/real-device.test.mjs
adb -s emulator-5554 emu kill    # A 分支实例由人工启动，人工停止

# B 分支（插件自启）：确认 5555 空闲；插件 owned 启动，结束时由 POST /runtime stop 停止
DSH_PHONE_E2E=1 DSH_PHONE_E2E_MODE=emulator node scripts/verify/verify-emulator.mjs
DSH_PHONE_E2E=1 DSH_PHONE_E2E_MODE=emulator node --test tests/e2e/real-emulator.test.mjs
```

证据文件：/tmp/dsh-phone-e2e/report.json（最近一次）、report-attach.json / report-emulator.json、
screenshot-*.png；插件 emulator 日志 /tmp/dsh-phone-emulator-5554.log；临时 web/DSH_HOME 已清理。
默认 DSH_PHONE_E2E_MODE=auto：端口可达 → attach，否则 SKIP（不隐式冷启动）；attach 模式要求端口
可达，emulator 模式要求端口空闲。


### 7.7 2026-11-10 rebase 后复核（v0.4.2 基线：origin/main 5eaa2f2，含 #72/#112/#113）

#118 rebase 到 origin/main 5eaa2f2（含 #72 修复、#112 依赖升级到 DSH 0.2.2-rc.1、#113 URL/发布）后，
在最终代码上重跑 A/B 两条真实链路，确认 #72 的 boot 等待预算 240s、断连映射、control 单飞未破坏链路：

| 场景 | 命令 | 结果 | 关键数据 |
|---|---|---|---|
| A attach | `DSH_PHONE_E2E=1 node scripts/verify/verify-emulator.mjs` | **PASS**（36.1s） | 截图 1080x2400 / 2,043,846 bytes / 959ms；`/runtime` owned=false adopted=true；Host WS 20 帧/10s（config=1 key=1）；key+touch+中文文本 error 0；直连 push/start 230ms、12 帧/5s；关闭 6.5s 后仍 running、二次连接 12 帧；清理后 5555 仍可达 |
| B 自启 | `DSH_PHONE_E2E=1 DSH_PHONE_E2E_MODE=emulator node scripts/verify/verify-emulator.mjs` | **PASS**（46.3s） | 插件 owned spawn（pid 349699，AVD dsh-phone-avd）；首帧截图 10.2s（快照启动，E_BOOTING 0 次）；Host WS 20 帧/10s；直连 236ms、12 帧/5s；`POST /runtime stop` 202 → stopped 2.0s、pid 退出、5555 不可达、残留进程 0 |

说明：control 通道（WS key/touch/text → scrcpy control session）在 #72 的 single-flight 改造后无 error；
boot 预算 240s（`src/phone/state.ts`）下 B 分支 10.2s 首帧、未触发超时；本机 `node --test`
**496 例 / 490 pass / 6 skipped / 0 fail**（rebase 后含 #72 新增用例）。其余 SKIP 项与 §5 不变。


## 8. emulator 启动性能（issue #67）

### 8.1 环境与方法

- 宿主：Debian 13 / 16 vCPU / KVM（`/dev/kvm`）/ 内存 15GB；Android emulator **37.2.12**；
  镜像 `system-images;android-34;google_apis;x86_64`；AVD `dsh-phone-perf`（独立实例，
  **端口 5556/5557**，不干扰用户在 5554/5555 的实例）。
- 测量脚本：`node scripts/verify/measure-boot.mjs --repeat 2 --out <json>`；
  每场景两轮取中位数。指标：
  - adbd 端口就绪：emulator 进程启动 → ADB TCP 端口可连；
  - boot_completed：进程启动 → `sys.boot_completed=1` 且 `pm path android` 可用
    （脚本较修复后的 Host 就绪判定少查 bootanim，故 Host 视角略慢 0.5–1s）；
  - 首帧截图：boot_completed 后第一次成功 `screencap` 的耗时；
  - 进程启动→首帧 = boot_completed 中位数 + 首帧中位数（端到端近似）。
- 每轮流程：删快照 → 冷启动测量 → console `avd snapshot save default_boot` + 等 `snapshot.pb` 稳定 →
  SIGTERM → 快照启动测量 → 再次 SIGTERM → 暂停恢复测量。
- AVD 参数：修复后新建 AVD 使用 `-d medium_phone`（实测 config：1080x2400 @420dpi，
  ramSize 1536M；启动时 `-memory 2048 -cores 4`），默认不传 `-skin`。

### 8.2 实测数字（2 轮中位数）

| 场景 | adbd 端口就绪 | boot_completed | 首帧截图 | 进程启动→首帧 |
|---|---|---|---|---|
| 冷启动（有数据、无快照） | 1.0s | 33.2s | 6.3s | **~40s** |
| 快照启动（quick-boot） | 1.5s | 13.5s | 1.0s | **~15s** |
| 暂停恢复（SIGTERM→快照加载） | 0.9s | 16.4s | 3.1s | **~19s** |
| 首次冷启动（全新 AVD 第一次 boot） | 0.4s | 94.8s | —（当时截图未就绪） | **~95s** |

补充证据（emulator 日志 `Successfully loaded snapshot ... using X ms`）：快照加载本身 8.4s / 10.1s /
15.7s / 19.6s / 20.6s 波动，主要受宿主 I/O 与其它 emulator 竞争影响；这是“暂停恢复 ≈15–20s”的主因。

### 8.2b 第二轮：新 AVD 参数（medium_phone + angle_indirect，1 样本，宿主同时跑用户 emulator）

| 场景 | adbd 端口就绪 | boot_completed | 首帧截图 | 进程启动→首帧 |
|---|---|---|---|---|
| 冷启动 | 0.6s | 26.1s | 9.5s | ~36s |
| 快照启动 | 0.8s | 22.5s | 1.6s | ~24s |
| 暂停恢复 | 0.8s | 19.0s | 2.0s | ~21s |

说明：该轮为单样本，且宿主同时运行用户的 5554 实例（CPU/IO 竞争），数字明显劣于 §8.2 的 2 轮中位数；
快照加载日志 8.4–20.6s 波动也印证 I/O 竞争是主因。结论以 §8.2 的 2 轮中位数为准，本表用于展示方差。

### 8.3 结论与目标达成情况

- **温启动（有有效 quick-boot 快照）进程启动→首帧 ≈ 15s（2 轮中位数）≤ 20s：达成**；
  高竞争单样本测到 ~21–24s，属于宿主资源竞争方差。开启预热
  （`lifecycle.prewarm=true`）或面板先打开后，面板首帧只需视频流启动（~1–3s）。
- **冷启动 ≤20s：未达成，且有客观下限**。Android 14 google_apis 首次 boot ≈95s、有数据冷启动 ≈33s；
  这部分由系统镜像决定，靠 flag 压不下去。可选方案是 **aosp_atd**（精简镜像，无 GApps）——本机
  **未安装**该 system image（插件不代装），因此**未实测**；安装后
  `node scripts/verify/measure-boot.mjs --image "system-images;android-34;aosp_atd;x86_64"` 即可复测。
- 修复前的失败形态（用户实测 ~100s 首次、恢复慢）：快照 `Failed to load snapshot`（`snapshot.pb`
  仅 11 字节，pause 的 10s SIGKILL 截断写入）、就绪只看 TCP 端口导致黑屏期 running、同 AVD 再开一台
  multi-instance FATAL。见 §8.4 的修复清单。

### 8.4 本 PR 的启动修复（对应现象）

1. 快照有效性自检：启动前检查 `<avd>/snapshots/default_boot/snapshot.pb` >1KB 且存在 ram/img，
   无效则删除目录回退冷启动（不再 `Failed to load snapshot`）。
2. 保存不再 10s SIGKILL：pause/stop 先 console `avd snapshot save default_boot`（token 读
   `~/.emulator_console_auth_token`）并轮询 `snapshot.pb` 稳定，再 SIGTERM，最多等 120s。
3. 就绪 = `sys.boot_completed=1` + `init.svc.bootanim=stopped` + `pm path android` 可用
   （Host 侧 `waitBootCompleted`，超时 90s），不再以 TCP 端口作为 running 依据。
4. spawn 日志落盘 `/tmp/dsh-phone-emulator-<port>.log`；进程早退时把日志尾部（FATAL）放进错误，
   不再 `stdio:'ignore'` 盲等 120s；boot 超时调用 `adapter.cancelStart()` 清理孤儿。
5. 同 AVD 已在运行 → adopt 复用（不 spawn 第二实例；端口未就绪则明确报错）；adopt 的用户实例
   不会被 pause/stop/cancelStart 杀掉。
6. AVD 新建使用 `-d medium_phone`、不默认 `-skin`；补 `-no-metrics/-camera none/-memory/-cores`；
   `-gpu` 按宿主自动（有 `/dev/dri` → `angle_indirect`，否则 `swiftshader_indirect`）。
7. idle 默认 5min → 20min，观看视频按 30s 节流计入交互（不会看着看着被 pause）。
8. 测量脚本 `scripts/verify/measure-boot.mjs`：强制 ≥5556 端口、启动前 bind 探测、就绪用 connect
   探测（不再抢端口），支持 `--repeat/--json/--out`。

### 8.5 未验证 / 遗留

- aosp_atd 未安装 → 冷启动优化未实测（仅有官方“专为测试、启动更快”的定性说明）。
- 最终一轮 `medium_phone + angle_indirect` 组合的重复测量未完成（宿主同时跑用户 emulator，
  样本噪声大）；上表为 pixel_6 参数 + swiftshader_indirect 的两轮中位数，可复现。
- Windows/macOS 的 quick-boot 与 console 保存未实测。
- #72 的安全/生命周期项（phone_key 白名单、screenshot 掩码、boot 断连映射、boot 超时取消、control 单飞）已随 #116（#72）修复并补单测；boot 等待预算 240s（`src/phone/state.ts`），2026-11-10 rebase 后 A/B 真实链路复核通过（§7.7）。

### 8.6 2026-11-10 #40 复核：插件自启路径（快照启动 / 冷启动）

在 §8.1 同一宿主（本次复核时负载更高，且有其它并行构建）上，用 #40 的 B 分支路径实测
「插件 spawn → 首帧截图」（DSH_PHONE_E2E_MODE=emulator，AVD dsh-phone-avd，1080x2400）：

| 场景 | 日志证据 | 进程启动→首帧截图 |
|---|---|---|
| 冷启动（旧快照损坏 → 删除后冷启动） | `Failed to load snapshot 'default_boot'`、`Boot completed in 19313 ms`、`Saving snapshot 'default_boot' took 9350 ms` | 70.4s（E_BOOTING 2 次，首次 31.0s） |
| 快照启动（插件上次 stop 已存有效快照） | `Successfully loaded snapshot 'default_boot' using 4404 ms / 5189 ms` | 7.9s / 9.0s |
| owned stop（SIGTERM；快照已有效 → 不再重存） | POST /runtime stop 202 → state=stopped | 2.0s（另一次 9.1s） |

说明：1–3 轮样本、非 §8.2 的两轮中位数，仅作 #40 复核证据；rebase 后（5eaa2f2）B 分支快照启动
复跑首帧 10.2s（§7.7）。AVD 的 default_boot 快照已由插件重新生成（ram.bin 约 2.5GB），因此后续
启动走快照路径。


## 9. v0.4.0 新增验收（#83 生命周期控制 / #87 肥鱼手机定制）

> 记录于 2026-10-27。单测数字来自本机 `node --test`（472 例 / 466 pass / 6 skipped / 0 fail）；
> 实机结果来自维护者在本机 emulator 上的手工验收，**不是 CI 产物**，也不代表所有宿主。

### 9.1 #87 肥鱼手机定制（实机）

环境：`system-images;android-34;google_apis;x86_64` + AVD `medium_phone`（1080x2400 @420dpi）。

| 检查项 | 期望 | 实测 |
|---|---|---|
| 分辨率 | 1080x2400 | **PASS**（`wm size`） |
| 语言 | `zh-CN` 中文系统 | **PASS** |
| 桌面 | 空白：无图标/widget（自研 `com.dafeiyu.shell` 作为 HOME） | **PASS** |
| 壁纸 | `111`/`222` 双壁纸轮换 | **PASS** |
| YouTube | 已卸载（包不存在） | **PASS** |
| 截图证据 | 首页两张 | `docs/screenshots/feiyu-home-1.webp`、`feiyu-home-2.webp`（360x800 WebP q80，29KB / 36KB） |

应用方式：`system/provision-device.sh`（幂等，可重复执行）；一键准备（Provisioning）在
`step=customize` 自动调用（[#88](https://github.com/thatgfsj-dsh/dsh-phone/issues/88)）。
来源与许可（壁纸由用户提供、系统镜像不入库）见 [../system/README.md](../system/README.md)。

### 9.2 #83 生命周期控制（单测 + 手工核对）

- **runtime 单测**（`tests/runtime/lifecycle-control.test.ts`）：外部 kill → **2s 内** `stopped` +
  可读 `lastError`；owned 的 `stop` 调 `adapter.stop()`（保存快照）、adopted 只断开不杀进程；
  booting 中停止会打断启动；`restart` = stop → start 序列；并发动作合并/排队；动作超时；
  `dispose()` 的 5s 硬预算与所有权区分（owned 停机 / adopted 仅断开）。
- **客户端单测**（`tests/client/lifecycle-acceptance.test.ts`，**11 例**）：动作状态机、错误映射、
  owned vs adopted 文案、轮询；人工核对清单见 [client.md](client.md) §4.5。
- **结构约束**：#90 收口后 `src/phone/service.ts` **893 行**（< 1000 硬线），新增
  `service-types.ts`/`service-helpers.ts`/`control.ts`/`usage.ts`。
- **手工核对（未自动化）**：面板 header 徽章与按钮、停止后空态 + 「启动手机」、adopted 提示文案、
  设置页同入口。**真实浏览器点击未在 CI 验证**。

### 9.3 本版本未覆盖（不得视为通过）

- 真实浏览器下的按钮点击/轮询视觉验收（本机无浏览器自动化）→ 人工待办。
- Windows / macOS 宿主上的生命周期动作与 `system/` 定制脚本均未验证。
- redroid 的 `stop`/`dispose` 语义未实测（本机无 Docker）。
- 冷启动仍 33–95s（见 §8），本版本未针对启动做优化。


## 10. 空白桌面应用抽屉实测（issue #99）

组件契约（host #100 / client #101 直接调用）：`com.dafeiyu.shell.DrawerActivity`
（exported=true、launchMode=singleTop、深色半透明主题；固定命令
`am start -n com.dafeiyu.shell/.DrawerActivity --activity-single-top`）。

环境：emulator-5554 / android-34 google_apis / 1080x2400；APK versionCode=2 / versionName=1.1（561KB）。

| 检查项 | 结果 | 证据 |
|---|---|---|
| 空白首页（无图标/widget） | PASS | /tmp/feiyu-99-home-before.png |
| 上滑打开抽屉 | PASS | adb shell input swipe 540 2000 540 800 300 → mCurrentFocus=DrawerActivity；/tmp/feiyu-99-drawer.png（4 列网格：设置、TMobile；深色半透明；搜索框） |
| adb 固定命令打开 | PASS | am start -n com.dafeiyu.shell/.DrawerActivity --activity-single-top → /tmp/feiyu-99-drawer-adb.png |
| 从抽屉启动「设置」 | PASS | uiautomator bounds [32,435][270,480] → tap(151,457) → topResumedActivity=com.android.settings/.Settings；/tmp/feiyu-99-settings.png |
| 返回 HOME 仍空白 | PASS | KEYCODE_HOME → mCurrentFocus=ShellActivity；/tmp/feiyu-99-home-after.png |

说明：抽屉内应用列表来自 PackageManager MAIN/LAUNCHER，排除肥鱼桌面自身；当前设备只剩
「设置 / TMobile」（YouTube 已在 #87 移除、NexusLauncher 已禁用）。命令行/tap 坐标/截图路径见
/tmp/feiyu-99-evidence.txt。搜索框为名称过滤（本次未做自动化输入验证）。
