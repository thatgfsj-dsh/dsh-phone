/** WS 客户端消息解析的 issue #72 补充用例：key 名与 AdbDevice 同一字符白名单。 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { parseClientMessage } from '../../src/stream/ws-messages.ts'

test('issue #72：WS key 名拒绝 shell 元字符/空白', () => {
  for (const name of [
    'KEYCODE_HOME; reboot',
    'HOME;reboot',
    'HOME && rm -rf /',
    'HOME|id',
    'HOME\nreboot',
    'KEYCODE_HOME\t',
    'x'.repeat(65),
  ]) {
    const result = parseClientMessage(JSON.stringify({ type: 'key', name }))
    assert.equal(result.ok, false, '非法 key 名必须被拒绝: ' + JSON.stringify(name))
    if (!result.ok) assert.match(result.reason, /只允许字母/)
  }
})

test('issue #72：WS key 名合法形式照旧通过（映射名/全名/数字）', () => {
  for (const name of ['HOME', 'keycode_home', '66', 'KEYCODE_VOLUME_UP']) {
    const result = parseClientMessage(JSON.stringify({ type: 'key', name }))
    assert.equal(result.ok, true, '合法 key 名不应被拒绝: ' + name)
  }
})
