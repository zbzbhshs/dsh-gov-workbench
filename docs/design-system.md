# 综合政务智能工作台 · 视觉语言规范

本规范定义 `dsh-gov-workbench` 插件前端的界面语言，供后续扩展页面、增补组件、调整样式时对照。
所有数值均取自 `public/css/gov.css` 的 `:root`，与该文件一一对应；本文件不引入任何 `gov.css` 中不存在的令牌。
若规范与实现冲突，以 `public/css/gov.css` 为准，并同步修订本文件。

---

## 一、设计原则

1. 清晰稳定优先于装饰。信息密度要高，视觉噪声要低。一屏之内能读到事项编号、办理状态、回执与统计，不做无信息量的卡片堆叠和留白表演。
2. 政务门户视觉语言。白色内容区 + 深蓝导航 + 红色重点提示。蓝色承载主体信息与主操作，红色只用于印章、重要通知、危险操作与异常，不做大面积高饱和铺底。
3. **两条硬约束不可破。**
   - 形状约束：模块容器一律直角（`border-radius: 0`）配 `1px solid` 边框；只有小控件允许圆角，且不超过 `--gov-radius`（`6px`）。圆形仅属于印章类图形元素（徽标、办结章）。
   - 稳定性约束：动态区必须预留稳定尺寸，**流式输出不许导致布局跳动**。`--gov-receipt-h`（`380px`）与 `--gov-stats-h`（`76px`）就是为此存在；回执窗口采用「按 key 增量替换」，绝不全量重建。
4. 离线可用。不引外部字体、CSS 框架、图标库或远程图片。印章徽标用纯 CSS + 内联 SVG 绘制，跑马灯与飘窗用原生 `requestAnimationFrame` 实现，整站在断网环境下与联网表现一致。
5. 状态必须双表达。成功、处理中、失败、需审批四类状态一律「文字 + 颜色」同时给出，不允许只靠颜色区分。
6. **长文本永不撑破布局。** `td`、`th`、`.gov-text`、`p`、`li`、`.receipt-line` 统一 `word-break: break-word` 与 `overflow-wrap: anywhere`。

---

## 二、视觉令牌表

全部令牌集中声明在 `public/css/gov.css` 的 `:root`，页面与组件只消费变量，不为单一栏目复制颜色。

### 2.1 颜色令牌

| 名称 | 值 | CSS 变量 | 用途 |
| --- | --- | --- | --- |
| 主蓝 | `#1879d2` | `--gov-blue` | 主操作按钮、链接、焦点边框、模块标题左侧色块、页脚顶线 |
| 深蓝 | `#015293` | `--gov-blue-deep` | 平台名、模块标题文字、统计数值、弹窗边框、按钮悬停态 |
| 主红 | `#e4393c` | `--gov-red` | 印章与徽标、顶部标语、【重要通知】标签、危险按钮、异常状态 |
| 正文 | `#333333` | `--gov-text` | 正文、回执正文、表格内容、表单控件文字 |
| 次要文字 | `#666666` | `--gov-text-2` | 描述、字段标签、表头文字、工具条文字 |
| 弱化文字 | `#999999` | `--gov-text-3` | 时间戳、回执元信息、占位提示、备案号 |
| 页面背景 | `#ffffff` | `--gov-bg` | 内容模块、表头以下单元格、输入框底色 |
| 浅灰背景 | `#f7f7f7` | `--gov-bg-soft` | 顶部工具条、模块标题条、表头、页脚按钮区、代码块底色 |
| 常规边框 | `#dddddd` | `--gov-border` | 表格、表单、模块分隔、虚线行分隔 |

### 2.2 导航渐变令牌

| 名称 | 值 | CSS 变量 | 用途 |
| --- | --- | --- | --- |
| 渐变起点 | `#1874cd` | `--gov-nav-from` | 主导航、飘窗标题栏、弹窗标题栏的渐变上端 |
| 渐变终点 | `#0d47a1` | `--gov-nav-to` | 同一渐变的下端 |

用法统一为 `linear-gradient(180deg, var(--gov-nav-from) 0%, var(--gov-nav-to) 100%)`，四处（主导航、飘窗头、弹窗头）共用同一表达式。

### 2.3 派生色令牌

供状态标签与浅底使用，不单独出现在设计稿里，只由上面九个基色派生。

