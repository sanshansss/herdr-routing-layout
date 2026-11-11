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

已在 Herdr app 0.1.14 验证。把下面提示词交给能访问本机 Herdr 配置的 Agent：

```text
读 ~/.config/herdr-app/AGENTS.md，然后从 https://github.com/sanshansss/herdr-routing-layout 获取 magpie-routing-v1/，按其中 RECIPE.md 安装布局和所需 mods。先检查并备份同名文件，不要改动其他配置；安装后运行 herdr-app check 和 herdr-app status，确认无错误后切换到这个布局。
```

Routing 数据来自 Magpie 的 `~/.config/magpie/routing/*.jsonl`；没有日志时面板会显示空状态。
