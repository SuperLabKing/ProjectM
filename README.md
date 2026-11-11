# ProjectM · dotpm Live Description

Obsidian 的任务清单增强插件。普通笔记的实时预览可独立使用任务功能。安装 dotpm（project-manager）后，也可在任务描述弹窗里使用同一套交互。

## 安装

1. 从本仓库的 v0.0.1 标签获取 `manifest.json`、`main.js` 和 `styles.css`。
2. 将三个文件放入库的 `.obsidian/plugins/dotpm-live-desc/`。
3. 在 Obsidian 的第三方插件设置中启用 **dotpm Live Description**。如需在 dotpm 描述框中使用原生实时编辑，在插件设置中将 **Mode** 设为 **live2 原生嵌入编辑器**。

## 使用

- 在任务行输入 `@` 或按 `Alt+D` 打开日期选择器，支持单日、计划范围和仅截止日。实时预览中，悬停胶囊可查看完整日期，右键可以修改。逾期的任务在胶囊内显示红点，悬停可查看逾期天数。
- 左键点复选框可开始、完成或从搁置继续。右键可搁置任务，再右键可取消。
- 父任务状态随子任务变化。全部完成、取消或搁置时，父任务进入相应状态。只有待办和取消时，父任务为待办。其他混合状态为进行中。父任务行尾的 `⋯` 菜单可手动搁置、取消或恢复。
- 搁置期间暂停累计耗时，继续时保留首次开始时间。所有子任务都回到待办时，父任务清空上一轮计时。
- 子任务进度条将完成和取消计为已处理。已有的 YAML `progress` 属性会随任务进度更新。

普通笔记使用 Obsidian 的实时预览模式。dotpm 描述框的嵌入和保存联动依赖 Obsidian 和 dotpm 的内部接口。

第三方组件的许可见 [THIRD-PARTY-LICENSE.txt](THIRD-PARTY-LICENSE.txt)。
