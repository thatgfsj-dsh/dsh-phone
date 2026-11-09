/**
 * 真实设备 e2e 的底层工具（issue #40）：endpoint/TCP 探测、ADB 直连读设备信息、
 * GET /screenshot 轮询、PNG 尺寸、宿主进程/端口断言、stream 层直连对照。
 *
 * 由 real-e2e.mjs（编排）与 real-lifecycle.mjs（B 分支 stop 断言）共用；
 * 只依赖 node: 内置模块与 src/ 的真实实现，不引入第三方依赖。
 */
import { mkdirSync } from 'node:fs'
import { connect as netConnect } from 'node:net'
import { join } from 'node:path'

import { assert, assertEqual, run } from './harness.mjs'
import { isPng, sleep } from './web-profile.mjs'

export const DEFAULT_ENDPOINT = '127.0.0.1:5555'
export const EVIDENCE_DIR =
  process.env.DSH_PHONE_E2E_EVIDENCE_DIR?.trim() || '/tmp/dsh-phone-e2e'

/** attach：设备已在跑，截图应在 120s 内出。 */
export const ATTACH_SCREENSHOT_TIMEOUT_MS = 120_000

export function parseEndpointText(value) {
  const text = String(value ?? '').trim()
  const index = text.lastIndexOf(':')
  assert(index > 0 && index < text.length - 1, 'endpoint 必须是 host:port: ' + text)
  return { host: text.slice(0, index), port: Number(text.slice(index + 1)) }
}

/** TCP 连通性探测（attach/emulator 的 adbd 端口）。 */
export function probeTcp(host, port, timeoutMs = 1200) {
  return new Promise((resolvePromise) => {
    const socket = netConnect({ host, port })
    const done = (ok) => {
      socket.destroy()
      resolvePromise(ok)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

/** pid 是否存活（EPERM 视为存活）。 */
export function isPidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

/** 通过 ps 找指定 AVD 的 emulator/qemu 进程（证据 + 残留断言）。 */
export async function findEmulatorProcesses(avdName) {
  const result = await run('ps', ['-Ao', 'pid=,args='], { timeoutMs: 5_000 }).catch(() => undefined)
  if (!result || result.code !== 0) return []
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.includes('-avd ' + avdName))
}

/** 直连 ADB 读取设备信息（不经过插件；用于断言截图/视频尺寸与设备一致）。 */
export async function readDeviceInfo(endpointText) {
  const endpoint = parseEndpointText(endpointText)
  const { connect } = await import('../../../src/adb/transport.ts')
  const connection = await connect(endpoint, { timeoutMs: 8000 })
  try {
    const model = (await connection.shell('getprop ro.product.model')).trim()
    const wmSize = (await connection.shell('wm size')).trim()
    const match = /(?:Physical|Override) size:\s*(\d+)x(\d+)/.exec(wmSize)
    return {
      endpoint: endpointText,
      model,
      wmSize,
      width: match ? Number(match[1]) : undefined,
      height: match ? Number(match[2]) : undefined,
      serial: connection.serial,
    }
  } finally {
    await connection.close().catch(() => undefined)
  }
}

/** PNG IHDR 尺寸。 */
export function parsePngSize(bytes) {
  assert(isPng(bytes), '截图不是 PNG')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return { width: view.getUint32(16), height: view.getUint32(20) }
}

/**
 * 轮询 GET /screenshot 直到 200 + PNG。
 * - attach 冷启动 booting 可到 120s；B 分支自启含冷启动，预算 300s（调用方传入）；
 * - 记录 E_BOOTING 尝试次数（B 分支用于证明「插件在懒启动并等待 boot」）。
 */
export async function pollScreenshot({
  origin,
  cookie,
  timeoutMs = ATTACH_SCREENSHOT_TIMEOUT_MS,
  intervalMs = 1000,
}) {
  const startedAt = Date.now()
  const deadline = startedAt + timeoutMs
  let attempts = 0
  let bootingAttempts = 0
  let firstBootingMs
  let last = ''
  while (Date.now() < deadline) {
    attempts += 1
    try {
      const response = await fetch(origin + '/dsh-phone/api/screenshot', {
        headers: { cookie },
        signal: AbortSignal.timeout(30_000),
      })
      const bytes = new Uint8Array(await response.arrayBuffer())
      if (response.status === 200 && isPng(bytes)) {
        return {
          bytes,
          attempts,
          ms: Date.now() - startedAt,
          bootingAttempts,
          firstBootingMs,
        }
      }
      const text = new TextDecoder().decode(bytes.subarray(0, 480))
      if (text.includes('E_BOOTING')) {
        bootingAttempts += 1
        firstBootingMs ??= Date.now() - startedAt
      }
      if (/E_ONBOARDING/.test(text)) throw new Error('截图被 onboarding 守卫拒绝: ' + text)
      last =
        'status=' + response.status +
        ' content-type=' + (response.headers.get('content-type') ?? '') +
        ' body=' + text
    } catch (error) {
      last = error instanceof Error ? error.message : String(error)
    }
    await sleep(intervalMs)
  }
  throw new Error(
    'GET /screenshot 轮询超时（' + timeoutMs + 'ms, attempts=' + attempts + '），last=' + last,
  )
}

/** 证据文件路径（/tmp 保留，供 PR 引用）。 */
export function evidencePath(name) {
  mkdirSync(EVIDENCE_DIR, { recursive: true })
  return join(EVIDENCE_DIR, name)
}

/**
 * 直连 stream 层做对照：用真实 AdbConnection 调 src/stream 的 startStream，
 * 覆盖 scrcpy-server push、video 帧、controller 注入。用于区分 Host 接线缺陷。
 */
export async function runDirectStreamScenario(endpointText, options = {}) {
  const endpoint = parseEndpointText(endpointText)
  const captureMs = options.captureMs ?? 5000
  const { connect } = await import('../../../src/adb/transport.ts')
  const { startStream } = await import('../../../src/stream/index.ts')
  const connection = await connect(endpoint, { timeoutMs: 8000 })
  const frames = []
  const sinkErrors = []
  let handle
  const startedAt = Date.now()
  try {
    handle = await startStream(
      connection,
      { maxSize: 720, maxFps: 15, bitrate: 2_000_000 },
      {
        video(chunk, meta) {
          frames.push({ bytes: chunk.length, keyframe: meta?.keyframe === true, pts: meta?.pts })
        },
        error(error) {
          sinkErrors.push(error.message)
        },
      },
    )
    const info = await handle.info
    const startMs = Date.now() - startedAt
    await sleep(captureMs)
    const controlStartedAt = Date.now()
    await handle.controller.injectKey('HOME')
    await handle.controller.injectTouch('down', 360, 640)
    await handle.controller.injectTouch('up', 360, 640)
    await handle.controller.injectText('你好 e2e')
    return {
      ok: true,
      info,
      frameCount: frames.length,
      keyframes: frames.filter((frame) => frame.keyframe).length,
      firstFrameBytes: frames[0]?.bytes ?? 0,
      sinkErrors,
      startMs,
      observedMs: Date.now() - startedAt,
      controlMs: Date.now() - controlStartedAt,
    }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      cause: error?.cause?.message,
      frameCount: frames.length,
      sinkErrors,
      observedMs: Date.now() - startedAt,
    }
  } finally {
    if (handle) await handle.stop().catch(() => undefined)
    await connection.close().catch(() => undefined)
  }
}
