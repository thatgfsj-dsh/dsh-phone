/**
 * e2e：真实 emulator/attach 全链路（可选，env-gated）。
 *
 * 默认 skip；只有 DSH_PHONE_E2E=1 才跑。断言内容由
 * scripts/verify/shared/real-e2e.mjs 实现（截图 PNG、GET /runtime 所有权、
 * WS DPH1 帧、控制通道、断开后 Host 仍 running、二次连接重建、清理语义）。
 *
 * 模式由 DSH_PHONE_E2E_MODE 决定（auto|attach|emulator）：
 * - attach：复用已在运行的实例（默认 127.0.0.1:5555），不拥有、不停止；
 * - emulator（B 分支）：端口空闲时由插件懒启动 owned emulator，结束时插件 stop
 *   并断言进程退出 + 端口关闭。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

const enabled = process.env.DSH_PHONE_E2E === '1'
const requestedMode = process.env.DSH_PHONE_E2E_MODE?.trim() || 'auto'

test('真实 emulator 全链路：截图 PNG / WS DPH1 / 控制 / 释放', {
  skip: enabled
    ? false
    : '未设置 DSH_PHONE_E2E=1（真实设备链路默认 skip；attach 需 127.0.0.1:5555 有 adbd，' +
      'emulator 自启用 DSH_PHONE_E2E=1 DSH_PHONE_E2E_MODE=emulator）',
}, async (t) => {
  const { Cleanup } = await import('../../scripts/verify/shared/harness.mjs')
  const { runRealE2E } = await import('../../scripts/verify/shared/real-e2e.mjs')
  const cleanup = new Cleanup()
  try {
    const report = await runRealE2E({ cleanup })
    if (report.skipped) {
      // 显式模式但环境不满足（如 emulator 模式下端口已被占用）：如实 SKIP，不冒充通过。
      assert.notEqual(requestedMode, 'auto', 'DSH_PHONE_E2E=1 但真实链路未执行: ' + report.reason)
      t.skip(report.reason)
      return
    }
    assert.equal(report.screenshot.width > 0, true)
    assert.equal(report.screenshot.height > 0, true)
    assert.equal(report.hostStream.ok, true, 'Host WS 视频流必须建立')
    assert.equal(report.hostStream.frameCount > 0, true)
    assert.equal(report.hostStream.configurationFrames > 0, true)
    assert.equal(report.hostStream.keyFrames > 0, true)
    assert.equal(report.release.status, 'running')
    if (report.mode === 'emulator') {
      assert.equal(report.emulator.startedByPlugin, true)
      assert.equal(report.emulator.owned, true)
      assert.equal(report.emulator.adopted, false)
      assert.equal(report.emulator.stopped, true, '插件 stop owned emulator 后必须已停止')
      assert.equal(report.emulator.stillReachableAfterCleanup, false)
    } else {
      assert.equal(report.emulator.preexisting, true)
      assert.equal(report.emulator.stopped, false)
      assert.equal(report.emulator.stillReachableAfterCleanup, true)
    }
  } finally {
    await cleanup.run()
  }
})
