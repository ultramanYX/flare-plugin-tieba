# 贴吧 Flare 插件

给 [Flare](https://github.com/DimensionDev/Flare) 用的百度贴吧适配器，基于 Social Plugin API v1。
数据来源是贴吧**移动端页面**（`/mo/q/...`），不依赖客户端签名接口，也不引用任何私有 API。

## 功能

| Flare 能力 | 实现 | 数据来源 |
| --- | --- | --- |
| `timeline`（贴吧热议，默认） | 热议话题流 | `GET /mo/q/hotMessage/list?fr=newwise` |
| `timeline`（吧内帖子流） | 某个吧的帖子列表，支持向上翻页 | `GET /mo/q/m?kw=<吧名>&pn=<页码>` |
| `tab-catalog` | 「我关注的吧」「推荐吧」动态目录 | `GET /mg/o/getForumHome` |
| `post.detail` | 主题帖正文（标题 + 1 楼） | `GET /mo/q/m?kz=<tid>&pn=1` |
| `post.context` | 楼层列表，按 30 层一页向后翻 | `GET /mo/q/m?kz=<tid>&pn=<楼层偏移>` |

未实现：发帖、回帖、楼中楼（楼内回复）、搜索、个人主页、关注/取消关注。这些需要登录态写接口或额外签名，本插件不伪造。

## 登录

`WebCookie` 方式：在 Flare 内置浏览器打开 `tieba.baidu.com` 并登录，Host 收集 Cookie 后用
`/mo/q/newmoindex?need_user=1` 校验身份（要求 `BDUSS` + `BAIDUID`）。

未登录时贴吧会对非浏览器来源返回 403「百度安全验证」；插件会把这种情况报成
`AuthenticationRequired`，提示重新登录，而不是给一个空列表。

## 安装

### Git 仓库（推荐）

1. 确保**仓库根目录**直接包含 `manifest.json`、`plugin.js`、`assets/icon.png`、`locales/`
   （不要再套一层子目录，也不要只上传 zip）
2. 打一个与 `manifest.version` 完全一致的 tag，例如 `0.1.0` 或 `v0.1.0`——
   **没有 tag 的仓库在 Flare 里没有可安装版本**
3. Flare → 设置 → 插件 → `+` → 填入仓库地址 → 安装 → 确认权限
4. 添加账号：平台填 `tieba.baidu.com`（不带 `https://`），检测到「贴吧」后走浏览器登录

```sh
git add -A
git commit -m "feat: publish plugin files at repository root"
git tag 0.1.0
git push origin main --tags
```

### 本地开发

```sh
npm install
npm run dev      # 监听 src/plugin.ts，重建根目录 plugin.js
npm run check    # TypeScript 类型检查
npm run build    # 类型检查 + 构建
```

Flare Desktop：设置 → 插件 → 右上角菜单 → **Plugin development**，选择本目录；
改动后点 **Reload plugin**。

## 权限

`mediaNetwork: true`，用于加载头像与帖子图片（`himg.bdimg.com`、`tiebapic.baidu.com`、
`gsp0.baidu.com` 等 CDN）。

## 与社区版本（anamaxlec/flare-tieba-plugin）的差异

社区版本跑不动的原因，是它依赖的入口已经变了：

| 问题 | 社区版本 | 本版本 |
| --- | --- | --- |
| 吧内帖子流 | `GET /f?kw=...` 解析 `frs_data` JSON | 该地址现在返回**小程序 SPA 空壳**（无 `frs_data`），改为解析 `/mo/q/m?kw=` 的移动端 HTML 列表 |
| 热议流 | `/mo/q/hotMessage/list` | 接口仍在，但**无 Cookie 时返回空 body**；已加 Cookie 传递与 403 提示 |
| 正文截断 | 正则 `<div class="content">([\s\S]*?)</div>` 惰性匹配 | 正文里有嵌套 `<div>`（图片容器），惰性匹配会截断；改为**按 div 深度配对**提取 |
| 帖子图片 | 只从 `<img src>` 取 | 贴吧用 `data-url` 懒加载（`<div class="pb_img_item" data-url='...'>`），已转换为 `<img src>` 后再取 |
| 楼层分页 | `pn` 当页码，`pn=page` | 实测 `pn` 是**楼层偏移**：`pn=1` 给 1~31 楼，之后每页 +30 层 |
| 403 处理 | 报 `Remote` 通用错误 | 单独识别百度安全验证，报 `AuthenticationRequired` |

## 验证情况

在本地用 mock Host（`vm` 里注入 `flare.http.request` → `fetch`，真实 Cookie）跑通了：

- 热议流：5 条
- 吧内帖子流（原神吧）：30 条，作者/时间/回复数/图片正确，`older` 翻页内容不重复
- 目录：推荐吧 12 个
- 帖子详情：标题 + 1 楼正文，含图帖子 `media` 抽取正确
- 楼层：连续 3 页，内容按 30 层递进
- 无 Cookie：返回 `AuthenticationRequired` + 中文提示

**未验证**：真实 Flare 客户端内的 UI 渲染、浏览器登录回调、以及长时间运行下的风控表现。
`pack.mjs` 打包与 `manifest.schema.json` 校验均已通过。

## 已知限制

- 楼层翻页按 30 层步进，贴吧会在边界处做折叠，可能出现 1~2 层的重叠或跳过
- 部分老旧帖子会返回「该帖已被删除」提示页，插件会报 `NotFound`
- 图片 URL 带 `tbpicau` 时效参数，过期后需要重新拉取帖子
