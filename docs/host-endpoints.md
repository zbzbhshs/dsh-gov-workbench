# 宿主端点目录（dsh 0.2.0-rc.2 实测）

本文档由 `app.asar` 内 26 个宿主包的 `lib/typert.host.js` 里的 `invocations[]`
逐条抽取生成，共 140 个端点。它是 `lib/host.js` 的
`TYPERT_NAMESPACE_ALIASES` 与 `public/js/api.js` 的唯一依据 —— 凡是本文档里
没有的端点，一律视为不存在，插件不会去调用。

参数列的写法：`wire(来源[,undef])`。`undef` 表示描述符声明了
`acceptsUndefined: true`，即该 wire **可以整个缺席**（`buildArgs` 必须省略它，
不能塞占位对象）。`scope` 列是 `invocation.scope.wire`，即 context 型调用的身份字段。

| 端点 | scope wire | 参数（wire(source[,undef])） |
| --- | --- | --- |
| `account/ackBonusNotified` | — | accountId(json), orderId(json), client(json) |
| `account/cancelSignIn` | — | attemptId(json) |
| `account/getBalance` | — | client(json) |
| `account/getProfile` | — | client(json) |
| `account/getState` | — | （无参数） |
| `account/getUnnotifiedBonuses` | — | client(json) |
| `account/hasRunningAccountTasks` | — | （无参数） |
| `account/signOut` | — | client(json) |
| `account/startSignIn` | — | client(json), callbackOrigin(json), loginSource(json) |
| `account/watch` | — | （无参数） |
| `account/watchExpiry` | — | （无参数） |
| `agentPresets/list` | `agentId` | （无参数） |
| `agentPresets/read` | `agentId` | agentPreset(json) |
| `agentPresets/select` | `agentId` | agentId(lookup), agentPreset(json) |
| `commands/execute` | `agentId` | agentId(lookup), line(json), submittedAttachments(json) |
| `commands/list` | `agentId` | agentId(lookup) |
| `credentials/describe` | — | refs(json) |
| `credentials/set` | — | ref(json), value(json) |
| `credentials/unset` | — | ref(json) |
| `directoryPicker/createDirectory` | — | path(json), name(json) |
| `directoryPicker/list` | — | path(json,undef) |
| `directoryPicker/pick` | — | （无参数） |
| `dynamicCordisRunner/getClientCode` | `agentId` | agentId(lookup), pluginId(json), pluginRunId(json) |
| `dynamicCordisRunner/inventory` | `agentId` | （无参数） |
| `dynamicCordisRunner/invoke` | `agentId` | pluginId(json), pluginRunId(json), method(json), args(json) |
| `dynamicCordisRunner/reportClientGuardFailure` | `agentId` | agentId(lookup), pluginId(json), pluginRunId(json), failure(json) |
| `dynamicCordisRunner/reportRenderFailure` | `agentId` | agentId(lookup), pluginId(json), pluginRunId(json), failure(json) |
| `dynamicCordisRunner/resolveInspectQuery` | `agentId` | agentId(lookup), requestId(json), resolution(json) |
| `dynamicCordisRunner/resolveRequestRun` | `agentId` | requestId(json), resolution(json) |
| `dynamicCordisRunner/runHostHalf` | `agentId` | agentId(lookup), pluginId(json), packageId(json), mode(json), requestId(json), approveFutureVersions(json) |
| `dynamicCordisRunner/settleUserRun` | `agentId` | agentId(lookup), pluginId(json), resolution(json) |
| `dynamicCordisRunner/stopFromPanel` | `agentId` | agentId(lookup), pluginId(json) |
| `dynamicCordisRunner/syncInspectManifest` | `agentId` | providers(json) |
| `dynamicCordisRunner/undefineFromPanel` | `agentId` | agentId(lookup), pluginId(json) |
| `fileReferences/list` | `agentId` | agentId(lookup), query(json) |
| `fileUploads/upload` | `agentId` | agentId(lookup), request(json) |
| `goals/clear` | `agentId` | agentId(lookup), ref(json) |
| `goals/complete` | `agentId` | agentId(lookup), ref(json) |
| `goals/create` | `agentId` | agentId(lookup), request(json) |
| `goals/edit` | `agentId` | agentId(lookup), ref(json), request(json) |
| `goals/get` | `agentId` | agentId(lookup) |
| `goals/pause` | `agentId` | agentId(lookup), ref(json) |
| `goals/resume` | `agentId` | agentId(lookup), ref(json) |
| `job/follow` | — | request(json) |
| `job/kill` | — | request(json) |
| `job/list` | — | request(json) |
| `llm/discoverModels` | — | settingsNs(json), request(json) |
| `llm/listConfigurableProviders` | — | （无参数） |
| `llm/listProviders` | — | （无参数） |
| `messageFeedback/delete` | — | request(json) |
| `messageFeedback/list` | — | request(json) |
| `messageFeedback/put` | — | request(json) |
| `officeToPdf/generation` | — | （无参数） |
| `officeToPdf/render` | — | workspaceFileScopeId(lookup), path(json), priority(json) |
| `permissionPresets/catalog` | — | （无参数） |
| `pluginInventory/list` | — | （无参数） |
| `pluginManager/cancelInstall` | — | requestId(json) |
| `pluginManager/inspect` | — | spec(json), options(json,undef) |
| `pluginManager/installBundle` | — | spec(json), options(json,undef) |
| `pluginManager/listBundles` | — | （无参数） |
| `pluginManager/listPlugins` | — | （无参数） |
| `pluginManager/listVersionExemptions` | — | （无参数） |
| `pluginManager/registries` | — | （无参数） |
| `pluginManager/removeBundle` | — | name(json) |
| `pluginManager/setBundleEnabled` | — | name(json), enabled(json) |
| `pluginManager/setPluginEnabled` | — | id(json), enabled(json) |
| `pluginManager/setVersionExemption` | — | packageVersion(json), runtimeVersion(json), enabled(json), acceptRisk(json,undef) |
| `pluginManager/waitForInstall` | — | requestId(json) |
| `pluginRegistryProbe/fastest` | — | （无参数） |
| `productAnalytics/enabled` | — | （无参数） |
| `productAnalytics/report` | — | event(json) |
| `productAnalytics/watchPolicy` | — | （无参数） |
| `schedule/catalog` | — | （无参数） |
| `schedule/delete` | — | request(json) |
| `schedule/history` | — | request(json) |
| `schedule/list` | — | request(json) |
| `schedule/update` | — | request(json) |
| `session/attachment` | — | request(json) |
| `session/cancel` | — | request(json) |
| `session/canOpenWorkspacePath` | — | （无参数） |
| `session/control` | — | （无参数） |
| `session/create` | — | request(json) |
| `session/follow` | — | request(json) |
| `session/fork` | — | request(json) |
| `session/initializeDefaultModel` | — | （无参数） |
| `session/list` | — | _request(json) |
| `session/modelCatalog` | — | （无参数） |
| `session/openWorkspacePath` | — | request(json) |
| `session/page` | — | request(json) |
| `session/projections` | — | request(json) |
| `session/prompt` | — | request(json) |
| `session/rename` | — | request(json) |
| `session/search` | — | request(json) |
| `session/selectModel` | — | request(json) |
| `session/updateQueue` | — | request(json) |
| `session/workspacePathApplications` | — | request(json) |
| `sessionFeedback/record` | — | request(json) |
| `sessionReferenceResolver/candidates` | `agentId` | agentId(lookup), query(json) |
| `settings/describe` | — | （无参数） |
| `settings/mutate` | — | ns(json), ops(json), expectedRevision(json,undef) |
| `settings/openSettingsDocument` | — | （无参数） |
| `settings/replace` | — | ns(json), section(json), expectedRevision(json,undef) |
| `settings/update` | — | ns(json), patch(json), expectedRevision(json,undef) |
| `skills/list` | — | request(json) |
| `speech/cancelPreparation` | — | providerId(json) |
| `speech/catalog` | — | （无参数） |
| `speech/configure` | — | patch(json) |
| `speech/follow` | — | （无参数） |
| `speech/prepare` | — | providerId(json), options(json,undef) |
| `speech/transcribe` | — | request(json) |
| `subagents/interruptByParent` | — | childSessionId(json), parentSessionId(json), mode(json) |
| `subagents/prompt` | — | request(json) |
| `terminal/close` | `agentId` | agentId(lookup), id(json) |
| `terminal/create` | `agentId` | agentId(lookup), request(json) |
| `terminal/environment` | `agentId` | agentId(lookup) |
| `terminal/follow` | `agentId` | agentId(lookup), id(json), attachmentId(json) |
| `terminal/list` | `agentId` | sessionId(json) |
| `terminal/rename` | `agentId` | agentId(lookup), id(json), title(json) |
| `terminal/resize` | `agentId` | agentId(lookup), id(json), attachmentId(json), cols(json), rows(json) |
| `terminal/retain` | `agentId` | sessionId(json), id(json) |
| `terminal/shells` | `agentId` | agentId(lookup) |
| `terminal/write` | `agentId` | agentId(lookup), id(json), attachmentId(json), data(json) |
| `userQuestions/answer` | `agentId` | agentId(lookup), callId(json), answer(json) |
| `userQuestions/attachWait` | `agentId` | agentId(lookup), callId(json) |
| `workspace/archiveSession` | — | request(json) |
| `workspace/create` | — | request(json) |
| `workspace/delete` | — | request(json) |
| `workspace/follow` | — | （无参数） |
| `workspace/initializeDefault` | — | （无参数） |
| `workspace/insertBefore` | — | request(json) |
| `workspace/insertSessionBefore` | — | request(json) |
| `workspace/pinSession` | — | request(json) |
| `workspace/rename` | — | request(json) |
| `workspace/unarchiveSession` | — | request(json) |
| `workspace/unpinSession` | — | request(json) |
| `workspaceFiles/changes` | — | workspaceFileScopeId(lookup), path(json) |
| `workspaceFiles/list` | — | workspaceFileScopeId(lookup), path(json) |
| `workspaceFiles/read` | — | workspaceFileScopeId(lookup), path(json), range(json) |
| `workspaceFiles/readBytes` | — | workspaceFileScopeId(lookup), path(json), options(json) |
| `workspaceFiles/stat` | — | workspaceFileScopeId(lookup), path(json) |