| 名称 | 值 | CSS 变量 | 用途 |
| --- | --- | --- | --- |
| 浅蓝底 | `#eaf3fc` | `--gov-blue-soft` | 事项编号条、提示条、表格悬停行、输入框焦点光晕 |
| 浅红底 | `#fdeeee` | `--gov-red-soft` | 危险按钮悬停、异常提示条、异常回执标签 |
| 成功绿 | `#2f9e44` | `--gov-green` | 系统状态绿点、回复类回执标签、成功状态点 |
| 浅绿底 | `#eaf7ec` | `--gov-green-soft` | 状态绿点外圈、回复类回执标签底色 |
| 审批琥珀 | `#b8860b` | `--gov-amber` | 待审批状态点、警告提示条左线、思考类回执标签 |
| 浅琥珀底 | `#fdf6e3` | `--gov-amber-soft` | 警告提示条底色、思考类回执标签底色 |

### 2.4 尺寸令牌

| 名称 | 值 | CSS 变量 | 用途 |
| --- | --- | --- | --- |
| 小控件圆角上限 | `6px` | `--gov-radius` | 圆角封顶值；实际控件用 `2px`，均不超过该上限 |
| 顶部工具条高 | `30px` | `--gov-toolbar-h` | 工具条高度，同时用于弹窗遮罩上边距与印章定位基准 |
| 主头部最小高 | `112px` | `--gov-header-h` | 主头部 `min-height`，印章纵向定位参与计算 |
| 主导航高 | `40px` | `--gov-nav-h` | 导航项满高、可点击区域覆盖整条 |
| 跑马灯高 | `34px` | `--gov-marquee-h` | 通知栏高度，视口 `overflow: hidden` |
| 回执窗口稳定高 | `380px` | `--gov-receipt-h` | 回执窗口固定高度，流式输出不引起布局跳动 |
| 统计行最小高 | `76px` | `--gov-stats-h` | 统计行 `min-height`，数值刷新不改变行高 |
| 单元格内边距 | `0.7rem` | `--gov-cell-pad` | 表格单元格、模块体、标题条左右内边距 |

### 2.5 字体令牌

| 名称 | CSS 变量 | 字体栈 |
| --- | --- | --- |
| 正文字体 | `--gov-font` | `"SimSun", "宋体", "Songti SC", "Noto Serif CJK SC", serif` |
| 标题字体 | `--gov-font-head` | `"SimHei", "黑体", "Heiti SC", "Noto Sans CJK SC", "Microsoft YaHei", sans-serif` |
| 等宽字体 | `--gov-font-mono` | `"Consolas", "Courier New", "NSimSun", monospace` |

正文基准 `14px` / 行高 `1.7`。等宽字体专用于编号、时间、token 数等需要对齐的数字，并配 `font-variant-numeric: tabular-nums`，避免刷新时数字宽度抖动。

### 2.6 品牌固定文案

本工程的品牌文案与参考门户明确区分，四处出现位置均为固定字符串，改动需同步 `index.html` 的 `<title>`、主头部、办结章与页脚。

| 位置 | 文案 |
| --- | --- |
| 平台名（`h1.gov-brand-name`） | 综合政务智能工作台 |
| 副标题（`.gov-brand-sub`） | 一网通办 · 智能协同 · 全程留痕 |
| 办结印章（`.gov-seal`） | 准予办结 |
| 页脚备案（`.gov-footer-beian`） | XXICP备00000000号-1　XX公网安备00000000000000号 |

备案行为占位字符串，交付给真实部署方时整行替换；分隔符是全角空格，不得改成半角空格或 `|`。

---

## 三、页面结构（7 段）

`public/index.html` 的固定骨架，自上而下七段，顺序不可调换。

