/**
 * 真实 emulator/attach 链路验收（issue #40）——编排入口。
 *
 * 两种模式（env `DSH_PHONE_E2E_MODE`，默认 auto）：
 * - `attach`（A 分支）：复用**已在运行**的 emulator/真机（默认 127.0.0.1:5555），
 *   不拥有、不停止该实例；退出后端口必须仍可达。
 * - `emulator`（B 分支）：端口空闲时由插件**懒启动** owned emulator（AVD 默认
 *   dsh-phone-avd；首次触发 = GET /screenshot 轮询，等价面板/工具首次交互），
 *   断言 owned/adopted/pid 与真实进程，验收结束 POST /runtime stop 让插件
 *   保存快照并退出（owned 语义），并断言进程退出 + 端口关闭。
 * - `auto`：端口可达 → attach；否则 SKIP（自启属有代价动作，需显式指定模式）。
 *
 * 场景：隔离临时 web profile（onboarding accepted + 对应 runtime）→ 认证 →
 * GET /screenshot 轮询 PNG → GET /runtime 所有权 → WS hello/ready + DPH1 帧统计 +
 * key/touch/中文文本 → 断开 6.5s 后 GET /status 仍 running → 二次 WS 重建 →
 * （B 分支）stop owned emulator → 只清理临时 web/profile。
 *
 * 实现拆分（均在本目录）：
 * - real-device-ops.mjs：endpoint/TCP/设备信息/截图轮询/进程与端口/stream 直连对照；
 * - real-host-stream.mjs：Host WS 探针 + 正式 viewer（含瞬态竞态冷却重试）；
 * - real-lifecycle.mjs：GET/POST /runtime 所有权与 owned stop 断言 + 兜底清理。
 */
import { writeFileSync } from 'node:fs'

import { assert, assertEqual, evidence } from './harness.mjs'
import {
  ATTACH_SCREENSHOT_TIMEOUT_MS,
  DEFAULT_ENDPOINT,
  EVIDENCE_DIR,
  evidencePath,
  parseEndpointText,
  parsePngSize,
  pollScreenshot,
  probeTcp,
  readDeviceInfo,
  runDirectStreamScenario,
} from './real-device-ops.mjs'
import { runHostStream } from './real-host-stream.mjs'
import {
  readRuntimeInfo,
  registerEmulatorSafetyCleanup,
  stopOwnedEmulator,
} from './real-lifecycle.mjs'
import { createWebProfile, fetchJson, sleep } from './web-profile.mjs'
import { runStreamScenario } from './ws-stream.mjs'

export {
  DEFAULT_ENDPOINT,
  EVIDENCE_DIR,
  parseEndpointText,
  parsePngSize,
  pollScreenshot,
  probeTcp,
  readDeviceInfo,
  runDirectStreamScenario,
}

/** B 分支自启使用的 AVD（可用 DSH_PHONE_E2E_AVD 覆盖）。 */
export const DEFAULT_AVD_NAME = process.env.DSH_PHONE_E2E_AVD?.trim() || 'dsh-phone-avd'

/** B 分支：含冷启动（首次 boot 实测 95s）+ 首次 screencap，留足预算。 */
const EMULATOR_SCREENSHOT_TIMEOUT_MS = 300_000

/**
 * 模式决策：
 * - attach：要求端点可达（复用现有实例，不启动/不停止）；
 * - emulator：要求端点**不可达**（否则插件只会 adopt 现有实例，测不到自启；明确 SKIP）；
 * - auto：可达 → attach；否则 SKIP（不隐式冷启动 emulator）。
 */