## 前端调用 → 真实端点 对照

| 前端调用（wire） | 真实端点 | 必填字段 | 状态 |
| --- | --- | --- | --- |
| `session.list` | `session/list` | 无（`_request` 可空对象） | 可用 |
| `session.create` | `session/create` | 无（`workspaceId`/`cwd`/`sessionId`/`agentPreset` 全可选） | 可用 |
| `session.projections` | `session/projections` | `sessionId` | 可用 |
| `session.modelCatalog` | `session/modelCatalog` | 无 | 可用 |
| `session.prompt` | `session/prompt` | **`requestId`, `sessionId`, `mode`, `content`** | 已修（补 requestId） |
| `session.selectModel` | `session/selectModel` | **`sessionId`, `provider`, `model`**（`reasoningEffort` 可选） | 已修（补 provider） |
| `session.rename` | `session/rename` | `sessionId`, `title` | 可用 |
| `session.cancel` | `session/cancel` | `sessionId` | 可用 |
| `session.fork` | `session/fork` | `sessionId`（`atSeq` 可选） | 可用 |
| `session.page` | `session/page` | `address`, `throughSeq`（`maxMessages` 可选） | 已修（`throughSeq` 必须落在宿主游标内，取自投影 `asOfSeq`） |
| `session.search` | `session/search` | `query` | 参数正确；宿主未建索引（`openAt "never"`），界面如实显示原因 |
| `session.attachment` | `session/attachment` | `sessionId`, `attachmentId` | 可用 |
| `session.updateQueue` | `session/updateQueue` | `sessionId`, `itemId`, `action` | 可用 |
| `session.openWorkspacePath` | `session/openWorkspacePath` | `path`（`action`/`application` 可选） | 可用 |
| `agentPreset.list` | `agentPresets/list` | 无 | 可用 |
| `agentPreset.read` | `agentPresets/read` | `agentPreset` | 可用 |
| `agentPreset.select` | `agentPresets/select` | **`agentId`（scope，即会话身份）, `agentPreset`** | 已修（原传 `sessionId` → `missing "agentId"`） |
| `skill.list` → `skills.list` | `skills/list` | **`sessionId`** | 已修（原为幽灵端点，且 namespace 是复数） |
| `permission.catalog` | `permissionPresets/catalog` | 无 | 可用 |
| `directoryPicker.list` | `directoryPicker/list` | `path`（**可缺席**） | 已修（空值必须省略 `path`） |
| `directoryPicker.pick` | `directoryPicker/pick` | 无 | 可用（原生对话框） |
| `directoryPicker.createDirectory` | `directoryPicker/createDirectory` | `path`, `name` | 需 browse capability |
| `settings.describe` | `settings/describe` | 无 | 可用 |
| `settings.update` | `settings/update` | `ns`, `patch`（`expectedRevision` 可缺席） | 可用 |
| `settings.replace` | `settings/replace` | `ns`, `section` | 可用 |
| `settings.mutate` | `settings/mutate` | `ns`, `ops` | 可用 |
| `llm.listProviders` | `llm/listProviders` | 无 | 可用 |
| `llm.listConfigurableProviders` | `llm/listConfigurableProviders` | 无 | 可用 |
| `workspace.create` / `rename` / `delete` / `archiveSession` | `workspace/*` | `request` | 可用 |
| `pluginInventory.list` | `pluginInventory/list` | 无 | 可用 |
| ~~`host.describe`~~ | **不存在** | — | 已删除（0.1.x apiProxy 时代的端点） |
| ~~`host.listDirectory`~~ | **不存在** | — | 已删除（同上） |
| ~~`subagent.list`~~ | **不存在**（`subagents` 只有 `prompt` / `interruptByParent`） | — | 已删除 |
| ~~`workspace.list`~~ | **不存在**（会话列表走 `session.list`） | — | 已删除 |
| ~~`skill.list`~~ | **不存在**（真实是 `skills/list`） | — | 已删除 |

