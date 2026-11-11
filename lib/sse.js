/**
 * SSE 传输层：把 AsyncIterable<{event,data}> 写成事件流。
 *
 * 为什么单独一层：
 *   - HTTP 请求对象和业务 generator 的生命周期要严丝合缝：客户端一断开就必须 abort，
 *     否则模型流还会继续消耗 token；
 *   - 心跳是给中间代理看的（`Connection: keep-alive` + 定时注释行），避免长回答被代理判死；
 *   - 业务 generator 里的异常不能甩给 HTTP 层（那时响应头已经发出去了），要转成
 *     `error` + `end` 两个事件。
 */

const SSE_HEADERS = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-store',
  'Connection': 'keep-alive',
  'X-Accel-Buffering': 'no',
}

const PING = ': ping\n\n'

function messageOf(error) {
  return error && error.message ? error.message : String(error)
}

/**
 * 把异步事件流转成 SSE 响应。
 *
 * iterable 可以是 AsyncIterable，也可以是 `(signal) => AsyncIterable`。
 * 推荐传函数：`pipeSse(req, res, (signal) => ai.translate(body, { signal }))`，
 * 这样客户端断开时真正能中断模型流；传现成 iterable 时只能停止消费并调用 return()。
 *
 * options:
 *   - heartbeatMs：心跳间隔，默认 15000ms；
 *   - signal：外部已有信号（例如 lead 在路由层建的 controller），断开时一并 abort。
 */
export async function pipeSse(req, res, iterable, options = {}) {
  const heartbeatMs = Number(options.heartbeatMs) > 0 ? Number(options.heartbeatMs) : 15000
  const external = options.signal || null
  const controller = new AbortController()
  const signal = controller.signal

  let closed = false
  let ended = false
  let resolveClose
  const closePromise = new Promise((resolve) => {
    resolveClose = resolve
  })

  const markClosed = () => {
    if (closed) return
    closed = true
    if (!signal.aborted) controller.abort()
    resolveClose('closed')
  }
  // Node 16+ 的 IncomingMessage 在 POST body 读完时也会触发 'close'（并不代表客户端跑了），
  // 所以必须看 socket 是否真的销毁；真正的断连还有 res 'close' 兜底。
  const onRequestClose = () => {
    if (req.socket && req.socket.destroyed) markClosed()
    else if (!req.complete) markClosed()
  }
  // 外部取消（例如 lead 路由层主动 abort）只打断底层模型流，不停止转发：
  // ai.translate/chat 收到 abort 后会自己发 end{aborted:true}，这里继续读完即可。
  const onExternalAbort = () => {
    if (!signal.aborted) controller.abort()
  }

  if (external) {
    if (external.aborted) onExternalAbort()
    else if (typeof external.addEventListener === 'function') {
      external.addEventListener('abort', onExternalAbort, { once: true })
    }
  }
  req.on('close', onRequestClose)
  res.on('close', markClosed)
  res.on('error', markClosed)

  try {
    res.writeHead(200, SSE_HEADERS)
    if (typeof res.flushHeaders === 'function') res.flushHeaders()
  } catch {
    markClosed()
    return
  }

  const write = (chunk) => {
    if (closed) return false
    try {
      res.write(chunk)
      return true
    } catch {
      markClosed()
      return false
    }
  }

  const send = (event, data) => {
    if (event === 'end') ended = true
    return write('event: ' + event + '\ndata: ' + JSON.stringify(data === undefined ? {} : data) + '\n\n')
  }

  const pingTimer = setInterval(() => write(PING), heartbeatMs)
  if (typeof pingTimer.unref === 'function') pingTimer.unref()

  let iterator = null
  try {
    const source = typeof iterable === 'function' ? iterable(signal) : iterable
    iterator = source[Symbol.asyncIterator]()
    for (;;) {
      if (closed) break
      const pending = iterator.next()
      // 连接可能在 next() 悬着的时候断开：放弃这次等待，也不让它变成未处理的 rejection
      pending.catch(() => {})
      const result = await Promise.race([pending, closePromise])
      if (result === 'closed' || result === 'aborted' || closed) break
      if (result.done) break
      const value = result.value
      if (!value) continue
      const event = String(value.event || value.type || 'message')
      send(event, value.data === undefined ? value : value.data)
    }
  } catch (error) {
    if (!closed) {
      send('error', { message: messageOf(error) })
      send('end', { ok: false, aborted: signal.aborted })
    }
  } finally {
    clearInterval(pingTimer)
    req.removeListener('close', onRequestClose)
    res.removeListener('close', markClosed)
    res.removeListener('error', markClosed)
    if (external && typeof external.removeEventListener === 'function') {
      external.removeEventListener('abort', onExternalAbort)
    }
    if (iterator && typeof iterator.return === 'function') {
      try {
        const closing = iterator.return()
        // 已经断开时 generator 可能正卡在 await 上，return() 会一直悬着，别等了
        if (closed) closing.catch(() => {})
        else await closing
      } catch {
        /* 迭代器已结束或拒绝：不再处理 */
      }
    }
    if (!signal.aborted) controller.abort()
    if (!closed) {
      // 业务 generator 正常路径已经发过 end；这里只兜底没有 end 的迭代器
      if (!ended) send('end', { ok: true })
      try {
        res.end()
      } catch {
        /* 连接已断 */
      }
    } else {
      try {
        res.end()
      } catch {
        /* 连接已断 */
      }
    }
  }
}

/**
 * 非流式错误的兜底响应：路由在开始 SSE 之前（参数校验、没有模型、缺文档）用它。
 * 如果已经把头发出去（headersSent），就不能改状态码了，只能补一帧 error + end。
 */
export function sseError(res, status, message) {
  const text = String(message === undefined || message === null ? '服务内部错误' : message)
  if (res && res.headersSent) {
    try {
      res.write('event: error\ndata: ' + JSON.stringify({ message: text }) + '\n\n')
      res.write('event: end\ndata: ' + JSON.stringify({ ok: false }) + '\n\n')
    } catch {
      /* 连接已断 */
    }
    try {
      res.end()
    } catch {
      /* 连接已断 */
    }
    return
  }
  try {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    })
    res.end(JSON.stringify({ ok: false, error: text }))
  } catch {
    /* 连接已断 */
  }
}
