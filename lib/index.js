/**
 * dsh-screenshot-button — Host half.
 *
 * 浏览器里点一下输入面板下方的截图按钮，客户端 POST 到本插件的路由，
 * 宿主进程（DSH Web / Desktop 都可以）再调起操作系统自带的截图工具：
 *
 *   Windows : ms-screenclip: 协议 → Windows「截图工具」/ 截图和草图覆盖层
 *   macOS   : /usr/sbin/screencapture -i -c → 交互框选，结果进剪贴板
 *   Linux   : gnome-screenshot / spectacle / scrot+wl-copy 等常见工具
 *
 * 截图结果由系统工具负责放进剪贴板，用户回到输入框按 Ctrl+V（macOS ⌘V）
 * 即可作为图片附件粘贴进 composer。
 *
 * 安全边界：路由只接受本机回环 Host 的 POST，且拒绝跨站请求；无法在浏览器
 * 里跨源触发本机弹窗。所有资源都通过 ctx.effect 注册，插件停用即自动清理。
 */

import { spawn } from 'node:child_process'

/** Plugin identity for cordis.yml rows. */
export const name = 'dsh-screenshot-button'

/** 路由挂在 Web 服务器的 /dsh-screenshot 前缀下。 */
export const inject = ['webServer']

/** 路由前缀（客户端 client.js 使用同一常量）。 */
const ROUTE_BASE = '/dsh-screenshot'
const ROUTE_CAPTURE = `${ROUTE_BASE}/capture`
const ROUTE_HEALTH = `${ROUTE_BASE}/health`

/** 两次触发之间的最小间隔，避免连点叠开多个截图工具窗口。 */
const COOLDOWN_MS = 800

/** 子进程 spawn 后观察多久：这段时间内没有 error 事件就算启动成功。 */
const SPAWN_PROBE_MS = 300

/** 各平台优先使用的系统截图入口（按顺序尝试，第一个不报错即采用）。 */
const LAUNCHERS = {
  win32: [
    {
      label: 'Windows 截图工具 (ms-screenclip:)',
      command: 'cmd.exe',
      args: ['/d', '/c', 'start', '', 'ms-screenclip:'],
    },
    {
      label: 'Snipping Tool',
      command: 'SnippingTool.exe',
      args: [],
    },
  ],
  darwin: [
    {
      label: 'macOS 截屏 (screencapture -i -c)',
      command: '/usr/sbin/screencapture',
      args: ['-i', '-c'],
    },
  ],
  linux: [
    {
      label: 'GNOME 截图 (gnome-screenshot -i -c)',
      command: 'gnome-screenshot',
      args: ['-i', '-c'],
    },
    {
      label: 'Spectacle (spectacle -r -c)',
      command: 'spectacle',
      args: ['-r', '-c'],
    },
    {
      label: 'scrot + wl-copy / xclip',
      command: 'sh',
      args: [
        '-c',
        'export file="$(mktemp --suffix=.png)"; ' +
          'if command -v scrot >/dev/null 2>&1 && scrot -s "$file"; then ' +
          '(command -v wl-copy >/dev/null 2>&1 && wl-copy --type image/png < "$file") || ' +
          '(command -v xclip >/dev/null 2>&1 && xclip -selection clipboard -t image/png -i "$file"); ' +
          'else exit 1; fi',
      ],
    },
  ],
}

/** 最近一次成功触发的时间戳，用于节流。 */
let lastLaunchAt = 0

/** 当前平台可用的截图入口列表。 */
function platformLaunchers() {
  return LAUNCHERS[process.platform] ?? []
}

/** 把任意异常压成 { message } 形状，避免把堆栈塞进响应。 */
function reasonOf(error) {
  if (error instanceof Error) return { code: error.name || 'error', message: error.message }
  return { code: 'error', message: String(error) }
}

/** 写回 JSON 响应。 */
function writeJson(response, status, body) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  response.end(JSON.stringify(body))
}

/** 请求头里可能缺失某个字段。 */
function headerOf(request, name) {
  const value = request.headers[name]
  return typeof value === 'string' ? value : undefined
}

/** 该 authority 是否指向本机回环地址。 */
function isLoopbackAuthority(authority) {
  try {
    const hostname = new URL(`http://${authority}`).hostname
    if (hostname === 'localhost' || hostname === '[::1]') return true
    const parts = hostname.split('.')
    return parts.length === 4 && parts[0] === '127' && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
  } catch {
    return false
  }
}

