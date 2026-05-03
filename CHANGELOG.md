# CHANGELOG

## 1.0.1

修：DOM widget 在 mirror 内改值同步不到 canvas（典型表现：Lora Manager 的 toggle 在 mirror 里关掉一个 lora，按 Run 后所有 lora 又被勾上）。

根因：ComfyUI 的 `addDOMWidget` 在 widget 实例上装的 `value` 是 `configurable: false` 的存取器，原本依赖 `Object.defineProperty(mw, "value")` 接管的代理装不上。这类 widget 的内部状态都走 `widget.value = X → options.setValue(X) → 写到自己的闭包`，到不了 root 节点。

修法：mw clone 时再包一层 `mw.options.setValue`，原 setValue 跑完后用同一个值再调一遍 `ow.options.setValue`，让 root 闭包同步更新。callback wrap 路径不变。

## 1.0.0

首个稳定版本。架构与全部修复在 200+ 节点真实工作流上验证通过。

### 架构（最终）

- Pin 状态存 `graph.extra.mirrorPanel.pinned`（按节点 id），跟随 workflow JSON 持久化
- 进 Mirror：`rootGraph.createSubgraph` 拿一个 Subgraph 实例（仅在 `_subgraphs` map 留条目，**不**在 `_nodes` 加 wrapper 节点 → 工作流结构零变动），克隆 pinned 节点进入，`canvas.setGraph(mirror)`
- 退 Mirror：`canvas.setGraph(rootGraph)` + 显式 remove 每个 mirror 节点（触发 ComfyUI DOM widget 卸载）+ purge 临时 subgraph 条目
- 量子纠缠（数据双向同步零延迟）：
  - mirror clone 共享原节点的 `properties` / `intpos` / `capture` 等所有非结构性 object 引用（结构性字段如 pos/size/widgets/inputs/outputs/graph 保持独立）
  - mirror widget 的 `value` 用 `Object.defineProperty` 代理到原节点的 widget value
- 执行：不 hook queuePrompt。`app.queuePrompt → graphToPrompt(this.rootGraph)` 原生走 root，seed randomize / control_after_generate 等钩子全部原生路径触发
- 执行结束 `api.execution_success` / `executed` → 触发 mirror 重绘，显示 root 回写值
- 外部 setGraph 拦截（用户走 ComfyUI 面包屑或第三方导航离开 mirror 时自动跑清理）
- SubgraphNode 拒绝克隆（pin 一个 subgraph 包装节点本不合理，且共享 host 关系会造成 NullGraphError）
- 批量 pin/unpin：选中多个节点右键，菜单显示数量

### 性能（200+ 节点工作流实测）

| 测试 | 平均 FPS | 最差帧 |
|------|---------|--------|
| canvas-idle | ~204 | 16.8 ms |
| canvas-pan  | ~24  | 96.0 ms |
| mirror-idle | ~240 | 4.4 ms |
| mirror-pan  | ~98  | 45.7 ms |

拖动场景 Mirror 比 Canvas 快 4 倍，最差帧砍半。

## 0.4.x — 开发期废弃版本

期间走过的弯路，仅作记录：

- 0.3.x：`convertToSubgraph` 物理改了用户工作流（插入 wrapper + 重连），违背"不动原工作流"。废弃。
- 0.2.x：`canvas.setGraph(mirrorGraph)` + clone + 手动 widget 同步 + 执行时 graph swap + cover div 遮闪。补丁越堆越多，0.4 重写。
- 0.1.x：DOM 投射方案。`DomWidget.vue` 的 watch 持续给 detach 出去的元素写 style，方案不可行。
