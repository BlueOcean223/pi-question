# pi-question

[English](README.md) | **简体中文**

一个 [Pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) 扩展，为 LLM 提供 Claude Code 风格的 `ask_user_question` 工具：当模型遇到真正需要你拍板的决策时，弹出交互式选择界面，而不是自己瞎猜。

## 功能

- **单问题**：带编号的选项列表——按 `1`-`9` 直接选中，或 `↑↓` + 回车；单选题选中即提交
- **多问题（最多 4 个）**：顶部短标签芯片栏（`■`/`□` 显示已答/未答），`Tab`/`←→` 切换，答完自动跳到下一个未答问题，最后有 **Submit** 汇总页确认
- **内置 "Other" 自由输入**：每题自带一行内联输入——光标移过去直接打字即可。文本按题保留；如果最终选了普通选项，打过的字会作为备注附带回传，不会被丢弃
- **multiSelect 多选**：`Space`/`Enter` 切换 `[x]`/`[ ]`，用显式的 **Next/Submit** 按钮确认整题——回车不再有双重含义
- **选项 preview**：单选题的选项可携带多行 markdown `preview`（代码片段、mockup、配置示例），与选项列表左右并排展示（窄终端自动改为上下堆叠）；数字键移动焦点便于对比，`Enter` 才是决定，`n` 添加备注。"Other" 自由输入依然保留，不会因为带 preview 就被拿掉
- **"Chat about this"**：每题都有一条逃生通道，选中后结束对话框、让模型转入对话澄清——已经选过的答案会一并带给模型
- **对模型友好的结果**：答案以问题全文为 key（无需反解短标签），选中项的 preview 与备注会作为 annotations 回传；取消时返回引导文案（"按你的判断继续，或换个问法"）而非干巴巴的拒绝
- **入参校验**：1-4 题、每题 2-4 个选项；问题全文重复或选项 label 重复会返回可重试的错误信息
- **推荐项**：prompt 层约定——工具 description 已告知模型将推荐项排第一并追加 ` (Recommended)`
- **终端体验细节**：全角数字/全角空格归一化（中文输入法友好）、循环导航、`Home`/`End`/`PageUp`/`PageDown`、布局稳定——切换问题时界面不会上下跳动
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
| `1`-`9` | 直接选中选项（单选即选即交，多选为切换勾选；preview 布局下仅移动焦点）。全角数字 `１-９` 同样有效 |
| `↑` `↓` | 在行间移动（循环；在内联输入中会先保存文本再移出） |
| `Home` `End` `PageUp` `PageDown` | 跳到第一行 / 最后一行 |
| `Enter` | 选中（单选）/ 切换勾选（多选）/ 在 **Next/Submit** 按钮上确认整题 / 保存内联输入 |
| `Space` | 勾选/取消勾选（多选）；在 "Other" 行上切换自定义答案的选中状态 |
| 任意字符 | 在 "Other" 行上直接开始输入你的答案 |
| `n` | 添加备注（preview 题） |
| `Tab` / `←` `→` | 切换问题（多问题模式） |
| `Esc` | 取消对话框（内联输入中则保存文本并返回） |

## 许可证

MIT