1. 顶部工具条 `.gov-toolbar`（`role="banner"`） — 高 `30px`，浅灰底、下边框。左侧「设为首页 / 加入收藏 / 无障碍浏览」，中间红色标语「深入推进一网通办，让数据多跑路、群众少跑腿」（`flex: 1` 居中，`text-overflow: ellipsis`），右侧实时时钟与访问量。最前还有跳转锚点「跳到主要内容」，`position: absolute; left: -9999px`，聚焦时可用。
2. 主头部 `.gov-header` — 白底、下边框，`min-height: 112px`。四个元素横向排布：红色印章徽标（76×76 圆形，`3px solid` 主红描边，内嵌 SVG 星徽 + 「政务」二字，`rotate(-6deg)`，`user-select: none`，`role="img"` + `aria-label="准予办结 印章"`）、平台名与副标题（`h1` 深蓝 27px 黑体「综合政务智能工作台」+ 13px 灰色副标题「一网通办 · 智能协同 · 全程留痕」，`letter-spacing` 分别为 `2px` / `3px`）、搜索框（输入框 210×30 + 主蓝「查询」按钮，回车触发卷宗检索）、绿色状态点（9×9 圆点，`--gov-green` 配 3px 浅绿外圈，右侧文字「系统状态: …」）。状态点三态：默认绿（正常）、`.is-down` 红（离线）、`.is-warn` 琥珀（告警）。
3. 主导航 `.gov-nav` — 深蓝渐变条，高 `40px`，`aria-label="主导航"`。六个栏目按钮：工作台首页 / 事项办理 / 卷宗档案 / 运行轨迹 / 系统配置 / 规章制度。当前栏目 `.is-active` 用 `rgba(0,0,0,0.22)` 压暗 + 加粗，同时写入 `aria-current="page"`；悬停为 `rgba(255,255,255,0.14)`。导航项是 `<button>`，天生键盘可达。
4. 跑马灯 `.gov-marquee` — 白底、下边框，高 `34px`。左侧红色标签「【重要通知】」带右分隔线，右侧视口 `overflow: hidden`。文本用 `transform: translate(x, -50%)` 驱动，60 px/s 匀速，一条跑完接下一条；悬停暂停，移开继续；空队列显示「暂无通知。」。全程不触发重排。
5. 主布局 `.gov-main`（`tabindex="-1"`） — 最大宽 `1280px` 居中，`display: grid`，`grid-template-columns: minmax(0, 1fr) 286px`，间距 `14px`，`align-items: start`。左列为主办理区 `.gov-col`（纵向 Flex，间距 `14px`），右列为支撑侧栏 `.gov-side`（同构）。六个栏目是六个 `.gov-page` 区块，靠 `.is-active` 切换显隐，非当前栏目 `display: none`。
6. 页脚 `.gov-footer` — 白底，顶部 `2px solid` 主蓝实线（全站唯一的 2px 分隔）。居中三行：主办单位与技术支持、备案号占位 `XXICP备00000000号-1　XX公网安备00000000000000号`（弱化色）、本地部署说明。
7. 飘窗 `.gov-float` — `position: fixed`，`z-index: 60`，宽 `214px`，主蓝边框 + 投影。标题栏用导航渐变、`cursor: move`；`×` 按钮 `aria-label="关闭飘窗"`，悬停变红。匀速直线运动，撞视口边界按分量反弹，悬停暂停，可拖动，拖放后按落点相对屏幕中心重算方向。位置写 `transform`，不引起重排。

---

## 四、组件规则

### 4.1 标题与列表

- 模块容器 `.gov-box`：白底 + `1px solid` 边框 + `border-radius: 0`（直角，硬约束）。
- 标题条 `.gov-box-head`：高 `38px`，浅灰底，底部 `1px` 分隔线，左右内边距 `--gov-cell-pad`。结构固定为「标题 + `.gov-spacer`（`flex: 1`）+ 右侧操作」。
- 模块标题 `.gov-box-title`：黑体 15px、深蓝、加粗，左侧 `3px solid` 主蓝竖线 + `8px` 内距，`letter-spacing: 1px`。
- 列表 `.gov-list`：去符号，行间 `1px dashed` 分隔（末项无），行前 `::before` 注入主蓝「·」。列表项内可放 `<a>` 或 `button.gov-link`（按钮伪装成链接，保证键盘可达且无需 `href`）。
- 提示文本 `.gov-tips`：12px 次要色，行高 `1.9`，其中 `<strong>` 用主红且 `font-weight: 400`，做弱强调而非加粗轰炸。

### 4.2 表格与表单

