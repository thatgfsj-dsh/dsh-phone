#!/usr/bin/env node
/**
 * verify-emulator：真实 emulator/attach 链路验收（issue #40，env-gated）。
 *
 * 默认 SKIP（不碰设备）：只有 DSH_PHONE_E2E=1 才执行。
 * 模式由 DSH_PHONE_E2E_MODE 决定（auto | attach | emulator，默认 auto）：
 * - attach（A 分支）：复用用户已在运行的 emulator（默认 127.0.0.1:5555），
 *   不启动/不停止该实例；
 * - emulator（B 分支）：端口空闲时由插件懒启动 owned emulator（AVD 默认
 *   dsh-phone-avd），验收结束 POST /runtime stop 让插件保存快照并退出；
 * - auto：端口可达 → attach；否则 SKIP（冷启动有代价，不隐式自启）。
 *
 * 场景与断言见 scripts/verify/shared/real-e2e.mjs：
 * 临时隔离 web profile → onboarding accepted + 模式对应 runtime → 认证 →
 * GET /screenshot 轮询 PNG → GET /runtime 所有权 → WS hello/ready + DPH1 帧统计 +
 * key/touch/中文文本 → 断开 5s 宽限后 GET /status 仍 running → 二次 WS 重建 →
 * （B 分支）stop owned emulator → 只清理临时 web/profile。
 */
import { Cleanup, evidence, runScript, step } from './shared/harness.mjs'
import { DEFAULT_AVD_NAME, runRealE2E } from './shared/real-e2e.mjs'

const enabled = process.env.DSH_PHONE_E2E === '1'
if (!enabled) {
  console.log(
    '[verify-emulator] SKIP：未设置 DSH_PHONE_E2E=1（真实设备链路默认不跑；' +
      '设置后 attach 模式需要 127.0.0.1:5555 有可用的 emulator/真机 adbd，' +
      'emulator 模式需要该端口空闲以由插件自启）。',
  )
  process.exit(0)
}

const requestedMode = process.env.DSH_PHONE_E2E_MODE?.trim() || 'auto'
const scenarioName =
  requestedMode === 'emulator'
    ? '真实 emulator 自启全链路（B 分支：owned 启动/截图/WS/控制/释放/stop）'
    : '真实 emulator attach 全链路（A 分支：截图/WS/控制/释放）'

const cleanup = new Cleanup()

await runScript(async () => {
  const report = await step(scenarioName, async () => {
    return await runRealE2E({ cleanup })
  })
  if (report.skipped) {
    if (requestedMode === 'emulator') {
      console.log('[verify-emulator] SKIP（B 分支未执行）：' + report.reason)
      return
    }
    throw new Error('DSH_PHONE_E2E=1 但真实链路未执行：' + report.reason)
  }
  evidence('mode', report.mode)
  evidence('total', '真实链路耗时 ' + report.durationMs + 'ms')
  if (report.mode === 'emulator') {
    evidence(
      'emulator',
      '插件自启 AVD=' + DEFAULT_AVD_NAME + '（owned）→ 已用 POST /runtime stop 停止；' +
        '残留进程=' + report.emulator.stop.leftoverProcesses + '，端口已关闭=' + report.emulator.stop.portClosed,
    )
  }
}, cleanup)