export async function chooseMode(requested = 'auto', endpointText = DEFAULT_ENDPOINT) {
  const endpoint = parseEndpointText(endpointText)
  const reachable = await probeTcp(endpoint.host, endpoint.port)
  if (requested === 'attach') {
    assert(
      reachable,
      'DSH_PHONE_E2E_MODE=attach 但 ' + endpointText + ' 不可达（需要已运行的 emulator/真机 adbd）',
    )
    return { mode: 'attach', reachable }
  }
  if (requested === 'emulator') {
    if (reachable) {
      return {
        mode: 'skip',
        reachable,
        skipReason:
          'DSH_PHONE_E2E_MODE=emulator（B 分支自启）要求 ' + endpointText +
          ' 当前无实例：检测到端口已可达，插件只会 adopt 复用而非自启。请先停止该 emulator 后重跑。',
      }
    }
    return { mode: 'emulator', reachable }
  }
  assert(
    requested === 'auto',
    'DSH_PHONE_E2E_MODE 只能是 auto/attach/emulator，实际 ' + JSON.stringify(requested),
  )
  if (reachable) return { mode: 'attach', reachable }
  return {
    mode: 'skip',
    reachable,
    skipReason:
      '未检测到 ' + endpointText + ' 的 adbd（attach 复用需已运行实例）；B 分支自启请显式 ' +
      'DSH_PHONE_E2E_MODE=emulator（会由插件启动并在结束时停止 owned emulator）',
  }
}

/** 模式对应的临时 profile 用户层 config 行。 */
function configLinesFor(mode, endpointText) {
  const stream = ['stream:', '  maxSize: 720', '  maxFps: 15', '  bitrate: 2000000']
  if (mode === 'attach') {
    return [
      'runtime: attach',
      'onboarding:',
      '  status: accepted',
      '  choice: attach',
      'attach:',
      '  endpoint: ' + endpointText,
      '  resolved: true',
      ...stream,
    ]
  }
  return [
    'runtime: emulator',
    'onboarding:',
    '  status: accepted',
    '  choice: emulator',
    'emulator:',
    '  avdName: ' + DEFAULT_AVD_NAME,
    '  resolution: 720x1280',
    ...stream,
  ]
}

/** GET /config 断言（onboarding 已接受 + 模式对应 runtime 生效）。 */
async function assertConfig({ origin, cookie, endpointText, mode }) {
  const config = await fetchJson(origin + '/dsh-phone/api/config', { headers: { cookie } })
  assertEqual(config.response.status, 200, 'GET /config 必须 200')
  assertEqual(config.body?.ok, true, 'config ok=true')
  const value = config.body.value
  assertEqual(value.onboarding.status, 'accepted', 'onboarding.status 必须 accepted')
  if (mode === 'attach') {
    assertEqual(value.runtime, 'attach', 'effective runtime 必须 attach')
    assertEqual(value.onboarding.choice, 'attach', 'onboarding.choice 必须 attach')
    assertEqual(value.attach.endpoint, endpointText, 'attach.endpoint 必须生效')
    assertEqual(value.attach.resolved, true, 'attach.resolved 必须生效')
  } else {
    assertEqual(value.runtime, 'emulator', 'effective runtime 必须 emulator（B 分支）')
    assertEqual(value.onboarding.choice, 'emulator', 'onboarding.choice 必须 emulator')
  }
  evidence('config', JSON.stringify(value))
  return value
}

/**
 * 跑完整真实链路；返回 report（skipped=true 表示环境不满足，调用方决定 fail/skip）。
 * Host WS 视频流失败时仍写 report（含缺陷分类）并抛错，保证失败非零退出。
 */
