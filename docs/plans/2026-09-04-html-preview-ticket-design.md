# HTML 预览 403 forbidden：不透明源与预览票据（ticket）

日期：2026-09-04

## 现象

在侧边栏里预览一个本地 `.html` 文件：页面第一次能渲染出来，但

- 相对样式表（`./style.css`）、图片、`<script src>` 全部加载失败，页面无样式；
- 页面一旦自己 `location.reload()`，iframe 整个变成路由的裸响应体 `forbidden`。

抓到的是 `/sidebar/html/...` 返回 `403`，响应体是纯文本 `forbidden`——命中信任栅栏的拒绝分支（`src/index.ts` 预览路由的 `if (!fence(req))`），不是业务错误。

## 根因

预览路由自己给文档打了 `Content-Security-Policy: sandbox`（不含 `allow-same-origin`），iframe 的 `sandbox` 属性同样不含它。这是预览器的安全边界，**有意为之**：被预览的页面必须落在不透明源（opaque origin）里，拿不到 GUI 的同源权限。

代价是：不透明源的页面**为自己发出的每一个请求**，浏览器都按跨站标记发送。真实 Chromium 抓取（sandbox 属性与路由 CSP 一致的最小复现）：

| 预览页发出的请求 | `Origin` | `Sec-Fetch-Site` |
| --- | --- | --- |
| iframe 首次加载（父页面发起） | 缺省 | `same-origin` |
| `<link rel=stylesheet>` / `<img>` / 经典 `<script>` | 缺省 | `cross-site` |
| module `<script>` / `fetch()` | `null` | `cross-site` |
| 页面自身的 `location.reload()` | 缺省 | `cross-site` |

`src/trust-fence.ts` 的两条浏览器标记校验因此全部命中拒绝分支：

- `sec-fetch-site === 'cross-site'` 直接返回 false；
- `Origin: null` 走到 `new URL('null')` 抛异常，catch 返回 false。

首次加载能过，是因为那一次由 GUI 设置 `iframe.src` 发起，标记是 `same-origin`。所以表现成「先渲染一次，然后自己把自己打成 forbidden」。

**关键点：光靠请求头无法区分**。预览页的子资源请求，与用户浏览器里任意一个恶意页面对 `127.0.0.1:<port>/sidebar/html/...` 发起的请求，逐字节相同（都是 `cross-site` + 无 `Origin`）。所以「放宽栅栏」等于把这条路由向浏览器里所有页面敞开，只剩 Host 栅栏和工作区路径守卫兜底。不可接受。

## 方案

用一个**不可猜测的票据**代替浏览器标记，作为这条路由的来源证明。

1. **`src/html-ticket.ts`（新增）**：`mintHtmlTicket()` 每次 `apply()` 铸一个 24 字节随机值（base64url，32 字符）；`isValidHtmlTicket()` 定长常数时间比较。
2. **`src/html-route.ts`**：票据作为**路径首段**写进 URL——`/sidebar/html/<ticket>/<sessionId>/<路径段…>`。放路径而不放 query，理由和 sessionId 当初放路径完全一样：WHATWG URL 解析相对引用会丢弃 query，而路径前缀会被 `./style.css` 自动带上。**被预览的页面不需要知道票据存在**，浏览器替它带。
3. **`src/index.ts`**：
   - 预览路由改用 `hostFence`（只保留 Host 半边，见下），再校验票据；票据不符与 Host 不符**回同样的 403 `forbidden`**，探测方拿不到「文件是否存在」的信息。
   - 新增受栅栏保护的 JSON 路由 `html.ticket` 下发票据。这条路由**仍走完整栅栏**，所以只有 GUI 自身源读得到票据，跨站页面在读到之前就被拒。
4. **`src/trust-fence.ts`**：拆出 `isTrustedHostRequest()`（Host 半边，DNS rebinding 防御），`isTrustedApiRequest()` 在其之上叠加浏览器标记校验。其余路由行为完全不变。
5. **客户端**：`ensureHtmlTicket()` 取一次并缓存（进程内稳定，失败清缓存以便重试）；`htmlUrl(ticket, scope, path)` 拼 URL。预览 iframe **始终挂载**，只有 `src` 等票据到位——这样 sandbox 契约在任何字节加载之前就已生效，也不会闪一个空位。

票据只授权「够到这条路由」。session 作用域与 `ensureWorkspacePath` 的真实路径守卫一个都没动，越界路径照旧 403。

## 第二个缺陷：nosniff 下的 Content-Type

403 修好之后样式仍然不生效，颜色是 `rgb(0, 0, 0)`。原因和栅栏无关：

预览路由发 `X-Content-Type-Options: nosniff`，而 `mediaTypeForPath()` 的 `MEDIA_TYPES` 只覆盖图片、PDF、HTML，`.css` 落到 `application/octet-stream`。nosniff 下 Chromium **拒绝**这样的样式表，`.js` 同理。这个缺陷一直被 403 挡在后面，从没暴露过。

新增 `previewTypeForPath()` 与 `PREVIEW_TYPES`（css / js / mjs / json / map / txt / wasm / 字体 / 音视频），**只给预览路由用**。刻意不并进 `MEDIA_TYPES`：`/sidebar/file` 是从 GUI 自身源访问的，在那里把工作区文件标成 `text/javascript` 等于允许它被当作同源脚本加载。

## 证据

- 单元：`tests/html-preview-fence.spec.ts`（16 例）。请求头取自真实 Chromium 抓取，不是编的。把路由的 `hostFence` 换回 `fence` 重跑，其中 4 例失败——即这些用例确实咬住了这个 bug。
- 客户端：`tests/html-preview-ticket.spec.tsx`（4 例，jsdom）：票据 URL、跨预览只取一次、取不到时 iframe 留在原地无 src、失败后可重试。
- URL 词汇：`tests/html-route.spec.ts` 全量跟随票据段更新，并新增「相对引用带上票据」这一条（票据机制成立的前提）。
- 真机：`tests/e2e/html-preview.e2e.ts`，打包插件挂进真实 `dsh web`，预览一个带相对样式表且会自己 reload 的页面，断言正文在、无 `forbidden`、`#mark` 计算色为 `rgb(1, 2, 3)`。`pnpm test:mount` 下通过。
- 全量：typecheck 通过，单测 1200 通过 / 9 跳过。

## 附带改动

`tests/e2e/host.ts` 新增 `dismissOnboarding(page)`：无密钥启动时 DSH 会叠一层欢迎页 + 供应商配置弹窗，遮罩会吞掉侧边栏上的任何点击。这段逻辑原本内联在 `mount.e2e.ts`，现在抽成共享函数供新 lane 使用；`mount.e2e.ts` 本身未改动，后续可以让它也调这个函数。

## 已知无关失败

`tests/e2e/mount.e2e.ts` 的「Side Chat tab must poll sidechat.events」在本机失败。在本次改动**之前**的 baseline 上同样失败（stash 后重跑确认），与本设计无关。
