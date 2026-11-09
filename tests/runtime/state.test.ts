import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  DEFAULT_LIFECYCLE_TIMINGS,
  PhoneLifecycle,
} from '../../src/phone/state.ts'
import type { LifecycleHooks, LifecycleStatus } from '../../src/phone/state.ts'
import { ManualClock } from '../fake-adb/runtime.ts'

interface Calls {
  start: number
  resume: number
  pause: number
  stop: number
  errors: string[]
}

function makeHooks(
  calls: Calls,
  overrides: Partial<LifecycleHooks> = {},
): LifecycleHooks {
  return {
    async start() {
      calls.start += 1
    },
    async pause() {
      calls.pause += 1
    },
    async resume() {
      calls.resume += 1
    },
    async stop() {
      calls.stop += 1
    },
    onError(error, phase) {
      calls.errors.push(`${phase}:${error.message}`)
    },
    ...overrides,
  }
}

function setup(
  hooksOverrides: Partial<LifecycleHooks> = {},
  timings = DEFAULT_LIFECYCLE_TIMINGS,
): {
  calls: Calls
  clock: ManualClock
  lifecycle: PhoneLifecycle
  states: string[]
  clockAdvance: (ms: number) => Promise<void>
} {
  const calls: Calls = { start: 0, resume: 0, pause: 0, stop: 0, errors: [] }
  const clock = new ManualClock()
  const lifecycle = new PhoneLifecycle(
    makeHooks(calls, hooksOverrides),
    timings,
    clock,
  )
  const states: string[] = []
  lifecycle.onChange((status: LifecycleStatus) => states.push(status.state))
  return {
    calls,
    clock,
    lifecycle,
    states,
    clockAdvance: (ms: number) => clock.advance(ms),
  }
}

describe('PhoneLifecycle：懒启动与 single-flight', () => {
  test('构造时不动外部资源，首次 ensureRunning 才 start', async () => {
    const { calls, lifecycle } = setup()
    assert.equal(lifecycle.state, 'stopped')
    assert.equal(calls.start, 0)
    await lifecycle.ensureRunning()
    assert.equal(calls.start, 1)
    assert.equal(lifecycle.state, 'running')
  })

  test('并发 ensureRunning 合并为一次启动（single-flight）', async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const { calls, lifecycle } = setup({
      async start() {
        calls.start += 1
        await gate
      },
    })
    const first = lifecycle.ensureRunning()
    const second = lifecycle.ensureRunning()
    const third = lifecycle.ensureRunning()
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(lifecycle.state, 'booting')
    assert.equal(lifecycle.status.bootMs, 0)
    release?.()
    await Promise.all([first, second, third])
    assert.equal(calls.start, 1)
    assert.equal(lifecycle.state, 'running')
  })

  test('启动失败 → 回到 stopped + lastError + 抛错', async () => {
    const { calls, lifecycle } = setup({
      async start() {
        calls.start += 1
        throw new Error('docker 不可用')
      },
    })
    await assert.rejects(lifecycle.ensureRunning(), /docker 不可用/)
    assert.equal(lifecycle.state, 'stopped')
    assert.match(lifecycle.status.lastError ?? '', /docker 不可用/)
    assert.equal(calls.errors.length, 1)
  })

  test('启动成功后清空 lastError（issue #44）', async () => {
    let failing = true
    const { lifecycle, calls } = setup({
      async start() {
        calls.start += 1
        if (failing) throw new Error('ADB 认证握手超时')
      },
    })
    await assert.rejects(lifecycle.ensureRunning(), /握手超时/)
    assert.equal(lifecycle.state, 'stopped')
    assert.match(lifecycle.status.lastError ?? '', /握手超时/)

    failing = false
    await lifecycle.ensureRunning()
    assert.equal(lifecycle.state, 'running')
    assert.equal(lifecycle.status.lastError, undefined)
  })

  test('启动超时 → 抛超时错误并回 stopped', async () => {
    const { lifecycle, clockAdvance } = setup(
      { start: () => new Promise<void>(() => undefined) },
      { ...DEFAULT_LIFECYCLE_TIMINGS, bootTimeoutMs: 1_000 },
    )
    const pending = lifecycle.ensureRunning()
    const assertion = assert.rejects(pending, /启动超时/)
    await clockAdvance(1_000)
    await assertion
    assert.equal(lifecycle.state, 'stopped')
  })
})