export async function runRealE2E(options = {}) {
  const cleanup = options.cleanup
  assert(cleanup !== undefined, 'runRealE2E 需要传入 Cleanup（保证临时 web/profile 回收）')
  const endpointText = options.endpoint ?? DEFAULT_ENDPOINT
  const requestedMode = options.requestedMode ?? process.env.DSH_PHONE_E2E_MODE?.trim() ?? 'auto'
  const startedAt = Date.now()

  const decision = await chooseMode(requestedMode, endpointText)
  if (decision.mode === 'skip') {
    return { skipped: true, reason: decision.skipReason, mode: requestedMode, endpoint: endpointText }
  }
  const mode = decision.mode
  evidence(
    'mode',
    mode === 'attach'
      ? 'attach（复用已运行实例，未由插件启动、不停止）'
      : 'emulator 自启（B 分支：插件懒启动 owned emulator，结束时 stop）',
  )

  // attach：设备已在跑，先读设备信息；B 分支要等懒启动完成后再读。
  let device = mode === 'attach' ? await readDeviceInfo(endpointText) : undefined
  if (device) {
    evidence('device', device.model + ' / ' + device.wmSize + ' / serial=' + device.serial)
  }

  const context = await createWebProfile({
    cleanup,
    configLines: configLinesFor(mode, endpointText),
  })
  evidence('web', context.origin + '（隔离临时 DSH_HOME=' + context.home + '）')

  const emulatorState = { origin: context.origin, cookie: context.cookie, pid: undefined, stopped: false }
  if (mode === 'emulator') registerEmulatorSafetyCleanup(cleanup, emulatorState)

  const configValue = await assertConfig({
    origin: context.origin,
    cookie: context.cookie,
    endpointText,
    mode,
  })

  // B 分支：GET /screenshot 轮询即「首次交互」，触发插件懒启动；E_BOOTING 期间持续重试。
  const screenshot = await pollScreenshot({
    origin: context.origin,
    cookie: context.cookie,
    timeoutMs: mode === 'emulator' ? EMULATOR_SCREENSHOT_TIMEOUT_MS : ATTACH_SCREENSHOT_TIMEOUT_MS,
  })
  const pngSize = parsePngSize(screenshot.bytes)
  const pngPath = evidencePath('screenshot-' + startedAt + '.png')
  writeFileSync(pngPath, screenshot.bytes)
  if (mode === 'emulator') {
    evidence(
      'boot',
      '懒启动完成：E_BOOTING ' + screenshot.bootingAttempts + ' 次（首次 ' +
        (screenshot.firstBootingMs ?? 0) + 'ms）→ 首帧截图 ' + screenshot.ms + 'ms',
    )
    device = await readDeviceInfo(endpointText)
    evidence('device', device.model + ' / ' + device.wmSize + ' / serial=' + device.serial)
  }
  if (device.width && device.height) {
    assertEqual(pngSize.width, device.width, '截图宽度必须等于设备 wm size 宽度')
    assertEqual(pngSize.height, device.height, '截图高度必须等于设备 wm size 高度')
  }
  evidence(
    'screenshot',
    pngSize.width + 'x' + pngSize.height + '，' + screenshot.bytes.length + ' bytes，attempts=' +
      screenshot.attempts + '，' + screenshot.ms + 'ms，保存=' + pngPath,
  )

  // 所有权断言：attach 必须是 adopted（不拥有用户实例）；B 分支必须是 owned（插件 spawn）。
  const runtimeInfo = await readRuntimeInfo(context.origin, context.cookie)
  evidence('runtime', JSON.stringify(runtimeInfo))
  assertEqual(runtimeInfo.state, 'running', '首次交互后 state 必须 running')
  assertEqual(runtimeInfo.running, true, 'runtime running 必须 true')
  if (mode === 'attach') {
    assertEqual(runtimeInfo.owned, false, 'attach 复用实例 owned 必须 false')
    assertEqual(runtimeInfo.adopted, true, 'attach 复用实例 adopted 必须 true')
  } else {
    assertEqual(runtimeInfo.owned, true, 'B 分支自启实例 owned 必须 true')
    assertEqual(runtimeInfo.adopted, false, 'B 分支自启实例 adopted 必须 false')
    assert(typeof runtimeInfo.pid === 'number', 'B 分支自启实例必须暴露宿主 pid')
    emulatorState.pid = runtimeInfo.pid
  }

  // 1) Host WS 路径：探针握手/hello → 正式 viewer 收帧/控制（瞬态竞态见 real-host-stream）。
  const hostStream = await runHostStream({
    origin: context.origin,
    cookie: context.cookie,
    device,
  })
  if (!hostStream.ok) {
    evidence('host-stream', 'FAILED：' + JSON.stringify(hostStream.error ?? {
      timeout: hostStream.timeout,
      closed: hostStream.closed,
    }))
  }

  // 2) stream 层直连对照：用于定位 Host 接线 vs stream/scrcpy 实现。
  const directStream = await runDirectStreamScenario(endpointText)
  assert(directStream.ok, 'stream 层直连失败: ' + directStream.error)
  assert(directStream.frameCount >= 10, 'stream 层 5s 内至少应收到 10 帧，实际 ' + directStream.frameCount)
  assert(directStream.keyframes >= 1, 'stream 层必须收到 keyframe')
  assertEqual(directStream.sinkErrors.length, 0, 'stream 层 sink 不得报错')
  if (device.width && device.height) {
    assertEqual(directStream.info?.deviceWidth, device.width, 'stream info.deviceWidth 必须等于设备宽度')
    assertEqual(directStream.info?.deviceHeight, device.height, 'stream info.deviceHeight 必须等于设备高度')
  }
  evidence(
    'direct-stream',
    'scrcpy push/start ' + directStream.startMs + 'ms；' + directStream.frameCount + ' 帧，key=' +
      directStream.keyframes + '，video=' + directStream.info?.width + 'x' + directStream.info?.height +
      '，control ' + directStream.controlMs + 'ms',
  )

  // 3) Host 释放：WS 关闭后 6.5s 宽限，实例仍 running（attach 不停止；B 由插件 owned）。
  let release
  if (hostStream.ok) {
    await sleep(6500)
    const status = await fetchJson(context.origin + '/dsh-phone/api/status', {
      headers: { 'x-dsh-phone-token': context.agentToken },
    })
    assertEqual(status.response.status, 200, 'GET /status 必须 200')
    assertEqual(status.body?.ok, true, 'status ok=true')
    assertEqual(status.body.value.state, 'running', 'WS 关闭 + 6.5s 宽限后实例必须仍 running')
    const expectedRuntime = mode === 'attach' ? 'attach' : 'emulator'
    assertEqual(status.body.value.runtime, expectedRuntime, 'status.runtime 必须是 ' + expectedRuntime)
    assertEqual(
      status.body.value.endpoint?.port,
      parseEndpointText(endpointText).port,
      'status.endpoint.port',
    )
    const second = await runStreamScenario({
      origin: context.origin,
      cookie: context.cookie,
      frameWindowMs: 3000,
      readyTimeoutMs: 120_000,
    })
    release = { status: status.body.value.state, secondConnectFrames: second.frameCount, viewerReleased: true }
    evidence('release', 'WS 关闭 + 6.5s 后 state=running；二次连接重建成功（' + second.frameCount + ' 帧）')
    if (mode === 'emulator') {
      release.stop = await stopOwnedEmulator({
        origin: context.origin,
        cookie: context.cookie,
        endpointText,
        pid: emulatorState.pid,
        avdName: DEFAULT_AVD_NAME,
      })
      emulatorState.stopped = true
    }
  } else {
    const status = await fetchJson(context.origin + '/dsh-phone/api/status', {
      headers: { 'x-dsh-phone-token': context.agentToken },
    })
    assertEqual(status.response.status, 200, 'GET /status 必须 200')
    assertEqual(status.body.value.state, 'running', 'Host WS 失败不应影响实例状态（应仍 running）')
    release = { status: status.body.value.state, viewerReleased: false, notApplicable: 'Host WS 未建立视频流，无 viewer 可释放' }
    evidence('release', 'Host WS 未建立（缺陷），GET /status state=' + status.body.value.state)
    if (mode === 'emulator') {
      release.stop = await stopOwnedEmulator({
        origin: context.origin,
        cookie: context.cookie,
        endpointText,
        pid: emulatorState.pid,
        avdName: DEFAULT_AVD_NAME,
      })
      emulatorState.stopped = true
    }
  }

  // 4) 清理只停临时 web；attach 必须仍可达，B 分支 owned 实例必须已停止。
  const webExit = await context.web.stop()
  const stillReachable = await probeTcp(
    parseEndpointText(endpointText).host,
    parseEndpointText(endpointText).port,
  )
  if (mode === 'attach') {
    assert(stillReachable, '清理临时 web 后 emulator/adbd 必须仍可达（本验收不得停止用户实例）')
    evidence('cleanup', '临时 web 退出=' + JSON.stringify(webExit) + '；emulator 仍可达=' + stillReachable + '（未由本次启动、未停止）')
  } else {
    assert(!stillReachable, 'B 分支清理后插件自启的 emulator 必须已关闭（端口仍可达）')
    evidence('cleanup', '临时 web 退出=' + JSON.stringify(webExit) + '；owned emulator 已由插件 stop，端口不可达=' + !stillReachable)
  }

  const defect = hostStream.ok
    ? undefined
    : {
        id: 'host-adb-raw-double-unwrap',
        summary: 'Host PhoneService 把 AdbConnection.raw 传给 stream 层，stream 再读 .raw 得到 undefined，pushServer 报 Cannot read properties of undefined (reading sync)',
        where: 'src/phone/service.ts:331/534（startStream/control session 传 this.#requireConnection().raw）；src/stream/scrcpy.ts:81 期望 AdbConnection 并读 .raw',
        evidence: hostStream.error?.message,
        impact: '真实设备上视频流（WS）与中文输入/触摸控制通道不可用；截图（shell）不受影响',
      }

  const report = {
    skipped: false,
    mode,
    endpoint: endpointText,
    device,
    origin: context.origin,
    config: configValue,
    runtime: runtimeInfo,
    screenshot: {
      path: pngPath,
      bytes: screenshot.bytes.length,
      width: pngSize.width,
      height: pngSize.height,
      attempts: screenshot.attempts,
      ms: screenshot.ms,
      bootingAttempts: screenshot.bootingAttempts,
      firstBootingMs: screenshot.firstBootingMs,
    },
    hostStream,
    directStream: {
      ok: directStream.ok,
      info: directStream.info,
      frameCount: directStream.frameCount,
      keyframes: directStream.keyframes,
      startMs: directStream.startMs,
      observedMs: directStream.observedMs,
      controlMs: directStream.controlMs,
    },
    release,
    defect,
    emulator:
      mode === 'attach'
        ? {
            startedByPlugin: false,
            preexisting: true,
            owned: false,
            adopted: true,
            stopped: false,
            stillReachableAfterCleanup: stillReachable,
          }
        : {
            startedByPlugin: true,
            preexisting: false,
            avdName: DEFAULT_AVD_NAME,
            owned: true,
            adopted: false,
            pid: runtimeInfo.pid,
            stopped: true,
            stop: release.stop,
            stillReachableAfterCleanup: stillReachable,
          },
    durationMs: Date.now() - startedAt,
    finishedAt: new Date().toISOString(),
  }
  const reportPath = evidencePath('report.json')
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n')
  writeFileSync(evidencePath('report-' + mode + '.json'), JSON.stringify(report, null, 2) + '\n')
  evidence('report', reportPath)

  if (!hostStream.ok) {
    throw new Error(
      'Host WS 视频流失败（真实缺陷 ' + defect.id + '）：' + defect.evidence +
        '；但 stream 层直连成功（' + directStream.frameCount + ' 帧，control OK），缺陷在 Host 接线。' +
        ' 详见 ' + reportPath + ' 与 docs/verification.md',
    )
  }
  return report
}