- 表格 `.gov-table`：`border-collapse: collapse`，13px。表头浅灰底、常规字重、次要色、`white-space: nowrap`；单元格统一 `1px solid` 边框 + `--gov-cell-pad` 内距，`vertical-align: top`。行悬停整行浅蓝底。
- 数字列加 `.is-num`（等宽 + `tabular-nums`），不换行列加 `.is-nowrap`。宽表外层套 `.gov-table-wrap`（`overflow-x: auto`），窄屏横向滚动而不压缩列宽。
- 分页条 `.gov-pager`：顶部 `1px` 分隔线，左侧「上一页」、中间「第 N / M 页」、右侧「下一页」，右侧可挂说明文字。
- 表单栅格 `.gov-params`：`repeat(auto-fit, minmax(210px, 1fr))`，间距 `10px 14px`，自动按容器宽度决定列数。
- 字段 `.gov-field`：纵向 Flex，依次为标签（12px 次要色）、控件、提示 `.gov-field-hint`（11px 弱化色）。控件最小高 `30px`，`1px solid` 常规边框，圆角 `2px`（远低于 `--gov-radius` 上限）；焦点态去 `outline`，改为主蓝边框 + `0 0 0 2px` 浅蓝光晕。文本域最小高 `92px`，仅允许纵向拉伸。
- 按钮 `.gov-btn`：主蓝实底白字，高 `30px`，圆角 `2px`，黑体 13px；悬停转深蓝；禁用降透明度至 `0.5` 且 `cursor: not-allowed`。变体 `.gov-btn-plain`（白底蓝字，用于「刷新数据 / 重新载入 / 调阅 / 导出」等次要操作）、`.gov-btn-danger`（白底红边红字，用于「取消办理 / 不予批准」）。同一操作区内的按钮间距 `10px`。

### 4.3 状态表达（文字 + 颜色双表达）

- 行内状态 `.gov-state`：`::before` 生成 8×8 圆点，后跟文字。四态：`.is-ok` 绿点「空闲 / 已完成」、`.is-busy` 蓝点「办理中」、`.is-fail` 红点失败、`.is-wait` 琥珀点「待办理 / 待审批」。**颜色只是冗余通道，文字始终存在。**
- 提示条 `.gov-hint`：浅蓝底 + 左侧 `3px` 主蓝竖线。`.is-warn` 换琥珀线 + 浅琥珀底，`.is-error` 换红线 + 浅红底且文字转红。
- 状态点 `.gov-dot`：仅用于主头部系统状态，配 3px 同色浅底外圈扩大可见面积。
- 审批、失败等关键状态在弹窗里另有独立文案（「准予执行 / 不予批准」），不依赖颜色传达后果。

### 4.4 交互回执窗口

容器 `.gov-receipt` 固定 `height: var(--gov-receipt-h)`（`380px`），纵向滚动、横向裁剪，`role="log"` + `aria-live="polite"`。空态显示居中灰色引导语。

条目类型由 `public/js/panels.js` 的 `KIND_META` 映射，九种 kind → 七类可见标签：

| kind | 标签 | 样式类 | 视觉 |
| --- | --- | --- | --- |
| `user` | 申办 | `is-user` | 浅蓝底 + 主蓝边 + 深蓝字 |
| `text` | 回复 | `is-text` | 浅绿底 + 绿边 + 绿字 |
| `think` | 思考 | `is-think` | 浅琥珀底 + 琥珀边 + 琥珀字，正文转斜体次要色 |
| `tool` | 调用 | `is-tool` | 浅红底 + 红边 + 红字 |
| `result` | 结果 | `is-trace` | 浅灰底 + 弱化边 + 次要色字 |
| `trace` | 轨迹 | `is-trace` | 同上 |
| `todo` | 待办 | `is-todo` | 浅蓝底 + 主蓝边 + 深蓝字 |
| `system` | 系统 | `is-trace` | 同「结果」 |
| `error` | 异常 | `is-error` | 浅红底 + 红边 + 红字 |

条目结构：`.receipt-item`（虚线底分隔，末项无）内为 `.receipt-head`（类型标签 `.receipt-kind` + 标题 / 时间 / 备注三段 `.receipt-meta`，可换行）与 `.receipt-body`（`white-space: pre-wrap`，空内容显示「（空）」）。正文支持 `.is-think` 斜体与 `.is-mono` 等宽，内嵌 `<pre>` 用浅灰底 + 边框 + 横向滚动。

**渲染方式（硬约束的实现）：** `renderTranscript` 按 `data-key` 建索引，只对新增条目 `appendChild`、对内容变化的条目 `replaceChild`（用 `hashEntry` 指纹比对，未变化不动 DOM）、对消失的条目 `removeChild`。**绝不全量重建**。滚动位置仅在用户原本已贴底（距底 `< 48px`）时才跟随到底，否则保持原位，这就是「流式输出不跳动」的落地方式。

### 4.5 统计行

`.gov-stats` 为 `min-height: var(--gov-stats-h)`（`76px`）的栅格，`repeat(auto-fit, minmax(112px, 1fr))`，`gap: 1px` 配 `background: var(--gov-border)` 形成 1px 网格线，外框 `1px solid`。`role="status"` + `aria-live="off"`（高频刷新不打扰读屏）。

