# pi-question

[English](README.md) | **简体中文**

一个 [Pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) 扩展，为 LLM 提供 Claude Code 风格的 `ask_user_question` 工具：当模型遇到真正需要你拍板的决策时，弹出交互式选择界面，而不是自己瞎猜。

## 功能

- **单问题**：选项列表（`↑↓` + 回车），自动附带 "Type something." 自由输入项（内联编辑器）
- **多问题（最多 4 个）**：顶部短标签芯片栏（`■`/`□` 显示已答/未答），`Tab`/`←→` 切换，答完自动跳到下一个未答问题，最后有 **Submit** 汇总页确认所有答案
- **multiSelect 多选**：空格切换 `[x]`/`[ ]`，回车确认整题；自由输入条目可与勾选项并存
- **选项 preview**：选项可携带多行 `preview`（代码片段、mockup、配置示例），聚焦该选项时在下方边框块中展示——用于直观对比具体产物
- **推荐项**：prompt 层约定——工具 description 已告知模型将推荐项排第一并追加 ` (Recommended)`
- 优雅降级：任意时刻 Esc 取消；非 TUI 模式（如 `pi -p`）下返回错误结果而不会卡死
- 自身无运行时依赖：`@earendil-works/pi-coding-agent`、`@earendil-works/pi-tui` 和 `typebox` 均由你的 pi 安装提供

## 安装

先克隆本仓库：

```bash
git clone https://github.com/BlueOcean223/pi-question.git
cd pi-question
```

**方式 A —— 软链到全局扩展目录（推荐，便于开发）**

```bash
mkdir -p ~/.pi/agent/extensions
ln -sfn "$(pwd)" ~/.pi/agent/extensions/pi-question
```

然后重启 pi，或在会话内执行 `/reload`。

**方式 B —— 临时加载**

```bash
pi -e "$(pwd)/index.ts"
```

## 试一试

对 pi 说一句模糊的需求，例如：

> 我想给应用加登录功能——开工前先用 ask_user_question 问清楚我的偏好。

## 按键

| 按键 | 作用 |
| --- | --- |
| `↑` `↓` | 在选项间移动 |
| `Enter` | 选中（单选）/ 确认整题（多选）/ 在 "Type something." 上打开编辑器 |
| `Space` | 勾选/取消勾选（多选） |
| `Tab` / `←` `→` | 切换问题（多问题模式） |
| `Esc` | 取消对话框（编辑器内则返回选项列表） |

## 许可证

MIT
