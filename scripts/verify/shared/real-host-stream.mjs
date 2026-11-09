/**
 * 真实 Host WS 视频流验收（issue #40）：探针握手 → 正式 viewer 收帧统计/控制。
 *
 * 探针（probeStreamHandshake）会用独立 WS 起一次流以拿到结构化 ready/error；
 * 关闭探针后必须等设备端 scrcpy-server 退出清理完成再建正式连接，否则会命中
 * `cleanup` 删 jar 与重连重叠的瞬态竞态（见 docs/verification.md §7.5）。
 */
import { assert, assertEqual, evidence } from './harness.mjs'
import { sleep } from './web-profile.mjs'
import { probeStreamHandshake, runStreamScenario } from './ws-stream.mjs'

/**
 * 瞬态竞态识别：scrcpy-server 3.3.x 启用 `cleanup`，退出时会删除设备上的
 * /data/local/tmp/scrcpy-server.jar；若上一个 viewer 刚断开、我们在其退出清理完成前
 * 立刻重连，就可能出现 server 启动时 jar 已被删 → ClassNotFound / "exited prematurely"。
 * 这是**重连过快的瞬态**（真实浏览器重连有退避），harness 先冷却再重试一次并如实记录。
 */
export function isTransientStreamStartRace(message) {
  return /E_STREAM_START_FAILED|exited prematurely|ClassNotFoundException/i.test(String(message))
}

/**
 * Host WS 视频流：握手/hello/ready → 收帧统计 → 控制 → 返回统计。
 * 握手失败时返回结构化 error（调用方继续跑 stream 层直连对照并归类缺陷）。
 */
export async function runHostStream({ origin, cookie, device }) {
  const handshake = await probeStreamHandshake({ origin, cookie, timeoutMs: 45_000 })
  if (!handshake.ok) {
    return {
      ok: false,
      error: handshake.error,
      texts: handshake.texts.map((message) => message.type),
      timeout: handshake.timeout === true,
      closed: handshake.closed === true,
    }
  }
  // 探针会话关闭 → 等设备端 server 退出清理，再建正式 viewer。
  await sleep(2500)
  let stream
  let retriedTransient = false
  let firstError
  try {
    stream = await runStreamScenario({ origin, cookie })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (!isTransientStreamStartRace(message)) throw error
    retriedTransient = true
    firstError = message
    evidence('host-stream-retry', '瞬态竞态（server 退出清理删 jar 与重连重叠）→ 冷却 2.5s 后重试：' + message)
    await sleep(2500)
    stream = await runStreamScenario({ origin, cookie })
  }
  assertEqual(stream.errorTexts.length, 0, 'WS 不得出现 error 文本帧: ' + JSON.stringify(stream.errorTexts))
  assertEqual(stream.socketErrors.length, 0, 'WS 不得出现 socket 错误: ' + JSON.stringify(stream.socketErrors))
  assertEqual(stream.invalidFrames, 0, 'WS 不得出现非 DPH1 二进制帧')
  assertEqual(stream.ready.codec, 'h264', 'ready.codec 必须是 h264')
  assert(stream.frameCount >= 3, '10s 内至少应收到 3 个 DPH1 视频帧，实际 ' + stream.frameCount)
  assert(stream.configurationFrames >= 1, '必须收到 configuration(SPS/PPS) 帧')
  assert(stream.keyFrames >= 1, '必须收到 keyframe 帧')
  if (stream.ready.deviceWidth !== undefined && device.width !== undefined) {
    assertEqual(stream.ready.deviceWidth, device.width, 'ready.deviceWidth 必须等于设备宽度')
    assertEqual(stream.ready.deviceHeight, device.height, 'ready.deviceHeight 必须等于设备高度')
  }
  assertEqual(stream.controlErrorCount, 0, '控制消息（key/touch/text）不得产生 error 帧')
  evidence(
    'host-stream',
    'ready codec=' + stream.ready.codec + ' ' + stream.ready.width + 'x' + stream.ready.height +
      '；' + stream.frameCount + ' 帧，config=' + stream.configurationFrames +
      ' key=' + stream.keyFrames + ' delta=' + stream.deltaFrames,
  )
  evidence('host-control', stream.controlSent.join(' / ') + ' → error 帧 0')
  return {
    ok: true,
    ready: stream.ready,
    frameCount: stream.frameCount,
    configurationFrames: stream.configurationFrames,
    keyFrames: stream.keyFrames,
    deltaFrames: stream.deltaFrames,
    observedMs: stream.observedMs,
    approxFps: stream.approxFps,
    controlSent: stream.controlSent,
    retriedTransient,
    ...(firstError ? { firstError } : {}),
  }
}
