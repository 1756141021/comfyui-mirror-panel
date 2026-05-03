# ComfyUI Mirror Panel

> **ComfyUI 当后端，前面套一张你自己排版的 WebUI 面板。一个插件。**
>
> Pin 出你真正常改的几个节点，自由排版。原工作流原封不动躺在后面。其他几百个节点不渲染、不加载，主画布卡顿一夜清零。

[English version below](#english)

---

## 中文

### 这个插件解决什么问题

ComfyUI 的工作流容易长大。节点到 200+ 之后，画布拖动一秒只剩 20 多帧，最差一帧能卡到 90+ 毫秒。每次想改个 seed、调个 cfg、切个 sampler，都要在一片节点里翻找、缩放、定位。

`group` 管理器牵一发动全身，动一个分组其他全乱。原生 subgraph 性能是好，但要你拆掉现有结构——布局明明已经顺手了，只是想要一个干净的操作面板而已。

社区现有方案各有缺口：
- **ComfyBox / SwarmUI / ComfyWeb** 是独立前端，跟 ComfyUI 解耦，没法实时编辑节点
- **rgthree / Workspace Manager** 偏向节点开关、工作流组织，没有"选择性渲染 + 双向同步"
- **原生 subgraph** 解决了渲染性能，代价是物理改造你的工作流结构

Mirror Panel 把这两件事拆开：你要改的节点，和完整的工作流。
- 完整工作流原样躺在 Canvas 里，结构、连线、布局一字不动
- 你 pin 出来的节点在 Mirror 视图里组成一张独立面板，自由拖排版
- Mirror 里改值就是改原节点。量子纠缠，不是同步回写
- 切到 Mirror 时主画布完全停渲染。性能等同于 subgraph 内部视图

---

### 功能

#### 视图切换
- 顶栏 🪞 Mirror 按钮，一键在 Canvas / Mirror 之间切换
- 退出按钮 / ComfyUI 原生面包屑 / 第三方导航离开 Mirror 都会自动跑清理，不会留下状态垃圾

#### Pin 节点
- 在 Canvas 视图右键任意节点 → "🪞 Pin to Mirror Panel"
- 选中多个节点右键 → 菜单显示 "🪞 Pin N nodes to Mirror Panel"，一键批量
- 已 pin 的节点右键 → "✓ Unpin from Mirror"

#### Mirror 视图内编辑
- pinned 节点以独立卡片形式出现，可自由拖动排版
- 改 widget 值（数字、下拉、开关、文本、自定义 DOM widget）→ 原节点立即同步
- 自定义节点（如分辨率大师、词库面板）的内部状态（properties / intpos / 自定义字段）也完全同步
- 在 Mirror 里右键卡片 → "✗ Remove from Mirror"，立即从面板移除（原节点完全不动）
- 选中卡片按 Delete 键也行，效果一样

#### 执行
- 在 Mirror 视图下点 Queue Prompt 正常执行
- seed randomize、control_after_generate 等所有钩子在原节点上自然触发
- 执行结束 mirror 卡片自动显示新值（如 randomize 后的 seed）

#### 持久化
- pin 列表 + 卡片位置存进 workflow JSON 的 `graph.extra.mirrorPanel`
- 保存 / 加载 workflow，Mirror 状态完整还原
- 删除原节点 → 自动从 pin 表移除，不会留幽灵卡片

#### 性能（200+ 节点工作流实测）

| 场景 | Canvas | Mirror |
|------|--------|--------|
| 静止 | ~204 fps / 16.8ms 最差帧 | ~240 fps / 4.4ms 最差帧 |
| 拖动 | ~24 fps / 96.0ms 最差帧 | ~98 fps / 45.7ms 最差帧 |

拖动场景 Mirror 比 Canvas **快 4 倍**，最差帧砍半。

---

### 安装

将本仓库 clone 到 `ComfyUI/custom_nodes/`：

```bash
cd ComfyUI/custom_nodes
git clone https://github.com/1756141021/comfyui-mirror-panel.git
```

重启 ComfyUI，刷新浏览器。顶栏会出现 🪞 Mirror 按钮。

要求：ComfyUI frontend ≥ 1.42（依赖 `rootGraph.createSubgraph`、`canvas.setGraph` 等 API）

---

### 使用流程

1. 加载你的工作流
2. 右键想常改的节点 → "🪞 Pin to Mirror Panel"（可多选批量）
3. 点顶栏 🪞 Mirror 进入 Mirror 视图
4. 在 Mirror 里自由排版卡片、改值、运行
5. 切回 Canvas → 你的工作流原样在那里，刚才的所有改动都已落到原节点上
6. 保存 workflow，下次打开 pin 列表 + 卡片位置都还在

---

### 架构（简）

- **Pin 数据**：`graph.extra.mirrorPanel.pinned[nodeId] = { x, y, title }`，跟随 workflow JSON 序列化
- **Mirror Graph**：`rootGraph.createSubgraph()` 拿一个 Subgraph 实例（**不**在 root 加可见 wrapper 节点），克隆 pinned 节点进去，`canvas.setGraph(mirror)` 切换视图
- **量子纠缠**：mirror clone 共享原节点的 properties / intpos / 自定义对象引用；widget 的 value 用 `Object.defineProperty` 代理到原节点
- **执行**：完全不 hook。`app.queuePrompt → graphToPrompt(rootGraph)` 原生走根图，所有钩子在原节点上触发
- **退出清理**：显式 remove 每个 mirror 节点（触发 ComfyUI DOM widget 卸载）→ purge 临时 subgraph 条目 → 还原视口

详见 [CHANGELOG.md](CHANGELOG.md)。

---

### 限制

- **SubgraphNode 不能 pin**：subgraph 包装节点和它的 host 关系复杂，pin 它本身意义不大（应该进 subgraph 内部编辑）。控制台会有 log 提示。
- **少数 widget value 是 `configurable: false`**：无法用 defineProperty 代理，会落到 callback wrap 兜底——通过菜单/键盘改值仍会同步，但代码直接 `widget.value = X` 赋值不会即时反映。极少节点遇到。

---

### License

GPL-3.0-or-later，详见 [LICENSE](LICENSE)。

---

<a name="english"></a>

## English

> **ComfyUI workflow as backend + a freely-arrangeable WebUI-style frontend — in one plugin.**
>
> Pin the few nodes you actually keep editing, lay them out however you want. The full workflow sits untouched behind it. The other 200+ nodes stop rendering. Your canvas lag is gone overnight.

### What problem this solves

ComfyUI workflows tend to grow. Once you cross 200+ nodes, panning the canvas drops to ~24 fps with worst-frame spikes near 100ms. Every time you want to nudge a seed, tweak a CFG, or switch a sampler, you're hunting through the maze, zooming, repositioning. The `group` manager is brittle — moving one group breaks others. Native subgraphs solve rendering performance, but at the cost of physically restructuring your workflow.

Existing community options each fall short:
- **ComfyBox / SwarmUI / ComfyWeb** are separate frontends, decoupled from ComfyUI — can't edit nodes live
- **rgthree / Workspace Manager** focus on toggling and organizing nodes, no selective rendering + bidirectional sync
- **Native subgraph** fixes performance, but mutates your workflow structure

Mirror Panel cleanly separates "the few nodes I keep editing" from "the full workflow":
- Full workflow stays in Canvas, structure / wires / layout untouched
- The nodes you pin appear in a Mirror view, freely arrangeable
- Editing a value in Mirror **is** editing the original node (quantum entanglement, not sync-and-write-back)
- When in Mirror, the main canvas stops rendering entirely — performance equivalent to being inside a subgraph

---

### Features

#### View switching
- Toolbar 🪞 Mirror button toggles between Canvas / Mirror
- Exiting via the button, ComfyUI's native breadcrumb, or any third-party navigation triggers proper cleanup — no leftover state

#### Pinning
- Right-click any node in Canvas view → "🪞 Pin to Mirror Panel"
- Select multiple nodes, right-click → "🪞 Pin N nodes to Mirror Panel" (batch)
- Right-click pinned node → "✓ Unpin from Mirror"

#### Editing in Mirror
- Pinned nodes appear as standalone cards, free to drag and arrange
- Changing widget values (number, dropdown, toggle, text, custom DOM widget) syncs to the original instantly
- Custom node internal state (properties, intpos, custom fields) syncs too
- Right-click a card in Mirror → "✗ Remove from Mirror", removed immediately (original node untouched)
- Or select card + press Delete

#### Execution
- Queue Prompt works normally from Mirror view
- seed randomize, control_after_generate, all execution hooks fire on the original nodes
- Mirror cards auto-update with post-execution values (e.g., new randomized seed)

#### Persistence
- Pin list + card layout stored in `graph.extra.mirrorPanel` of the workflow JSON
- Save / reload workflow → Mirror state fully restored
- Deleting an original node auto-unpins it — no ghost cards

#### Performance (measured on 200+ node workflow)

| Scenario | Canvas | Mirror |
|----------|--------|--------|
| Idle | ~204 fps / 16.8ms worst frame | ~240 fps / 4.4ms worst frame |
| Panning | ~24 fps / 96.0ms worst frame | ~98 fps / 45.7ms worst frame |

Mirror is **4x faster** than Canvas during interaction, with half the worst-frame time.

---

### Install

Clone into `ComfyUI/custom_nodes/`:

```bash
cd ComfyUI/custom_nodes
git clone https://github.com/1756141021/comfyui-mirror-panel.git
```

Restart ComfyUI, refresh browser. The 🪞 Mirror button appears in the toolbar.

Requirements: ComfyUI frontend ≥ 1.42 (uses `rootGraph.createSubgraph`, `canvas.setGraph` APIs).

---

### Usage

1. Load your workflow
2. Right-click the nodes you keep tweaking → "🪞 Pin to Mirror Panel" (multi-select supported)
3. Click the toolbar 🪞 Mirror to enter Mirror view
4. Arrange cards, edit values, run prompts freely
5. Switch back to Canvas → your workflow is exactly as it was, every edit applied to the originals
6. Save the workflow — pin list + card positions persist across sessions

---

### Architecture (brief)

- **Pin data**: `graph.extra.mirrorPanel.pinned[nodeId] = { x, y, title }`, persisted with the workflow JSON
- **Mirror graph**: `rootGraph.createSubgraph()` returns a Subgraph instance (no visible wrapper node added to root); pinned nodes are cloned into it; `canvas.setGraph(mirror)` switches view
- **Quantum entanglement**: mirror clones share the original's `properties` / `intpos` / custom object refs; widget `value` is proxied via `Object.defineProperty` to the original's widget
- **Execution**: zero hooks. `app.queuePrompt → graphToPrompt(rootGraph)` walks the root natively, all hooks fire on originals
- **Exit cleanup**: explicitly remove each mirror clone (triggers ComfyUI DOM widget unmount) → purge temp subgraph entries → restore viewport

See [CHANGELOG.md](CHANGELOG.md) for full history.

---

### Limitations

- **SubgraphNodes cannot be pinned**: their host relationship with the wrapped subgraph is too entangled to clone safely. Pinning them isn't really meaningful anyway (you'd want to enter the subgraph instead). Console will log a notice.
- **A small number of widgets have `configurable: false` value**: those can't be proxied via defineProperty, falling back to callback-wrap. Menu / keyboard edits still sync, but direct `widget.value = X` assignments may not reflect immediately. Rarely encountered.

---

### License

GPL-3.0-or-later, see [LICENSE](LICENSE).
