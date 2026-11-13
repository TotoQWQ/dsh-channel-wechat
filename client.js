/**
 * 微信通道面板（Web GUI）。
 *
 * 左侧栏「微信」图标 → 主区域面板：
 *   - 多账号列表（状态、最近错误、重扫码、断开）
 *   - 扫码登录区（二维码 / 数字配对码）
 *   - 微信 chat ↔ DSH 会话 绑定表（双向镜像）
 * 数据通过插件自己注册的 /wechat-channel/* HTTP 接口读取。
 */

window.__ModuleLoader__.load({
  id: 'dsh-channel-wechat',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const API = '/wechat-channel'

    async function call(path, init) {
      const res = await fetch(API + path, { cache: 'no-store', ...init })
      const text = await res.text()
      try {
        return JSON.parse(text)
      } catch {
        return { ok: false, error: text.slice(0, 200) || `HTTP ${res.status}` }
      }
    }

    const STATUS_TEXT = {
      idle: '未开始',
      waiting: '等待扫码',
      scaned: '已扫码，正在确认',
      need_verifycode: '需要输入手机上的数字',
      confirmed: '已连接',
      expired: '二维码已过期',
      error: '出错了',
      unsupported: '该微信号已绑定其它实例',
    }

    const TONE = {
      idle: '#8a8a8a',
      waiting: '#c08a00',
      scaned: '#c08a00',
      need_verifycode: '#c08a00',
      confirmed: '#1f9d55',
      expired: '#c08a00',
      error: '#d64545',
      unsupported: '#d64545',
    }

    const styles = {
      root: { height: '100%', overflowY: 'auto', padding: '28px 32px 48px', color: 'inherit', fontSize: 13, lineHeight: 1.6 },
      head: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 18, flexWrap: 'wrap' },
      title: { fontSize: 18, fontWeight: 600, margin: 0 },
      badge: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '2px 10px',
        borderRadius: 999,
        border: '1px solid currentColor',
        fontSize: 12,
      },
      dot: { width: 7, height: 7, borderRadius: '50%' },
      card: {
        border: '1px solid rgba(127,127,127,.28)',
        borderRadius: 12,
        padding: '16px 18px',
        marginBottom: 18,
      },
      cardTitle: { fontSize: 13, fontWeight: 600, margin: '0 0 12px' },
      muted: { opacity: 0.6, fontSize: 12 },
      actions: { display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' },
      button: {
        appearance: 'none',
        cursor: 'pointer',
        fontSize: 12,
        padding: '5px 12px',
        borderRadius: 8,
        border: '1px solid rgba(127,127,127,.42)',
        background: 'transparent',
        color: 'inherit',
      },
      primary: { borderColor: 'rgba(31,157,85,.7)', color: '#1f9d55' },
      danger: { borderColor: 'rgba(214,69,69,.55)', color: '#d64545' },
      disabled: { opacity: 0.45, cursor: 'not-allowed' },
      table: { width: '100%', borderCollapse: 'collapse', fontSize: 12 },
      th: {
        textAlign: 'left',
        fontWeight: 500,
        opacity: 0.62,
        padding: '6px 8px',
        borderBottom: '1px solid rgba(127,127,127,.28)',
        whiteSpace: 'nowrap',
      },
      td: { padding: '7px 8px', borderBottom: '1px dashed rgba(127,127,127,.16)', verticalAlign: 'middle' },
      mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' },
      select: {
        fontSize: 12,
        padding: '4px 6px',
        borderRadius: 6,
        border: '1px solid rgba(127,127,127,.42)',
        background: 'transparent',
        color: 'inherit',
        maxWidth: 260,
      },
      qrWrap: { display: 'flex', gap: 20, alignItems: 'flex-start', flexWrap: 'wrap' },
      qr: {
        width: 220,
        height: 220,
        imageRendering: 'pixelated',
        borderRadius: 8,
        background: '#fff',
        padding: 6,
      },
      input: {
        fontSize: 13,
        padding: '6px 10px',
        borderRadius: 8,
        border: '1px solid rgba(127,127,127,.42)',
        background: 'transparent',
        color: 'inherit',
        width: 110,
        textAlign: 'center',
        letterSpacing: 2,
      },
      error: { marginTop: 10, color: '#d64545', fontSize: 12, overflowWrap: 'anywhere' },
      empty: { opacity: 0.6, fontSize: 12, padding: '8px 0' },
      row: {
        display: 'flex',
        justifyContent: 'space-between',
        gap: 16,
        padding: '4px 0',
        borderBottom: '1px dashed rgba(127,127,127,.16)',
      },
      label: { opacity: 0.62 },
      value: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: 12 },
    }

    function Badge(props) {
      const tone = TONE[props.status] ?? '#8a8a8a'
      return h(
        'span',
        { style: { ...styles.badge, color: tone } },
        h('span', { style: { ...styles.dot, background: tone } }),
        props.children ?? STATUS_TEXT[props.status] ?? '未知',
      )
    }

    function WechatIcon(props) {
      const size = props.size || 18
      return h(
        'svg',
        {
          viewBox: '0 0 24 24',
          width: size,
          height: size,
          fill: 'none',
          'aria-hidden': true,
          style: { display: 'block', opacity: props.active ? 1 : 0.82 },
        },
        h('path', {
          d: 'M4.6 3.5h11.2a3.4 3.4 0 0 1 3.4 3.4v5.6a3.4 3.4 0 0 1-3.4 3.4H10l-4.4 3v-3H4.6a3.4 3.4 0 0 1-3.4-3.4V6.9a3.4 3.4 0 0 1 3.4-3.4Z',
          fill: 'currentColor',
        }),
        h('circle', { cx: 8.4, cy: 9.7, r: 1.35, fill: 'var(--dsh-sidebar-bg, #fff)' }),
        h('circle', { cx: 13.2, cy: 9.7, r: 1.35, fill: 'var(--dsh-sidebar-bg, #fff)' }),
      )
    }

    function WechatPanel(props) {
      const ctx = props.ctx
      const [state, setState] = React.useState(null)
      const [sessions, setSessions] = React.useState([])
      const [draft, setDraft] = React.useState({})
      const [busy, setBusy] = React.useState('')
      const [error, setError] = React.useState('')
      const [code, setCode] = React.useState('')
      const [defaultDraft, setDefaultDraft] = React.useState(undefined)
      const sigRef = React.useRef('')
      const inflightRef = React.useRef(false)

      const load = React.useCallback(async (force) => {
        if (inflightRef.current) return
        if (!force && typeof document !== 'undefined' && document.visibilityState === 'hidden') return
        inflightRef.current = true
        try {
          const next = await call('/status')
          if (next && !next.error) {
            // 只在内容真的变了才 setState，避免每 3 秒整表重渲染
            const sig = JSON.stringify(next)
            if (force || sig !== sigRef.current) {
              sigRef.current = sig
              setState(next)
            }
            setError('')
          } else {
            setError(next?.error || '无法读取状态')
          }
        } catch (err) {
          setError(String((err && err.message) || err))
        } finally {
          inflightRef.current = false
        }
      }, [])

      const loadSessions = React.useCallback(async () => {
        try {
          const value = await call('/sessions')
          if (Array.isArray(value?.items)) setSessions(value.items)
        } catch {
          /* ignore */
        }
      }, [])

      React.useEffect(() => {
        void load(true)
        void loadSessions()
        // 会话列表只在打开/手动刷新时拉：它要读全部会话，定时拉会拖慢整个 GUI
        const timer = setInterval(() => void load(false), 3000)
        const onVisible = () => {
          if (document.visibilityState === 'visible') void load(true)
        }
        document.addEventListener('visibilitychange', onVisible)
        return () => {
          clearInterval(timer)
          document.removeEventListener('visibilitychange', onVisible)
        }
      }, [load, loadSessions])

      const act = React.useCallback(
        async (name, path, body) => {
          setBusy(name)
          setError('')
          try {
            const result = await call(path, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(body || {}),
            })
            if (result && result.error) setError(result.error)
            else if (result && result.ok === false && result.message) setError(result.message)
            await load(true)
            await loadSessions()
            return result
          } catch (err) {
            setError(String((err && err.message) || err))
            return null
          } finally {
            setBusy('')
          }
        },
        [load, loadSessions],
      )

      const login = (state && state.login) || {}
      const accounts = (state && state.accounts) || []
      const bindings = (state && state.bindings) || []
      const defaultSession = (state && state.settings && state.settings.defaultSessionId) || ''
      const showQr = ['waiting', 'scaned', 'need_verifycode', 'expired'].includes(login.status)

      const openSession = (sessionId) => {
        try {
          ctx.uiWorkspace.openSession(sessionId)
        } catch (err) {
          setError(String((err && err.message) || err))
        }
      }

      const sessionLabel = (item) => {
        const title = item.title || item.id
        return `${title} · ${item.id.slice(-8)}`
      }

      return h(
        'div',
        { style: styles.root },

        h(
          'div',
          { style: styles.head },
          h('h1', { style: styles.title }, '微信 ClawBot 通道'),
          h(Badge, {
            status: accounts.length > 0 ? 'confirmed' : login.status,
            children: accounts.length > 0 ? `${accounts.length} 个账号在线` : STATUS_TEXT[login.status],
          }),
          h('span', { style: styles.muted }, state?.mirror?.running ? '双向镜像运行中' : '镜像未运行'),
          h(
            'div',
            { style: { marginLeft: 'auto', ...styles.actions } },
            h(
              'button',
              {
                style: { ...styles.button, ...styles.primary },
                disabled: busy === 'add',
                onClick: () => void act('add', '/login', { force: true }),
              },
              '新增账号',
            ),
            h('button', { style: styles.button, onClick: () => { void load(true); void loadSessions() } }, '刷新'),
          ),
        ),

        showQr
          ? h(
              'div',
              { style: styles.card },
              h(
                'h2',
                { style: styles.cardTitle },
                login.replacingAccountId ? '重新扫码（替换账号）' : '新增账号：扫码连接',
              ),
              h(
                'div',
                { style: styles.qrWrap },
                h('img', {
                  src: `${API}/qr.png?v=${login.qrVersion || 0}`,
                  alt: '微信登录二维码',
                  style: styles.qr,
                }),
                h(
                  'div',
                  { style: { flex: '1 1 240px' } },
                  h(
                    'p',
                    { style: styles.muted },
                    login.needVerifyCode
                      ? '手机微信上显示了数字，请填在下面并提交。'
                      : '用手机微信扫一扫。二维码约 2 分钟有效，过期会自动换新码。',
                  ),
                  login.needVerifyCode
                    ? h(
                        'div',
                        { style: { ...styles.actions, marginTop: 10 } },
                        h('input', {
                          style: styles.input,
                          value: code,
                          inputMode: 'numeric',
                          placeholder: '数字',
                          onChange: (event) => setCode(event.target.value),
                        }),
                        h(
                          'button',
                          {
                            style: { ...styles.button, ...styles.primary },
                            disabled: busy === 'verify',
                            onClick: () => void act('verify', '/verify', { code }),
                          },
                          '提交',
                        ),
                      )
                    : null,
                  error ? h('div', { style: styles.error }, error) : null,
                ),
              ),
            )
          : error
            ? h('div', { style: styles.error }, error)
            : null,

        h(
          'div',
          { style: styles.card },
          h('h2', { style: styles.cardTitle }, '微信消息进哪个会话'),
          h(
            'div',
            { style: styles.muted },
            '默认接收会话：以后新出现的微信聊天会自动绑到它；已有的聊天在下面「会话绑定」里单独改（下拉选完立刻生效）。',
          ),
          h(
            'div',
            { style: { ...styles.actions, marginTop: 10 } },
            h(
              'select',
              {
                style: { ...styles.select, minWidth: 280 },
                value: defaultDraft === undefined ? defaultSession : defaultDraft,
                onFocus: () => {
                  if (sessions.length === 0) void loadSessions()
                },
                onChange: (event) => setDefaultDraft(event.target.value),
              },
              defaultSession
                ? null
                : h('option', { value: '' }, '（未设置：每个新聊天各建一个自动会话）'),
              sessions.some((item) => item.id === (defaultDraft === undefined ? defaultSession : defaultDraft))
                ? null
                : defaultSession
                  ? h('option', { value: defaultSession }, defaultSession)
                  : null,
              sessions.map((item) => h('option', { key: item.id, value: item.id }, sessionLabel(item))),
            ),
            h(
              'button',
              {
                style: styles.button,
                disabled: busy === 'default' || (defaultDraft === undefined ? defaultSession : defaultDraft) === defaultSession,
                onClick: () =>
                  void act('default', '/default-session', {
                    sessionId: defaultDraft === undefined ? defaultSession : defaultDraft,
                  }),
              },
              '设为默认',
            ),
            h(
              'button',
              {
                style: { ...styles.button, ...styles.primary },
                disabled: busy === 'new-session',
                onClick: async () => {
                  const result = await act('new-session', '/new-session', { asDefault: true })
                  if (result?.sessionId) setDefaultDraft(result.sessionId)
                },
              },
              '新建会话并设为默认',
            ),
          ),
        ),

        h(
          'div',
          { style: styles.card },
          h('h2', { style: styles.cardTitle }, `微信账号（${accounts.length}）`),
          accounts.length === 0
            ? h('div', { style: styles.empty }, '还没有账号。点右上角「新增账号」，用手机微信扫码。')
            : h(
                'table',
                { style: styles.table },
                h(
                  'thead',
                  null,
                  h(
                    'tr',
                    null,
                    h('th', { style: styles.th }, '账号'),
                    h('th', { style: styles.th }, 'Bot'),
                    h('th', { style: styles.th }, '我的微信'),
                    h('th', { style: styles.th }, '状态'),
                    h('th', { style: styles.th }, '最近拉取'),
                    h('th', { style: styles.th }, '绑定'),
                    h('th', { style: styles.th }, ''),
                  ),
                ),
                h(
                  'tbody',
                  null,
                  accounts.map((account) =>
                    h(
                      'tr',
                      { key: account.id },
                      h('td', { style: styles.td }, account.name || account.id),
                      h('td', { style: { ...styles.td, ...styles.mono } }, account.botId || '—'),
                      h('td', { style: { ...styles.td, ...styles.mono } }, account.userId || '—'),
                      h(
                        'td',
                        { style: styles.td },
                        h(Badge, {
                          status: account.running ? 'confirmed' : account.lastError ? 'error' : 'idle',
                          children: account.running
                            ? '轮询中'
                            : account.lastError
                              ? account.lastError.slice(0, 40)
                              : '已停止',
                        }),
                      ),
                      h(
                        'td',
                        { style: { ...styles.td, opacity: 0.7 } },
                        account.lastPollAt ? new Date(account.lastPollAt).toLocaleTimeString() : '—',
                      ),
                      h('td', { style: styles.td }, String(account.bindings ?? 0)),
                      h(
                        'td',
                        { style: styles.td },
                        h(
                          'div',
                          { style: styles.actions },
                          h(
                            'button',
                            {
                              style: styles.button,
                              disabled: busy === `relogin-${account.id}`,
                              onClick: () =>
                                void act(`relogin-${account.id}`, '/login', {
                                  force: true,
                                  accountId: account.id,
                                }),
                            },
                            '重扫码',
                          ),
                          h(
                            'button',
                            {
                              style: { ...styles.button, ...styles.danger },
                              disabled: busy === `rm-${account.id}`,
                              onClick: () => void act(`rm-${account.id}`, '/logout', { accountId: account.id }),
                            },
                            '断开',
                          ),
                        ),
                      ),
                    ),
                  ),
                ),
              ),
        ),

        h(
          'div',
          { style: styles.card },
          h('h2', { style: styles.cardTitle }, `会话绑定（${bindings.length}）`),
          h(
            'div',
            { style: { ...styles.muted, marginBottom: 10 } },
            '微信消息会注入绑定的会话（在这里作为用户消息出现）；这个会话里的助手回复、以及你在这里输入的消息，都会同步回微信。',
          ),
          bindings.length === 0
            ? h('div', { style: styles.empty }, '还没有微信聊天记录。微信里先给机器人发一条消息，这里就会出现一条待绑定的会话。')
            : h(
                'table',
                { style: styles.table },
                h(
                  'thead',
                  null,
                  h(
                    'tr',
                    null,
                    h('th', { style: styles.th }, '微信 chat'),
                    h('th', { style: styles.th }, '账号'),
                    h('th', { style: styles.th }, 'DSH 会话'),
                    h('th', { style: styles.th }, '最近'),
                    h('th', { style: styles.th }, ''),
                  ),
                ),
                h(
                  'tbody',
                  null,
                  bindings.map((binding) => {
                    const key = binding.key
                    const value = draft[key] ?? binding.sessionId
                    return h(
                      'tr',
                      { key },
                      h('td', { style: { ...styles.td, ...styles.mono } }, binding.chatId),
                      h('td', { style: styles.td }, binding.accountName),
                      h(
                        'td',
                        { style: styles.td },
                        h(
                          'select',
                          {
                            style: styles.select,
                            value,
                            onFocus: () => {
                              if (sessions.length === 0) void loadSessions()
                            },
                            onChange: (event) => {
                              const next = event.target.value
                              setDraft({ ...draft, [key]: next })
                              // 选完立刻生效，不用再点按钮
                              void act(`bind-${key}`, '/bind', { key, sessionId: next })
                            },
                          },
                          sessions.some((item) => item.id === value)
                            ? null
                            : h('option', { value }, value),
                          sessions.map((item) =>
                            h('option', { key: item.id, value: item.id }, sessionLabel(item)),
                          ),
                        ),
                        binding.explicit
                          ? null
                          : h('span', { style: { ...styles.muted, marginLeft: 8 } }, '（未绑定，自动会话）'),
                      ),
                      h(
                        'td',
                        { style: { ...styles.td, opacity: 0.7 } },
                        binding.lastInboundAt ? new Date(binding.lastInboundAt).toLocaleTimeString() : '—',
                        binding.pending > 0
                          ? h(
                              'div',
                              { style: { color: '#c08a00', fontSize: 11, marginTop: 2 } },
                              `待补发 ${binding.pending} 条`,
                            )
                          : null,
                        binding.needsActivation
                          ? h(
                              'div',
                              { style: { color: '#d64545', fontSize: 11, marginTop: 2 } },
                              '需微信侧激活：让对方给机器人发一条消息',
                            )
                          : null,
                      ),
                      h(
                        'td',
                        { style: styles.td },
                        h(
                          'div',
                          { style: styles.actions },
                          h(
                            'button',
                            {
                              style: { ...styles.button, ...styles.primary },
                              disabled: busy === `bind-${key}` || value === binding.sessionId,
                              onClick: () => void act(`bind-${key}`, '/bind', { key, sessionId: value }),
                            },
                            '绑定',
                          ),
                          h(
                            'button',
                            { style: styles.button, onClick: () => openSession(binding.sessionId) },
                            '打开',
                          ),
                          h(
                            'button',
                            {
                              style: { ...styles.button, ...styles.danger },
                              disabled: busy === `unbind-${key}`,
                              onClick: () => void act(`unbind-${key}`, '/unbind', { key }),
                            },
                            '解绑',
                          ),
                        ),
                      ),
                    )
                  }),
                ),
              ),
        ),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register({ name: 'sidebar.panellist', id: 'wechat', label: () => '微信' }, WechatIcon),
        )
        ctx.slots.inject('main', () =>
          ctx.slots.register({ name: 'main', key: 'wechat' }, () => h(WechatPanel, { ctx })),
        )
      },
    }
  },
})
