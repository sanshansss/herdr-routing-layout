# Magpie Routing for Herdr

这个布局基于 `herdr-skillshare`，加入 Magpie 路由面板：在 Files、Changes 旁开关 Routing，查看实时路由和按会话选择的 Context window。Skillshare 面板保留，默认隐藏。

Gallery 收录文件位于 [`magpie-routing-v1/`](magpie-routing-v1/)。

## 截图

![Herdr Routing 布局](layouts/layout.png)

![Routing Context window](layouts/contextwindow.png)

截图里的空间名、会话标识、路径和终端内容已做马赛克。

## 来源

参考 [lexrus 在 X 上的推文及评论](https://x.com/lexrus/status/2119443089760960679)。提示词大意：

> 读 `~/.config/herdr-app/AGENTS.md`，然后再读 Magpie 的本地源码 `{本地 git 仓库地址}`，照抄 Routing 界面的动画，实现实时展示路由的 Herdr mod，在 Files 和 Changes 按钮右边放一个 Routing 按钮用来开关。

实际效果会随模型变化，提示词和实现可能需要微调。

## 安装

已在 Herdr app 0.1.14 验证。Routing 数据来自 Magpie 的 `~/.config/magpie/routing/*.jsonl`；没有日志时面板会显示空状态。

把包内 `layouts/magpie-routing-v1.json`、`layouts/magpie-routing-v1.svg` 复制到 Herdr 的 `layouts/`，把 `mods/routing`、`mods/skillshare`、`mods/tabs-routing` 复制到 `mods/`。如有同名目录，先备份再替换。

切换到新布局后检查 mod（将路径替换为你的 Herdr 配置目录）：

```sh
herdr-app check "<HerdrHome>/mods/routing"
herdr-app check "<HerdrHome>/mods/skillshare"
herdr-app check "<HerdrHome>/mods/tabs-routing"
herdr-app status
```
