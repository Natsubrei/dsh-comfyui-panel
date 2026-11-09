# dsh-comfyui-panel

[![test](https://github.com/Natsubrei/dsh-comfyui-panel/actions/workflows/test.yml/badge.svg)](https://github.com/Natsubrei/dsh-comfyui-panel/actions/workflows/test.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

[English](README.md) · [简体中文](README.zh-CN.md)

在 DeepSeek Harness Web UI 里使用 ComfyUI：编辑器是独立的一页。右侧一列和拥有这张画布的会话对话。

## 目录

- [安装](#安装)
- [使用](#使用)
- [能力](#能力)
- [配置](#配置)
- [要求](#要求)
- [限制](#限制)

## 安装

在 DSH 中打开 **设置 → 插件 → 发现 → 添加索引源**，粘贴：

```text
https://raw.githubusercontent.com/Natsubrei/dsh-comfyui-panel/main/market/index.json
```

安装 **ComfyUI Panel** 卡片。索引为每个版本钉住一个 commit，所以安装的一定是测试过的发布。`plugin_market` 工具读取同一个索引。

| 其他方式 | 命令 | 适用情况 |
| --- | --- | --- |
| 命令行 | `dsh plugin --profile <name> add 'git+https://github.com/Natsubrei/dsh-comfyui-panel.git#<commit>'` | 从市场卡片复制 `<commit>`。不钉 commit 的 URL 会跟随默认分支，可能领先于该发布。 |
| npm | `dsh plugin --profile <name> add dsh-comfyui-panel` | 不关心版本时。npm 并不包含每一个已索引的发布。 |

如果 DSH 已经在运行，重启它。bundle 变化后，浏览器需要强制刷新。

## 使用

1. 点左侧栏的 **ComfyUI**。编辑器占满中间主区，右侧是助手。
2. 右侧一列把话发进这一页的会话。模型随后用下表里的工具改当前画布。
3. 服务地址保持 `http://127.0.0.1:8188`，或在[配置](#配置)中改成别的地址。
4. 服务没起来时，画布上是一张说明原因的卡片，并标出目录。画布底部的工具栏永远显示 **启动**、**停止**、**设置** 三个按钮，前两个在不适用时变灰。含 `main.py` 的目录在 **设置** 里选。如果 comfy-cli 记录过工作目录，会填上那个；否则留空，等你选。**Start with DSH** 会被记住。已经在运行的服务会被接管，不会再启动一个。
5. 等芯片显示 **Running**。在右侧说话。模型使用这一页的工具，包括发起运行。离开这一页后，需要编辑器在场的工具会失败。**新建** 会让这一页换一个会话，原来的会话和记录都还在。收起右栏后，画布右缘有一条标签，点它展开。

还没有 ComfyUI：运行 `node test/mock-comfyui.mjs`，在左侧栏打开 **ComfyUI**，等芯片显示 **Running**。mock 是单节点图，`comfyui_run` 返回 `p1`。在真正的 ComfyUI 使用 8188 端口前，先停掉 mock。

贡献者运行 `npm test` 和 `npm run typecheck`。覆盖范围见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 能力

工具只出现在已经同步过工作流的会话上。Host 重启后，已持久化的会话会重新获得工具。新会话在第一次同步时获得。

Panel 列的 **需打开** 表示该会话必须打开面板，**可关闭** 表示面板可以关着。

### 面板

| 能力 | 你得到什么 |
| --- | --- |
| 编辑器 | 在 `/comfyui/` 提供真实的 ComfyUI 前端，走已认证的 HTTP 和 WebSocket。同源 iframe 保留第三方节点的界面。面板不使用 DSH 主题变量。自定义节点界面以 DSH 页面的身份运行，见 [SECURITY.md](SECURITY.md)。 |
| 桥接 | `window.comfyAPI.app.app` 出现后，页面打开时大约每秒同步一次：UI 工作流、只读投影，以及 `graphToPrompt()` 给出的 API 提示。UI 工作流是权威图。编辑器事件（`execution_start`、`executing`、`progress`、`executed`、成功、错误、中断和队列状态）经编辑器自己的 socket 转发，运行就发往这个 socket。面板不再单独开一个 ComfyUI socket。 |
| 摘要行 | 一行，例如 `ComfyUI: rev 14 · "deepseek-chan-emoji" · 9 nodes · 9 links · selected 7 · panel open.`。只有图有名字时才出现名称。打开多个标签时附加数量和当前标签。缩放、平移和改变面板大小不会增加 `rev`。 |
| 名称 | 保存或加载具名工作流会给会话命名，摘要行里也会出现这个名字。当 ComfyUI 用户数据中存在 `<name>.json` 时，编辑器标签也改成同名。 |
| 存储 | 域 `dsh_comfyui`。Host 重启不丢图。记录为 `sessionId -> { workflow, prompt, semantic, revision, name, nameSource }`，保留最近更新的 20 个会话。`nameSource` 是 `file` 或 `tool`。模型看到的是投影和它自己的编辑结果。存储失败时退回内存，不阻塞桥接。具名工作流放在 `workflows` 表。 |
| 进程 | **Server** 启动、停止和重启 ComfyUI。命令由检出目录推导（Unix 上是 `.venv/bin/python`，Windows 上是 `.venv/Scripts/python.exe`，否则用 `python3` 或 `python`），参数来自上游端口，不接受任意命令。目录和 **Start with DSH** 存在 `dsh_comfyui` 中，不写入 DSH profile。 |

### 模型工具

| 工具 | 作用 | 面板 |
| --- | --- | --- |
| `comfyui_status` | 上游、面板、工作流摘要、存储、进程管理和最近一次运行。`diagnostics` 每层一行（`upstream`、`frontend`、`panel`、`commandChannel`、`storage`、`supervisor`、`workflow`），带 `ok`、一句话 `detail`，需要下一步时带 `action`。`warn: true` 且 `ok: true` 表示能用但降级，例如前端版本未上报。 | 可关闭 |
| `comfyui_graph_read` | 每个节点给出 `id`、`type`、`title`、`mode`、`widgets`（`name -> value`）和 `inputs`（`name -> "<sourceNodeId>:<slot>"`）。`layout=true` 附加画布框和重叠判定。`full=true` 附加原始 UI 工作流和 API 提示。 | 可关闭 |
| `comfyui_run` | 提交已同步的 API 提示并返回 `prompt_id`。调用返回后 Host 继续跟踪这次运行，无论面板开不开。输出的 PNG 带 UI 工作流，拖回 ComfyUI 可恢复图。`wait=true` 返回最多四张 `type: 'output'` 图片，每张 20 MB。没有附件服务，或模型路由不接受图片时，结果改为列出文件名。 | 可关闭 |
| `comfyui_cancel` | 移除排队中的提示（`action: "deleted"`）或中断正在运行的提示（`action: "interrupted"`）。已经结束的提示是空操作。把输出文件复制到指定路径还不是工具。 | 可关闭 |
| `comfyui_progress` | 面板事件（当前节点、步骤进度、错误）、运行记录、实时 `/queue`，以及 `hostRun`（终态和输出文件名）。面板关闭后 `hostRun` 继续，步骤进度不继续。 | 可关闭 |
| `comfyui_edit` | 在一个有序批次里增删、移动、重连节点并设置控件值。结果带回剩下的节点和连线数，所以只应用了一半的编辑看得见。它不校验图的语义，由 ComfyUI 在转成提示时拒绝错误编辑。 | 需打开 |
| `comfyui_screenshot` | 把编辑器画布写成 PNG 并返回路径。用 `read_image` 打开。 | 需打开 |
| `comfyui_node_info` | 缓存的 `/object_info` 查询，用于类类型和输入名。 | 可关闭 |
| `comfyui_workflow_save` | 按名称保存已同步的工作流。同名会覆盖该槽位。没有合并、撤销或逐槽位历史。 | 可关闭 |
| `comfyui_workflow_list` | 已保存的槽位（节点和连线数、写入时间），加上 ComfyUI 用户 `workflows/` 目录里的 `.json` 文件（大小、修改时间）。`source` 为 `slot` 或 `comfyui`。当前会话正在编辑的槽位会被标出。ComfyUI 读取失败时保留槽位并给出 `warning`。 | 可关闭 |
| `comfyui_workflow_load` | 用已保存的槽位或 ComfyUI 用户工作流替换打开的图，然后同步。同名时槽位优先，除非 `source` 指明用哪个。 | 需打开 |
| `comfyui_workflow_export` | 从已保存的槽位或会话的图写出一份 UI 工作流 JSON。路径必须在会话工作区内。 | 可关闭 |
| `comfyui_workflow_import` | 把 UI 工作流 JSON 读入一个槽位。路径必须在会话工作区内。 | 可关闭 |
| `comfyui_workflow_switch` | 按 `name` 切换到另一个已打开的标签；两个标签同名时用 `path`。该标签未保存的编辑会保留。 | 需打开 |
| `comfyui_workflow_close` | 关闭一个已打开的标签。要求 `confirm: true`，并假定用户已经要求关闭。有未保存内容的文件标签会打开 ComfyUI 自己的保存对话框。有未保存内容的临时标签会被拒绝关闭。 | 需打开 |

`comfyui_workflow_save`、`comfyui_workflow_list`、`comfyui_workflow_export` 和 `comfyui_workflow_import` 只在该会话已经同步或恢复过工作流之后，才能在面板关闭时使用。

## 配置

默认上游是 `http://127.0.0.1:8188`。优先使用回环地址。要改地址，在 profile 的 `cordis.patch.yml` 里按同一个 `id` 覆盖本插件的行。补丁会替换整个 `config`，所以要重复写 `prefix`。`prefix` 固定为 `/comfyui`，其他值会让插件加载失败。

```yaml
- insert:
    - id: dsh-comfyui-panel
      name: dsh-comfyui-panel
      config:
        upstream: http://127.0.0.1:8188
        prefix: /comfyui
```

代理会去掉 DSH 会话 cookie（`dsh-auth-…`），其他 cookie 和 `Authorization` 仍会转发。`upstream` 只指向你信任的服务。见 [SECURITY.md](SECURITY.md)。

从面板启动 ComfyUI 不需要 profile 配置。插件行上的 `supervise` 块会在启动时覆盖面板的设置。字段、必填的 `cwd` 和默认值见 [docs/supervise.md](docs/supervise.md)。

## 要求

- ComfyUI 的前端是标准 `comfyui-frontend-package` 构建（相对路径 `./assets/...`，`api_base` 由路径推导）。面板最后在 1.57.1 上验证。上报其他版本时显示提示，仍然加载。不上报版本的服务不做处理。
- 面板使用 `window.comfyAPI.app.app`，这是兼容层，不是稳定 API。实际用到的成员和升级后如何复查见 [docs/comfyui-bridge.md](docs/comfyui-bridge.md)。
- DSH Web profile 挂载了 `storage`、`storage-json` 和 `storage-domain`。默认 profile 有。缺少时工作流只存在内存中。
- 接管已在运行的 ComfyUI（这样刷新后 Stop 和 Restart 仍可用）需要 Linux 的 `/proc` 或 `lsof`。两者都没有时，该服务保持 external。从面板启动一个不需要这两者。面板或 `comfyui_status` 看到健康的上游时会重试接管。工作目录不是所配置检出目录的监听者保持 external，会报告 pid，且没有 Stop/Restart。Windows 可以从面板启动检出，那里已在运行的服务保持 external。

## 限制

- ComfyUI 用户工作流通过 `/userdata` 从 `workflows/` 读取，每次加载一个 JSON 文件。名称是 `workflows/` 下的路径去掉 `.json`，所以区分大小写，子目录会留在名称里。只列出 `.json` 文件。插件从不写入或移动这些文件。加载一个只改变面板画布。
- 预览、逐节点进度、耗时和芯片上的 Cancel 只在面板挂载期间存在。Queue 按钮发起的运行从第一个执行事件起获得 `hostRun` 跟踪。面板挂载前就开始的运行没有 `hostRun`，也没有步骤进度。Host 在 30 分钟后停止跟踪并报告 `lost`，含义是没观察到结束，不是运行失败。
- 插件只是接管的 ComfyUI 在插件卸载后继续运行。那个进程不是插件启动的，重载后插件也分不清它是自己的幸存进程还是你手动启动的。要关掉它，先在面板里停止。插件自己启动的子进程会在卸载时停止。
- 进程管理器分不清卡死的 ComfyUI 和长时间生成、暂时不回应 `/system_stats` 的 ComfyUI。健康重启要按工作负载调整。

## 许可证

[MIT](LICENSE)。