单元格 `.gov-stat` 为「标签（11px 次要色，超长省略号）+ 数值（等宽 16px 深蓝）」。数值过长（含毫秒、速率、百分比）时加 `.is-small` 降到 13px，保证不撑高行。

十二格固定顺序与数据来源（全部取自宿主投影，不估算、不编造）：

| 序号 | 标签 | 来源字段 |
| --- | --- | --- |
| 1 | 轮次 | `sessionStats.turns` |
| 2 | 步数 | `sessionStats.steps` |
| 3 | 模型耗时 | `sessionStats.llmMs`（`.is-small`） |
| 4 | 工具耗时 | `sessionStats.toolMs`（`.is-small`） |
| 5 | 首 token | `sessionStats.ttftMs ÷ ttftSteps`（`.is-small`） |
| 6 | 解码耗时 | `sessionStats.decodeMs`（`.is-small`） |
| 7 | 解码 token | `sessionStats.decodeTokens` |
| 8 | 输出速度 | 本次连接收到字符数 ÷ 解码墙钟（`.is-small`） |
| 9 | 输入 token | `tokenUsage.inputTokens` |
| 10 | 输出 token | `tokenUsage.outputTokens` |
| 11 | 缓存命中 | `cacheReadTokens`（括号内为 `cacheRead ÷ input` 百分比，`.is-small`） |
| 12 | 缓存写入 | `tokenUsage.cacheWriteTokens` |

`renderStats` 先拼 12 格的 `label=value` 签名，与 `dataset.signature` 相同则整体跳过渲染，避免无谓 DOM 抖动。

### 4.6 弹窗

- 遮罩 `.gov-modal-mask`：`position: fixed; inset: 0`，`rgba(0,0,0,0.4)`，`z-index: 80`，`role="dialog"` + `aria-modal="true"`。**上内边距为 `calc(var(--gov-toolbar-h) + 24px)`，即弹窗永不遮挡固定顶部工具条**；遮罩自身纵向可滚。
- 弹窗体 `.gov-modal`：最大宽 `620px`，`1px solid` 深蓝边框，无圆角，投影 `0 8px 28px rgba(0,0,0,0.28)`。
- 标题栏 `.gov-modal-head`：高 `38px`，导航渐变，白字黑体，右端 `×` 关闭按钮带 `aria-label="关闭"`。
- 正文 `.gov-modal-body`：`--gov-cell-pad` 内距，`max-height: 62vh` 内滚。
- 底部操作区 `.gov-modal-foot`：浅灰底，顶部 `1px` 分隔线，按钮右对齐，`position: sticky; bottom: 0`，确认与关闭在任何滚动位置都可见。
- 审批弹窗标题「审批事项」，正文为警告提示条 + 操作详情块 `.gov-q`（操作名 / 原因 / 调用编号），操作为「不予批准」（危险态，左）+「准予执行」（主操作，右）。
- 咨询弹窗标题「系统咨询」，每题一个 `.gov-q` 块，支持单选 / 多选（`.gov-q-option`）与自填（`.gov-q-custom`），操作为「暂不作答」+「提交作答」。

### 4.7 办结盖章

`.gov-seal` 为固定定位的 132×132 双线红圆章，`z-index: 70`，位置 `top: calc(var(--gov-toolbar-h) + var(--gov-header-h) + 24px)`、`right: 36px`，刻意排在工具条与主头部之下，不与头部元素打架。内容「准予办结」，黑体 25px、加粗、`letter-spacing: 2px`，默认 `opacity: 0` 且 `pointer-events: none`（永不拦截点击）。

动效 `gov-stamp` 620ms，`cubic-bezier(0.2, 0.9, 0.3, 1.3)` 带回弹：由 `rotate(-18deg) scale(2.1)` 落至 `rotate(-14deg) scale(1)`，稳定态 `opacity: 0.82`。办结后展示约 6 秒自动淡出；「事项办理」页标题条上的「办结盖章」复选框可全局关闭。`aria-hidden="true"`，因为盖章是装饰性反馈，状态本身已由回执与统计表达。

### 4.8 浮窗

飘窗细节见第三节第 7 条。规则补充：`.gov-float-head` 高 `26px`，标题 `flex: 1` 超长省略；`.gov-float-body` 内距 `8px`、行高 `1.8`、次要色、`word-break: break-word`；关闭按钮 18×18、白描边、悬停转主红。`role="complementary"`。销毁时解绑全部 `pointermove` / `pointerup` / `resize` 监听并 `cancelAnimationFrame`，不泄漏。

---

## 五、响应式与无障碍

### 5.1 响应式

