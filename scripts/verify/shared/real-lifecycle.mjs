/**
 * 真实 e2e 的生命周期/所有权断言（issue #40，B 分支 emulator 自启）：
 * - GET /runtime 读取生命周期快照（state/running/owned/adopted/pid/endpoint）；
 * - POST /runtime {action:stop} 停止插件 owned 实例，断言 state=stopped、pid 退出、
 *   adbd 端口关闭、无残留 emulator 进程；
 * - 脚本中途失败的兜底清理（先 POST stop，再 SIGKILL 自己的 pid）。
 */
import { assert, assertEqual, evidence } from './harness.mjs'
import { fetchJson, sleep } from './web-profile.mjs'
import {
  findEmulatorProcesses,
  isPidAlive,
  parseEndpointText,
  probeTcp,
} from './real-device-ops.mjs'

/** 插件 stop owned emulator：保存 quick-boot 快照 + SIGTERM 退出（实现上限 120s）。 */
const STOP_TIMEOUT_MS = 240_000
/** stop 后等 adbd 端口关闭的上限。 */
const PORT_CLOSE_TIMEOUT_MS = 30_000

/** GET /dsh-phone/api/runtime（生命周期快照）。 */
export async function readRuntimeInfo(origin, cookie) {
  const response = await fetchJson(origin + '/dsh-phone/api/runtime', { headers: { cookie } })
  assertEqual(response.response.status, 200, 'GET /runtime 必须 200')
  assertEqual(response.body?.ok, true, 'runtime ok=true')
  return response.body.value
}

/** POST /runtime {action:'stop'}（浏览器同源 cookie；agent token 禁止 stop）。 */
function requestStop(origin, cookie) {
  return fetchJson(origin + '/dsh-phone/api/runtime', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ action: 'stop' }),
    timeoutMs: 10_000,
  })
}

/** B 分支：stop owned emulator，断言进程退出 + 端口关闭 + 无残留进程。 */
export async function stopOwnedEmulator({ origin, cookie, endpointText, pid, avdName }) {
  const endpoint = parseEndpointText(endpointText)
  const startedAt = Date.now()
  const action = await requestStop(origin, cookie)
  assertEqual(action.response.status, 202, 'POST /runtime stop 必须 202')
  assertEqual(action.body?.ok, true, 'POST /runtime stop ok=true')

  let info
  const deadline = startedAt + STOP_TIMEOUT_MS
  while (Date.now() < deadline) {
    info = await readRuntimeInfo(origin, cookie)
    if (info.state === 'stopped' && info.running !== true) break
    await sleep(1000)
  }
  const stopMs = Date.now() - startedAt
  assert(
    info !== undefined && info.state === 'stopped' && info.running === false,
    '插件 stop owned emulator 后 state 必须 stopped（实际 state=' + info?.state +
      '，lastError=' + info?.lastError + '）',
  )
  if (pid !== undefined) {
    assert(!isPidAlive(pid), '插件 stop 后 emulator 进程 pid=' + pid + ' 必须已退出')
  }

  let reachable = true
  const closeDeadline = Date.now() + PORT_CLOSE_TIMEOUT_MS
  while (Date.now() < closeDeadline) {
    reachable = await probeTcp(endpoint.host, endpoint.port)
    if (!reachable) break
    await sleep(500)
  }
  assert(!reachable, 'stop 后 ' + endpointText + ' adbd 必须不可达（实际仍可达）')
  const leftovers = await findEmulatorProcesses(avdName)
  assertEqual(leftovers.length, 0, 'stop 后不得残留 emulator 进程: ' + JSON.stringify(leftovers))

  evidence(
    'stop',
    'POST /runtime stop → 202；state=stopped，' + (stopMs / 1000).toFixed(1) + 's；' +
      'pid ' + pid + ' 已退出；' + endpointText + ' 不可达；残留进程 0',
  )
  return {
    state: info.state,
    stopMs,
    pidGone: pid === undefined ? undefined : !isPidAlive(pid),
    portClosed: !reachable,
    leftoverProcesses: leftovers.length,
  }
}

/** 清理兜底：脚本中途失败时也要停掉插件自启的 owned emulator。 */
export function registerEmulatorSafetyCleanup(cleanup, state) {
  cleanup.register('B 分支兜底：停止插件自启的 owned emulator', async () => {
    if (state.stopped) return
    if (state.origin && state.cookie) {
      await requestStop(state.origin, state.cookie).catch(() => undefined)
      const deadline = Date.now() + 120_000
      while (Date.now() < deadline) {
        const current = await fetchJson(state.origin + '/dsh-phone/api/runtime', {
          headers: { cookie: state.cookie },
        }).catch(() => undefined)
        if (current?.body?.value?.state === 'stopped') {
          state.stopped = true
          break
        }
        await sleep(1000)
      }
    }
    if (!state.stopped && state.pid !== undefined && isPidAlive(state.pid)) {
      state.pidKilled = true
      try {
        process.kill(state.pid, 'SIGKILL')
      } catch {
        // 已退出
      }
    }
  })
}
