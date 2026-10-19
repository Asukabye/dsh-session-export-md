# dsh-session-export-md

DSH 插件：把一次会话的对话导出为 Markdown 文档（语义分段、按时间顺序分轮、每轮产物清单、增量只追加、编辑/撤回标记），并向模型暴露 `export_conversation` 工具。

本仓库是该插件的**树外（tree-out）发行版**：源码从 dsh monorepo 的 `packages/session/session-export-md` 抽出，构建改为自包含（`tsdown.standalone.config.ts`），以便用 `dsh plugin add` 直接安装。

---

## 一、安装（GitHub 私有仓库）

前提：本机已安装 `dsh`（CLI）、`git` 能访问这个私有仓库、`pnpm` ≥ 10。

### 1. 把仓库加进 profile

```sh
dsh plugin --profile <profile名> add github:Asukabye/dsh-session-export-md#<commit-sha>
```

首次会失败——pnpm 拒绝执行 git 依赖的 `prepare` 构建脚本。按报错提示，在 **profile 目录的 `pnpm-workspace.yaml`** 里加一行授权：

```yaml
allowBuilds:
  dsh-session-export-md: true
```

然后重跑同一条 `add`。授权意味着允许该包的代码在你机器上、于安装时执行（不在 agent 沙箱内），所以只对你信任的仓库授权，并用 commit sha 锁定（后续 push 不会悄悄替换实际运行的代码）。

私有仓库认证二选一：

- **SSH**（推荐）：`git config --global url."git@github.com:".insteadOf "https://github.com/"`，并确保 `ssh -T git@github.com` 通过；
- **Token**：`dsh plugin --profile <profile名> add https://<TOKEN>@github.com/Asukabye/dsh-session-export-md.git#<sha>`。

### 2. 挂载 `export_conversation` 工具（需要一步手工配置）

模型工具目录只读取 **agent 预设层** 的工具注册，宿主层的注册不会进入模型可见目录。所以除了 bundle 自动插入的宿主行，还要在 agent 预设里加一行：

```yaml
- id: session-export-tool
  name: dsh-session-export-md/tool
```

两种加法：

- **源码 checkout 运行**（`pnpm dsh ...`）：直接编辑 `packages/preset/agent-presets/presets/standard/agent.cordis.yml`，追加上述两行；预设运行时直读包目录的 `presets/`，无需重新打包，但**重启后新会话才生效**。
- **已安装的 dsh**：在 `$DSH_HOME/.agent-presets/<预设名>/agent.cordis.yml` 建一个基于 `standard` 的自定义预设，追加同样两行，然后在界面上选择该预设。

只想要界面里的「导出为 Markdown」按钮、不要模型工具时，可跳过这一步：宿主行与浏览器半由 bundle 自动装配。

### 3. 验证

```sh
dsh --profile <profile名> --dump-config | Select-String "dsh-session-export-md"
dsh --profile <profile名>
```

会话头部的「…」菜单里会出现导出入口；导出结果默认写到会话工作区根目录的 Markdown 文件。

---

## 二、配置项

宿主行可选配置（`cordis.patch.yml` / profile 的 patch 里改写该行的 `config`）：

| 字段 | 默认值 | 含义 |
|---|---|---|
| `provider` | `''` | 显式指定 provider 路由；空 = 跟随会话当前模型 |
| `model` | `''` | 显式指定模型；空 = 跟随会话当前模型 |
| `localBaseUrl` | `''` | OpenAI 兼容的本地端点（如 `http://127.0.0.1:11434/v1`）；空 = 不启用本地 |
| `localModel` | `''` | 本地模型名 |
| `remoteBaseUrl` | `https://api.deepseek.com` | 仅当宿主未暴露 `llm` 服务时的兜底端点（该路径从环境变量 `DEEPSEEK_API_KEY` 取凭据） |
| `remoteModel` | `deepseek-flash` | 上述兜底路径的模型 |

分类输入按 2000 字符/段截断、每批 8 轮、单批最多 3 次尝试；整批失败时回落到各维度的兜底模块，并在对话框里报告，导出仍然成功。

---

## 三、导出文档格式（format = 10）

```text
---
format: 10
date: <日期>  session: <会话 id>  workspace: <工作区>  turns: <轮数>
---
# 对话信息
## 目录
### 开发阶段
**1. 需求分析**（5 轮）
- [[#第 1 轮：标题]]
## 对话正文
### 第 1 轮：标题
#开发阶段/其他 #对话功能-目的/问答型
> [!question] 用户
> [!quote] 回答
> [!example]- 产物（N 个文件 · 命令 3 / 链接 1）
## 备注
```

产物写在文档旁的 `<文档名>.artifacts/第N轮-产物.md`；单轮命令超过 10 条或条目超过 24 个时拆成 `-命令` / `-其它` 两个文件。

---

## 四、开发

```sh
pnpm install              # 装 tsdown + lightningcss（构建用）
pnpm run build            # 等价于 prepare，产物在 lib/
```

构建产物（不入库）：

- `lib/index.js` + `lib/tool.js` + 共享 chunk —— Node 半边，`@deepseek-ai/*` 全部保持 external，其余（zod 等）内联；
- `lib/client.js` —— 浏览器半边，`window.__ModuleLoader__.load({ id, factory })` 闭包工厂 + CSS Modules 内联。

`@deepseek-ai/*` 不做依赖声明：运行期由 dsh 安装本身提供（`$DSH_HOME/profiles/node_modules` 是安装依赖闭包的镜像），这样插件与宿主共享同一份模块实例（cordis 服务、工具/存储域身份都依赖这一点），也避免 pnpm 把宿主模块再装一份到 profile 里、造成两套实例。

`tests/` 是从 monorepo 带过来的 vitest 用例，运行需要 dsh checkout 提供宿主包，故本仓库不提供 `test` 脚本。

## 五、已知限制

- 轮次标题由分类模型生成并缓存复用；模型没给时退化为问题前 20 字符。
- 超过 1200 字符的回答会折进 `<details>`；阈值是常量。
- 无会话标题时，标题退化为会话 id 前缀。
- 写入目标是会话工作区根目录（`header.cwd`）；更严格的部署由沙箱策略约束该写入。
- 本发行版构建自 dsh `0.1.6-alpha.1` 的 checkout；`@deepseek-ai/*` 的运行期 API 若在更高版本中变更，需要同步更新。

## 六、许可

MIT © 2026 Asukabye
