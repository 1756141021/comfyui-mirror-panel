# CHANGELOG

## 1.0.7

修：mirror 视图里能看到 canvas 的组（颜色分区框），操作上没用，还会跟 mirror 里的卡片视觉冲突。

在进入 mirror 时覆盖 `canvas.drawGroups` 为 noop，退出时还原。`mirrorGraph._groups` 仍是 `rootGraph._groups` 的共享引用，Danbooru 组管理器读 `app.graph._groups` 正常，只有渲染层被屏蔽。

## 1.0.6

修：mirror 视图下节点大小（size）退出重进后被重置。

根因：`syncMirrorLayoutBack` 用 `Array.isArray(mNode.size)` 检测大小，但 LiteGraph 的 `node.size` 是 `Float32Array`，不是普通数组，导致保存从未执行，`pinned[origId].w/h` 始终 null，恢复时无值可用。

修法：改用 `sz?.length >= 2 && typeof sz[0] === "number"` 检测；恢复时 in-place 写入（`mNode.size[0] = w`）而非替换引用（避免 Float32Array 引用被覆盖）；`setGraph` 后延一帧再次应用尺寸（防 Vue 响应式更新覆盖）。

修：mirror 视图下图像/预览节点（PreviewImage 等）执行后不实时更新。

根因：mirror 模式下 `canvas.graph === mirrorGraph`，ComfyUI 用 `app.graph.getNodeById` 查节点，在 mirrorGraph 里找不到 origNode（id 不同），故 `origNode.onExecuted` 从不被调用，`origNode.imgs` 永远是旧值。

修法：在 `executed` API 事件里直接从 `event.detail.output` 取图像数据，自己加载进 `mNode.imgs`，img.onload 后触发 mirror canvas dirty；同时转发 `mNode.onExecuted(output)`（兼容 SimpleImageCompare 等 widget 路径节点）。

## 1.0.5

修：pin SubgraphNode（subgraph 包装节点）后退出 mirror 时 `NullGraphError: SubgraphNode N has no graph`。

根因：cleanup 里对 SubgraphNode mirror clone 显式做了 `n.graph = null`。ComfyUI 的 Vue 反应式时序（在 setGraph/purge 完成后的微任务/下一帧）可能把这个 clone 塞进 rootGraph._nodes。此时 clone.graph=null → draw 时 `rootGraph` getter 直接抛。

修法：cleanup 时只从 mirrorGraph._nodes / _nodes_by_id 摘掉，不置 null。如果 clone 出现在 rootGraph._nodes，`clone.graph=mirrorGraph → mirrorGraph.rootGraph → rootGraph`，rootGraph getter 仍然可用，不抛错。clone 持有 mirrorGraph 引用，等 rootGraph 失去 clone 引用时再 GC。

## 1.0.4

修：第二次进 mirror 退出时报 root SubgraphNode `NullGraphError` —— 之前 1.0.3 只挡了构造侧（同实例 skip + abort listener），删除侧没动。

`LGraph.remove(node)` 对 SubgraphNode 有一段特殊清理：扫 `[this.rootGraph, ...this.rootGraph.subgraphs.values()]` 里有没有其他 wrapper 引用同一个 subgraph，没找到就 `forEachNode(subgraph, onRemoved)` 然后 `rootGraph.subgraphs.delete(subgraph.id)` 把 subgraph 从 root map 里删掉。退出 mirror 时 `mirrorGraph.remove(clone)` 触发这条扫描，扫描会把 mirrorGraph（自己也是 root 的一个 subgraph）也算进去，命中"无其他 wrapper" 分支的概率不可控 —— 一旦命中，root 上原 wrapper 引用的 subgraph 状态被打没，下次 draw 抛 NullGraphError。

修法：cleanup 时对 SubgraphNode clone 不走 `LGraph.remove`，手动从 mirror 的 `_nodes` / `_nodes_by_id` 摘掉再置 `graph=null`，绕开那段共享状态破坏逻辑。

## 1.0.3

修：pin 多个 SubgraphNode 时会卡死（甚至触发 root 节点 NullGraphError）。

两个根因：
1. `LiteGraph.createNode(subgraphType)` 在某些注册下可能返回 root 那个原 SubgraphNode 实例本身。`mirrorGraph.add(it)` 把 root 节点搬过来，退出 mirror 时 `mirror.remove` 把它的 `graph` 置 null，root 画布再 draw 它就 NullGraphError。
2. SubgraphNode 构造时往共享的 `this.subgraph.events` 上挂一套监听器。pin N 个 wrapper 就在同一个 events bus 上挂 N 套，任何事件 fire 全部级联 → 卡死。

修法：
- clone 完检测 `newNode === origNode`，是同一个实例就跳过。
- 真正的新实例，立刻 abort 它的 `_eventAbortController` 和每个 input 的 `_listenerController`，让 mirror 不在共享 bus 上听事件。mirror 是只读快照视图，不需要响应 subgraph 内部变更。

## 1.0.2

支持把 SubgraphNode（subgraph 包装节点）pin 进 mirror 当卡片用 —— promoted widget 能在 mirror 里编辑，值通过原生路径回到 root。

之前 v1.0.0 直接拒了，因为 SubgraphNode 默认的 `onRemoved` 会在共享的 subgraph 实例上派 `widget-demoted` 事件、还会写 `R().setPromotions` —— 退出 mirror 时会反噬 root 上的原节点。

修法：clone 完 SubgraphNode 之后，把 mirror 这份的 `onRemoved` 换成只关自己的 event controller / 输入 listener，不动 subgraph events、不动 promotions store。

## 1.0.1

修：DOM widget 双向同步。

之前症状：
- mirror→canvas 单向不通：mirror 内的 toggle/输入只更新 mirror 自己的闭包，按 Run 用的是 root 上的旧值。
- canvas→mirror 单向也不通：Lora Manager 的"发送到节点"或者外部修改 root 节点的 widget 值，mirror 看不到。

根因：ComfyUI 的 `addDOMWidget` 在 widget 实例上装的 `value` 是 `configurable: false` 的存取器，原本想接管的 `Object.defineProperty(mw, "value")` 装不上。所有 DOM widget 的写都走 `widget.value = X → options.setValue(X) → 写到自己的闭包`，对面节点完全感知不到。

修法：clone 时双向包 `options.setValue`。`mw.options.setValue` 包一层先调原 setValue 再写 ow；`ow.options.setValue` 同样包一层先调原 setValue 再写 mw。两个包装都引用对方的"原始" setValue，没有循环。退出 mirror 时还原 ow 那一层。

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