/**
 * 本机页面才有权调起本机截图工具。
 * Host 必须是回环地址，拒绝跨站请求，若带 Origin 则必须与 Host 同源。
 */
function isTrusted(request) {
  const host = headerOf(request, 'host')
  if (host === undefined || !isLoopbackAuthority(host)) return false
  if (headerOf(request, 'sec-fetch-site') === 'cross-site') return false
  const origin = headerOf(request, 'origin')
  if (origin === undefined) return true
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

/**
 * 启动一条系统截图命令。
 * 用 detached + unref 让截图工具独立于 DSH 进程存活；
 * spawn 的错误是异步事件，所以等一个短探测窗口再判定成功。
 */
function tryLaunch(launcher) {
  return new Promise((resolve) => {
    let settled = false
    let timer = 0
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    let child
    try {
      child = spawn(launcher.command, launcher.args, {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      })
    } catch (error) {
      finish({ ok: false, reason: reasonOf(error) })
      return
    }
    child.once('error', (error) => finish({ ok: false, reason: reasonOf(error) }))
    timer = setTimeout(() => {
      try {
        child.unref()
      } catch {
        /* 进程已退出时 unref 会抛，忽略即可 */
      }
      finish({ ok: true, value: { tool: launcher.label } })
    }, SPAWN_PROBE_MS)
  })
}

/** 按平台顺序尝试启动系统截图工具。 */
async function launchSystemCapture() {
  const launchers = platformLaunchers()
  if (launchers.length === 0) {
    return {
      ok: false,
      reason: {
        code: 'unsupported-platform',
        message: `no system screenshot launcher for platform "${process.platform}"`,
      },
    }
  }
  const failures = []
  for (const launcher of launchers) {
    const attempt = await tryLaunch(launcher)
    if (attempt.ok) return attempt
    failures.push(`${launcher.command}: ${attempt.reason.message}`)
  }
  return {
    ok: false,
    reason: { code: 'launch-failed', message: failures.join('; ') },
  }
}

/** GET /dsh-screenshot/health — 探测宿主能力（平台 + 可用的截图入口）。 */
function handleHealth(response) {
  writeJson(response, 200, {
    ok: true,
    value: {
      platform: process.platform,
      launchers: platformLaunchers().map((launcher) => launcher.label),
    },
  })
}

/** POST /dsh-screenshot/capture — 调起系统截图工具。 */
async function handleCapture(response) {
  const now = Date.now()
  if (now - lastLaunchAt < COOLDOWN_MS) {
    writeJson(response, 429, {
      ok: false,
      error: { code: 'cooldown', message: 'the screenshot tool was opened a moment ago' },
    })
    return
  }
  lastLaunchAt = now
  const result = await launchSystemCapture()
  if (!result.ok) {
    writeJson(response, 503, { ok: false, error: result.reason })
    return
  }
  writeJson(response, 200, {
    ok: true,
    value: { tool: result.value.tool, platform: process.platform },
  })
}

/** 路由总入口。 */
async function handleRoute(request, response) {
  let pathname
  try {
    pathname = new URL(request.url ?? ROUTE_BASE, 'http://dsh.internal').pathname
  } catch {
    pathname = ''
  }
  if (!isTrusted(request)) {
    writeJson(response, 403, { ok: false, error: { code: 'forbidden', message: 'forbidden' } })
    return
  }
  if (pathname === ROUTE_HEALTH) {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      writeJson(response, 405, { ok: false, error: { code: 'method-not-allowed', message: 'GET only' } })
      return
    }
    handleHealth(response)
    return
  }
  if (pathname === ROUTE_CAPTURE) {
    if (request.method !== 'POST') {
      writeJson(response, 405, { ok: false, error: { code: 'method-not-allowed', message: 'POST only' } })
      return
    }
    await handleCapture(response)
    return
  }
  writeJson(response, 404, { ok: false, error: { code: 'not-found', message: 'unknown route' } })
}

/**
 * Plugin body：注册截图路由。
 * @param ctx - 宿主插件上下文（已声明 webServer 依赖）。
 */
export function apply(ctx) {
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: ROUTE_BASE,
        handler: (request, response) => {
          handleRoute(request, response).catch((error) => {
            try {
              writeJson(response, 500, { ok: false, error: reasonOf(error) })
            } catch {
              /* 响应已结束则忽略 */
            }
          })
        },
      }),
    'dsh-screenshot-button: /dsh-screenshot routes',
  )
}
