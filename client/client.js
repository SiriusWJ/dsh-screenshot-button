/**
 * dsh-screenshot-button — Client half.
 *
 * 在输入面板下方的 composer 工具行（conversation.input.left）注册一个截图按钮：
 * 点击 → POST /dsh-screenshot/capture → 宿主进程调起系统截图工具；
 * 框选完成后图片在系统剪贴板里，回到输入框 Ctrl+V 即可粘贴成图片附件。
 *
 * 只依赖浏览器模块表里的 react，不额外安装依赖，也不改 DSH 自身的 DOM。
 */
window.__ModuleLoader__.load({
  id: 'dsh-screenshot-button',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** 宿主路由：由 lib/index.js 注册。 */
    const ENDPOINT = '/dsh-screenshot/capture'

    /** 按钮 / 提示文案（跟随页面 html lang，与 dsh-capture 等插件同一套做法）。 */
    const STRINGS = {
      zh: {
        button: '截图',
        tooltip: '调用系统截图工具，框选后按 Ctrl+V 粘贴到输入框',
        opened: '已打开系统截图工具，框选后按 Ctrl+V 粘贴',
        cooldown: '截图工具刚刚已经打开过了，稍等一下再点',
        failed: '截图工具启动失败：',
        unsupported: '当前系统没有可用的截图工具',
        localOnly: '截图按钮只在本机 DSH 页面可用',
      },
      en: {
        button: 'Capture',
        tooltip: 'Open the system screenshot tool, then press Ctrl+V in the composer to paste it',
        opened: 'System screenshot tool opened — press Ctrl+V to paste the shot',
        cooldown: 'The screenshot tool was just opened; please wait a moment',
        failed: 'Failed to open the screenshot tool: ',
        unsupported: 'No system screenshot tool is available on this platform',
        localOnly: 'The capture button only works in the local DSH page',
      },
    }

    /** 取当前语言文案。 */
    function localeStrings() {
      const lang = typeof document === 'undefined' ? 'zh' : document.documentElement.lang || 'zh'
      return lang.toLowerCase().startsWith('zh') ? STRINGS.zh : STRINGS.en
    }

    /** 按钮与提示的样式；颜色全部走主题 token，亮/暗色都跟随宿主。 */
    const CSS = [
      '.dshsb-root{position:relative;display:inline-flex;align-items:center}',
      '.dshsb-btn{display:grid;place-items:center;width:26px;height:26px;padding:0;border:0;border-radius:999px;',
      'background:transparent;color:var(--dsw-alias-label-secondary,#8a8f98);cursor:pointer;flex:none;',
      'transition:background-color .15s ease,color .15s ease}',
      '.dshsb-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-solid,rgba(127,127,127,.16));',
      'color:var(--dsw-alias-label-primary,#e6e8ea)}',
      '.dshsb-btn:active:not(:disabled){background:var(--dsw-alias-interactive-bg-pressed,rgba(127,127,127,.26))}',
      '.dshsb-btn:disabled{opacity:.45;cursor:default}',
      '.dshsb-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#3b82f6);outline-offset:2px}',
      '.dshsb-toast{position:fixed;left:50%;bottom:96px;transform:translateX(-50%);z-index:9999;',
      'max-width:min(70vw,560px);padding:7px 14px;border-radius:9px;',
      'background:var(--dsw-alias-bg-overlay,#1f242c);color:var(--dsw-alias-label-primary,#f2f3f5);',
      'border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.12));box-shadow:0 6px 24px rgba(0,0,0,.24);',
      'font-size:13px;line-height:20px;pointer-events:none;animation:dshsb-fade .16s ease-out}',
      '.dshsb-toast[data-error="true"]{color:var(--dsw-alias-state-error-primary,#ff6b6b);',
      'border-color:var(--dsw-alias-state-error-primary,#ff6b6b)}',
      '@keyframes dshsb-fade{from{opacity:0;transform:translate(-50%,4px)}to{opacity:1;transform:translate(-50%,0)}}',
    ].join('')

    /** 注入样式（重复注入时复用已有标签）；返回清理函数。 */
    function installStyles() {
      const marker = 'dsh-screenshot-button'
      const existing = document.querySelector(`style[data-plugin-css="${marker}"]`)
      if (existing) return () => existing.remove()
      const tag = document.createElement('style')
      tag.dataset.plugin = marker
      tag.dataset.pluginCss = marker
      tag.textContent = CSS
      document.head.appendChild(tag)
      return () => tag.remove()
    }

    /** 相机图标（currentColor，随主题变色）。 */
    function IconCamera() {
      return h(
        'svg',
        {
          viewBox: '0 0 16 16',
          width: 15,
          height: 15,
          fill: 'none',
          'aria-hidden': true,
          style: { display: 'block' },
        },
        h('path', {
          d: 'M5.24 3.2a.6.6 0 0 1 .5-.27h4.52a.6.6 0 0 1 .5.27l.74 1.07h1.02c.75 0 1.36.6 1.36 1.35v6.3c0 .75-.6 1.36-1.36 1.36H3.48c-.75 0-1.36-.6-1.36-1.36v-6.3c0-.75.6-1.36 1.36-1.36h1.02L5.24 3.2Z',
          stroke: 'currentColor',
          strokeWidth: 1.2,
          strokeLinejoin: 'round',
        }),
        h('circle', {
          cx: 8,
          cy: 8.6,
          r: 2.5,
          stroke: 'currentColor',
          strokeWidth: 1.2,
        }),
        h('circle', { cx: 11.6, cy: 5.7, r: 0.65, fill: 'currentColor' }),
      )
    }

    /** 截图按钮：点击后请求宿主调起系统截图工具。 */
    function ScreenshotButton() {
      const [busy, setBusy] = React.useState(false)
      const [toast, setToast] = React.useState(null)
      const timerRef = React.useRef(0)

      React.useEffect(
        () => () => {
          window.clearTimeout(timerRef.current)
        },
        [],
      )

      const showToast = React.useCallback((text, error) => {
        setToast({ text, error: Boolean(error) })
        window.clearTimeout(timerRef.current)
        timerRef.current = window.setTimeout(() => setToast(null), 3000)
      }, [])

      const onClick = React.useCallback(async () => {
        if (busy) return
        setBusy(true)
        try {
          const response = await fetch(ENDPOINT, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}',
          })
          let payload = null
          try {
            payload = await response.json()
          } catch {
            payload = null
          }
          if (response.ok && payload && payload.ok === true) {
            showToast(localeStrings().opened)
          } else if (response.status === 429) {
            showToast(localeStrings().cooldown)
          } else if (response.status === 403) {
            showToast(localeStrings().localOnly, true)
          } else if (response.status === 503) {
            showToast(localeStrings().unsupported, true)
          } else {
            const message = payload && payload.error && payload.error.message ? payload.error.message : `HTTP ${response.status}`
            throw new Error(message)
          }
        } catch (error) {
          const message = error && error.message ? error.message : String(error)
          showToast(localeStrings().failed + message, true)
        } finally {
          setBusy(false)
        }
      }, [busy, showToast])

      const t = localeStrings()
      return h(
        'div',
        { className: 'dshsb-root' },
        h(
          'button',
          {
            type: 'button',
            className: 'dshsb-btn',
            title: t.tooltip,
            'aria-label': t.tooltip,
            disabled: busy,
            'aria-busy': busy ? 'true' : 'false',
            onClick,
          },
          h(IconCamera),
        ),
        toast ? h('div', { className: 'dshsb-toast', 'data-error': toast.error ? 'true' : 'false', role: 'status' }, toast.text) : null,
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.effect(() => installStyles(), 'dsh-screenshot-button: styles')
        ctx.slots.inject('conversation.input.left', () =>
          ctx.slots.register(
            {
              name: 'conversation.input.left',
              id: 'dsh-screenshot-button',
              order: 0,
              label: () => localeStrings().button,
            },
            ScreenshotButton,
          ),
        )
      },
    }
  },
})