## 真机观测到的错误码

| 错误码 | 触发条件（实测） | 界面处理 |
| --- | --- | --- |
| `gateway/input-invalid` | wire 字段没通过 zod 边界校验（如 `session/prompt` 漏 `requestId`） | 显示「参数形状不被宿主接受」+ 宿主的原文 |
| `gateway/arguments-invalid` | args 键集合与描述符不符（如 `agentPresets/select` 漏 `agentId`） | 显示「参数名与宿主描述符不一致」+ 宿主的原文 |
| `gateway/invocation-unavailable` | 该端点没有任何活动的 Remote 导出（幽灵端点） | 显示「宿主未导出该端点」 |
| `gateway/signature-invalid` | 流式方法被当成 unary 调用（如 `account/watch`） | 显示「该端点必须走流式通道」 |
| `gateway/internal` + `session search is disabled` | 部署把 session-query 索引配成 `openAt "never"` | 显示「宿主未启用会话检索」 |
| `directory-picker/unavailable` | 宿主组合的是原生选择器，没有 browse capability | 降级为手动输入 + 「浏览…」按钮 |
| `session/not-found` | 会话身份在宿主上不存在 | 显示「该事项编号在宿主上不存在」 |
| `agent-preset/locked` | 会话已开始办理，不能再换预设 | 显示「该事项已开始办理，不能再更换办理模式」 |