describe('PhoneLifecycle：idle / paused 分级休眠', () => {
  test('running 空闲 5min → paused（调用 pause）', async () => {
    const { lifecycle, calls, clockAdvance } = setup()
    await lifecycle.ensureRunning()
    await clockAdvance(DEFAULT_LIFECYCLE_TIMINGS.idleTimeoutMs - 1)
    assert.equal(lifecycle.state, 'running')
    await clockAdvance(1)
    assert.equal(calls.pause, 1)
    assert.equal(lifecycle.state, 'paused')
  })

  test('paused 空闲 30min → stopped（调用 stop）', async () => {
    const { lifecycle, calls, clockAdvance } = setup()
    await lifecycle.ensureRunning()
    await clockAdvance(DEFAULT_LIFECYCLE_TIMINGS.idleTimeoutMs)
    assert.equal(lifecycle.state, 'paused')
    await clockAdvance(DEFAULT_LIFECYCLE_TIMINGS.pausedTimeoutMs)
    assert.equal(calls.stop, 1)
    assert.equal(lifecycle.state, 'stopped')
  })

  test('交互重置 idle 计时（touch）', async () => {
    const { lifecycle, clockAdvance } = setup()
    await lifecycle.ensureRunning()
    const idle = DEFAULT_LIFECYCLE_TIMINGS.idleTimeoutMs
    await clockAdvance(idle - 60_000)
    lifecycle.touch()
    await clockAdvance(idle - 60_000)
    assert.equal(lifecycle.state, 'running')
    await clockAdvance(120_000)
    assert.equal(lifecycle.state, 'paused')
  })

  test('paused 时交互自动唤醒（resume）', async () => {
    const { lifecycle, calls, clockAdvance } = setup()
    await lifecycle.ensureRunning()
    await clockAdvance(DEFAULT_LIFECYCLE_TIMINGS.idleTimeoutMs)
    assert.equal(lifecycle.state, 'paused')
    lifecycle.touch()
    assert.equal(lifecycle.state, 'booting')
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(calls.resume, 1)
    assert.equal(lifecycle.state, 'running')
    assert.equal(clockAdvance !== undefined, true)
  })

  test('唤醒失败 → 回到 paused', async () => {
    const { lifecycle, clockAdvance } = setup({
      async resume() {
        throw new Error('unpause 失败')
      },
    })
    await lifecycle.ensureRunning()
    await clockAdvance(DEFAULT_LIFECYCLE_TIMINGS.idleTimeoutMs)
    await assert.rejects(lifecycle.ensureRunning(), /unpause 失败/)
    assert.equal(lifecycle.state, 'paused')
  })

  test('暂停失败 → 保持 running 并重排 idle', async () => {
    const { lifecycle, clockAdvance, calls } = setup({
      async pause() {
        calls.pause += 1
        throw new Error('pause 失败')
      },
    })
    await lifecycle.ensureRunning()
    await clockAdvance(DEFAULT_LIFECYCLE_TIMINGS.idleTimeoutMs)
    assert.equal(lifecycle.state, 'running')
    assert.equal(calls.errors.length, 1)
    // 重排后再次到点会再试一次
    await clockAdvance(DEFAULT_LIFECYCLE_TIMINGS.idleTimeoutMs)
    assert.equal(calls.pause, 2)
  })
})

describe('PhoneLifecycle：断连与订阅', () => {
  test('notifyDisconnected → stopped 并记录原因', async () => {
    const { lifecycle } = setup()
    await lifecycle.ensureRunning()
    lifecycle.notifyDisconnected('ADB 连接已断开')
    assert.equal(lifecycle.state, 'stopped')
    assert.match(lifecycle.status.lastError ?? '', /已断开/)
  })

  test('状态订阅收到 stopped→booting→running', async () => {
    const { lifecycle, states } = setup()
    await lifecycle.ensureRunning()
    assert.deepEqual(states, ['booting', 'running'])
  })

  test('dispose 清理定时器与订阅', async () => {
    const { lifecycle, clock } = setup()
    await lifecycle.ensureRunning()
    assert.ok(clock.pending > 0)
    await lifecycle.dispose()
    assert.equal(clock.pending, 0)
    await assert.rejects(lifecycle.ensureRunning(), /已释放/)
    assert.equal(lifecycle.state, 'running')
  })
})

describe('PhoneLifecycle：issue #72（booting 断连 / 超时取消）', () => {
  test('booting 期间断连：boot 成功后不得进入 running，返回可重试错误', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const { lifecycle, calls, states } = setup({
      async start() {
        calls.start += 1
        await gate
      },
    })
    const pending = lifecycle.ensureRunning()
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(lifecycle.state, 'booting')

    lifecycle.notifyDisconnected('ADB 连接已断开')
    assert.equal(lifecycle.state, 'stopped')

    release()
    await assert.rejects(pending, (error: unknown) => {
      assert.match((error as Error).message, /已断开/)
      assert.equal((error as { retryable?: boolean }).retryable, true)
      return true
    })
    assert.equal(lifecycle.state, 'stopped')
    assert.ok(!states.includes('running'), '不得出现 running（无连接的假 running）')
    assert.match(lifecycle.status.lastError ?? '', /已断开/)
  })

  test('boot 超时：先等待 cancelBoot 落地，之后才抛超时错误', async () => {
    const order: string[] = []
    let releaseCancel!: () => void
    const cancelGate = new Promise<void>((resolve) => {
      releaseCancel = resolve
    })
    const { lifecycle, clockAdvance } = setup(
      {
        start: () => {
          order.push('start')
          return new Promise<void>(() => undefined)
        },
        async cancelBoot() {
          order.push('cancel:begin')
          await cancelGate
          order.push('cancel:end')
        },
      },
      { ...DEFAULT_LIFECYCLE_TIMINGS, bootTimeoutMs: 1_000 },
    )
    const pending = lifecycle.ensureRunning()
    const assertion = assert.rejects(pending, /启动超时/)
    await clockAdvance(1_000)
    await new Promise<void>((resolve) => setImmediate(resolve))
    // 超时后状态机仍在等 cancelBoot 落地，尚未 reject
    assert.deepEqual(order, ['start', 'cancel:begin'])

    releaseCancel()
    await assertion
    assert.deepEqual(order, ['start', 'cancel:begin', 'cancel:end'])
    assert.equal(lifecycle.state, 'stopped')
  })

  test('默认 boot 预算覆盖 adapter 等待 120s + connect 重试 100s', () => {
    assert.ok(
      DEFAULT_LIFECYCLE_TIMINGS.bootTimeoutMs >= 240_000,
      '默认 bootTimeoutMs 必须 >= 240s（issue #72 预算对齐）',
    )
  })
})