| 断点 | 行为 |
| --- | --- |
| `> 1080px` | 主布局双列：主办理区 + 286px 侧栏 |
| `≤ 1080px` | `.gov-main` 降为单列，侧栏移到内容之下；搜索框宽由 210px 收窄至 150px |
| `≤ 720px` | 主头部允许 `flex-wrap` 换行（徽标与平台名一行，搜索框与状态点折到下一行）；主导航 `overflow-x: auto` 横向滚动，项内距 22px → 14px；顶部标语隐藏（`display: none`）以保住时钟与访问量 |

窄屏策略是「换行 + 滚动」，不缩字号、不隐藏关键操作。全站宽度上限 `1280px`，两侧内距 `12px`。

### 5.2 无障碍

- 字号放大：`body.gov-large` 把正文提到 17px、回执与表格 16px、平台名 31px，由工具条「无障碍浏览」按钮切换，偏好写入本地存储并在加载时恢复。
- 高对比：`body.gov-contrast` 全局黑底白字，模块容器 / 主头部 / 跑马灯 / 页脚 / 回执窗口底色转 `#000`，标题条转 `#111`，正文转 `#fff`。
- 跳转锚点：「跳到主要内容」平时移出视口，激活后把焦点交给 `#gov-main`（该容器带 `tabindex="-1"`）。
- 语义与 ARIA：工具条 `role="banner"`；搜索区 `role="search"` 且 `label` 视觉隐藏；主导航 `role="nav"` + `aria-label`，当前项 `aria-current="page"`；回执窗口 `role="log"` + `aria-live="polite"`；统计行 `role="status"` + `aria-live="off"`；弹窗 `role="dialog"` + `aria-modal="true"`；徽标 `role="img"` + `aria-label`；飘窗 `role="complementary"`；装饰性 SVG 与印章 `aria-hidden="true"`。
- 键盘可达：导航项、列表入口、按钮全部使用原生 `<button>`，无 `div` 伪按钮；`.gov-list button.gov-link` 重置为链接外观但保留按钮语义。搜索框回车即检索，申报文本域 `Ctrl+Enter`（macOS 兼容 `Cmd+Enter`）提交。
- 数字对齐：编号、时间、token 数统一 `font-variant-numeric: tabular-nums`，滚动刷新时字宽不跳。

---

## 六、实现约定

1. 令牌集中。全部颜色、尺寸、字体声明在 `public/css/gov.css` 的 `:root`；页面与组件只消费变量。新增主题只加变量覆盖，不复制整套颜色规则。
2. 布局用 Grid / Flexbox。主布局、参数栅格、统计行用 Grid；工具条、主头部、标题条、字段用 Flexbox。避免 `float` 与绝对定位做常规排版（绝对定位只用于印章、飘窗、跳转锚点这类确实脱离文档流的元素）。
3. 窄屏换行。所有横向排布容器配 `flex-wrap: wrap` 或 Grid 自动换行，并对齐 `min-width: 0`，防止 Grid / Flex 子项被长内容顶破。
4. 直角与圆角的分界。容器直角（`border-radius: 0`）；输入框、按钮、标签、自填框统一 `2px`，不超过 `--gov-radius`（`6px`）；圆形只给徽标与办结章。新增组件必须落在该规则内。
5. 动态区先占位再填内容。回执窗口、统计行、跑马灯视口都在 CSS 里写死高度或最小高度，内容变化只改内部节点。任何「内容多高容器就多高」的动态区都不合规范。
6. 增量更新优先。列表与表格按 key 或签名比对后增量更新；`renderTrace` 最多保留最近 400 行，`renderStats` 用签名短路，`renderTranscript` 用指纹替换。禁止「清空 + 重建」式刷新。
7. 动画只碰 `transform` 与 `opacity`。跑马灯、飘窗、盖章动画都只改这两个属性（配 `will-change: transform`），不触发布局，因而不会引起重排与跳动。
8. 离线自足。不引 CDN、Web Font、图标字体、远程图片。徽标用内联 SVG 描边绘制，印章用 CSS 边框与径向渐变绘制。
9. 中文字体栈。正文 `SimSun` / `宋体` 优先，标题 `SimHei` / `黑体` 优先，数字与代码 `Consolas` / `Courier New`。三级栈都指向系统已装字体，缺失时逐级回退，不下载任何字体文件。
10. 本文件的修订责任。任何改动 `:root` 令牌、增删回执 kind、调整固定高度的提交，都必须同步更新本规范的对应表格。
