// ComfyUI Mirror Panel — v0.4.0
// 架构：clone-based mirror graph。rootGraph 完全不动。
//
//   - Pin 节点：graph.extra.mirrorPanel.pinned[node.id] = { x, y, title }
//   - 进 Mirror：rootGraph.createSubgraph(...) 拿一个 Subgraph 实例（仅在 _subgraphs map 留条目，
//                不在 rootGraph._nodes 加 wrapper 节点 → 工作流结构零变动）
//                把 pinned 节点 serialize/createNode/configure 克隆进 mirrorGraph
//                canvas.setGraph(mirrorGraph)
//   - 退 Mirror：先 sync mirror→root（用户在 mirror 里改的值同步回 root），
//                再 canvas.setGraph(rootGraph)，再删除临时 subgraph 条目，
//                还原 root widget callback 钩子
//   - 执行：不 hook queuePrompt。queuePrompt → graphToPrompt(this.rootGraph)，
//           原生递归走 root，seed randomize / control_after_generate 在 root 上的原节点上发生
//   - Mirror 视图下点 Queue：执行结束 api.execution_success 触发 → 拉 root 值回 mirror 显示
//   - 双向 widget 同步：mirror.widget.callback 包一层 → 写到 root；
//                       root.widget.callback 包一层（仅 mirror 在场期间）→ 写到 mirror
//
// 不做：graph swap、cover div、queuePrompt hook、graphToPrompt hook。

import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";

const LOG = "[MirrorPanel]";
const VIEW_CANVAS = "canvas";
const VIEW_MIRROR = "mirror";
const SUBGRAPH_NAME = "Mirror Panel";

const state = {
    view: VIEW_CANVAS,
    actionbarBtn: null,
    fallbackBtn: null,
    actionbarObserver: null,
    rootGraph: null,
    mirrorGraph: null,
    mirrorSubgraphId: null,        // 临时 subgraph 在 root._subgraphs 的 key，退出时清理
    nodeIdMap: null,                // origId → mirrorNodeId
    reverseSyncRestorers: [],       // 退出时还原 root widget callback
    apiListenerInstalled: false,
};

// ---------- 工具 ----------

function valueEqual(a, b) {
    if (Object.is(a, b)) return true;
    const ta = typeof a, tb = typeof b;
    if (ta !== tb) return false;
    if (a === null || b === null) return false;
    if (ta !== "object") return false;
    try { return JSON.stringify(a) === JSON.stringify(b); }
    catch (_) { return false; }
}

function getRootGraph() {
    return state.rootGraph || app.canvas?.graph?.rootGraph || app.canvas?.graph || app.graph;
}

function getPinnedMap() {
    const g = getRootGraph();
    if (!g) return {};
    if (typeof g.extra !== "object" || g.extra === null) g.extra = {};
    if (!g.extra.mirrorPanel) g.extra.mirrorPanel = { version: 1, pinned: {} };
    if (!g.extra.mirrorPanel.pinned) g.extra.mirrorPanel.pinned = {};
    return g.extra.mirrorPanel.pinned;
}

function isPinned(node) {
    return !!getPinnedMap()[node.id];
}

function pinNode(node) {
    const map = getPinnedMap();
    map[node.id] = {
        x: 100 + (Object.keys(map).length % 4) * 320,
        y: 100 + Math.floor(Object.keys(map).length / 4) * 220,
        title: node.title || "",
    };
    console.log(`${LOG} pin id=${node.id} title="${node.title}" total=${Object.keys(map).length}`);
}

function unpinNode(node) {
    const map = getPinnedMap();
    delete map[node.id];
    console.log(`${LOG} unpin id=${node.id} total=${Object.keys(map).length}`);
}

// ---------- 兼容性 ----------

function detectEnv() {
    return {
        hasApp: !!app,
        hasGraph: !!app?.graph,
        hasCanvas: !!app?.canvas,
        hasSetGraph: typeof app?.canvas?.setGraph === "function",
        hasCreateSubgraph: typeof app?.graph?.createSubgraph === "function",
        frontendVersion: window.__COMFYUI_FRONTEND_VERSION__ ?? "unknown",
    };
}

// ---------- 样式 ----------

function injectStyles() {
    if (document.getElementById("mirror-panel-styles")) return;
    const style = document.createElement("style");
    style.id = "mirror-panel-styles";
    style.textContent = `
.mirror-toggle-btn {
    cursor: pointer; padding: 4px 10px;
    border: 1px solid #555; background: #2a2a2a;
    color: #ddd; border-radius: 4px;
    font-size: 12px; line-height: 1.4; white-space: nowrap;
}
.mirror-toggle-btn:hover { background: #3a3a3a; }
.mirror-toggle-btn[data-view="mirror"] {
    background: #4a6cf7; border-color: #5a7cff; color: #fff;
}
.mirror-actionbar-btn {
    cursor: pointer; border: none; outline: none;
    background: transparent;
    color: var(--p-button-text-secondary-color, #d4d4d4);
    padding: 0 12px; height: 32px; border-radius: 6px;
    font-size: 13px; font-weight: 500;
    display: inline-flex; align-items: center;
    gap: 6px; white-space: nowrap;
    transition: background 120ms ease, color 120ms ease;
}
.mirror-actionbar-btn:hover {
    background: var(--p-button-text-secondary-hover-background, rgba(255,255,255,0.08));
    color: #fff;
}
.mirror-actionbar-btn[data-view="mirror"] {
    background: linear-gradient(135deg, #5b7cff 0%, #4a6cf7 100%);
    color: #fff;
    box-shadow: 0 1px 3px rgba(74, 108, 247, 0.4);
}
.mirror-actionbar-btn[data-view="mirror"]:hover {
    background: linear-gradient(135deg, #6b8cff 0%, #5a7cff 100%);
    color: #fff;
}
.mirror-actionbar-btn svg {
    width: 14px; height: 14px;
    flex-shrink: 0;
}
/* ComfyUI 的 DomWidget 包装层 bug：内层 textarea/input 被 display:none 后，
   外层 .dom-widget 容器仍然 pointer-events:auto 抢事件（在自定义节点
   "Lora触发词管理"等点过按钮后触发），盖住下半个画布让节点选不中。
   规则：dom-widget 内含隐藏的 textarea/input 就把容器 pointer-events 关掉。 */
.dom-widget:has(> textarea[style*="display: none"]) {
    pointer-events: none !important;
}
.dom-widget:has(> input[style*="display: none"]) {
    pointer-events: none !important;
}
`;
    document.head.appendChild(style);
}

// ---------- 构建 mirrorGraph ----------

function getLGraphCtor() {
    return (typeof LiteGraph !== "undefined" && LiteGraph?.LGraph) || window.LGraph;
}

// 用 createSubgraph 拿一个 Subgraph 实例（不创建 wrapper 节点，仅 _subgraphs map 加条目）
// 退出时按 id/name 清理。这样 ComfyUI 内部认为我们在 subgraph 里，享受 subgraph 优化路径。
function createMirrorSubgraphInstance() {
    const root = state.rootGraph;
    if (!root || typeof root.createSubgraph !== "function") {
        console.warn(`${LOG} rootGraph.createSubgraph not available`);
        return null;
    }
    const id = `mirror-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    try {
        const sg = root.createSubgraph({
            id,
            name: SUBGRAPH_NAME,
            inputs: [], outputs: [], nodes: [], links: [],
            inputNode:  { id: `${id}-in`,  bounding: [-200, 0, 100, 200] },
            outputNode: { id: `${id}-out`, bounding: [ 800, 0, 100, 200] },
        });
        if (sg) {
            state.mirrorSubgraphId = sg.id;
            console.log(`${LOG} mirror subgraph instance created id=${sg.id}`);
            return sg;
        }
    } catch (e) {
        console.warn(`${LOG} createSubgraph failed:`, e?.message || e);
    }
    return null;
}

function purgeMirrorSubgraphsFrom(graph) {
    if (!graph?.subgraphs) return 0;
    let cleaned = 0;
    try {
        const keys = graph.subgraphs.keys ? [...graph.subgraphs.keys()] : Object.keys(graph.subgraphs);
        for (const k of keys) {
            const sg = graph.subgraphs.get ? graph.subgraphs.get(k) : graph.subgraphs[k];
            if (sg?.name === SUBGRAPH_NAME || (typeof k === "string" && k.startsWith("mirror-"))) {
                if (graph.subgraphs.delete) graph.subgraphs.delete(k);
                else delete graph.subgraphs[k];
                cleaned++;
            }
        }
    } catch (e) {
        console.warn(`${LOG} purge failed:`, e);
    }
    return cleaned;
}

function sweepStaleMirrorSubgraphs(reason) {
    const root = app.canvas?.graph?.rootGraph || app.canvas?.graph || app.graph;
    if (!root) return;
    const n = purgeMirrorSubgraphsFrom(root);
    if (n > 0) console.log(`${LOG} sweep (${reason}): cleaned ${n} stale mirror subgraphs`);
}

function pruneDeadPins(reason) {
    const root = app.canvas?.graph?.rootGraph || app.canvas?.graph || app.graph;
    if (!root) return;
    const pinned = root.extra?.mirrorPanel?.pinned;
    if (!pinned) return;
    let cleaned = 0;
    for (const id of Object.keys(pinned)) {
        const numId = Number(id);
        if (!root.getNodeById(isNaN(numId) ? id : numId)) {
            delete pinned[id];
            cleaned++;
        }
    }
    if (cleaned > 0) console.log(`${LOG} prune (${reason}): cleaned ${cleaned} dead pins`);
}

// 把一个 root 节点 clone 进 mirrorGraph
function cloneNodeIntoMirror(origNode, mirrorGraph, layout) {
    // SubgraphNode 当卡片处理：允许 clone（和它包装的 subgraph 实例共享 reference），
    // promoted widgets 能在 mirror 里编辑、值实时同步回 root（原生 widget 路径）。
    // 危险点是 onRemoved 默认会向 this.subgraph.events 派 "widget-demoted"，
    // 还会写 R().setPromotions —— 在共享 subgraph 实例上做这些事会反噬原节点。
    // 处理：clone 完之后改写 mirror 这份的 onRemoved，只关自己的 event controller。
    const isSubgraphNode = !!(origNode.isSubgraphNode?.() || origNode.constructor?.name === "SubgraphNode");
    const data = origNode.serialize();
    const newNode = LiteGraph.createNode(data.type);
    if (!newNode) {
        console.warn(`${LOG} createNode failed for type "${data.type}", skip id=${origNode.id}`);
        return null;
    }
    // 防御：subgraph 类型的 createNode 在某些注册下可能返回 root 那个原节点本身。
    // 此时 mirrorGraph.add(newNode) 会把 root 节点搬过来，mirror.remove 时 graph
    // 被置 null，root 画布再 draw 它就 NullGraphError。检测同实例直接放弃。
    if (newNode === origNode) {
        console.warn(`${LOG} createNode returned same instance for type "${data.type}" id=${origNode.id}, skip`);
        return null;
    }
    mirrorGraph.add(newNode);

    const cloneData = JSON.parse(JSON.stringify(data));
    delete cloneData.id;
    delete cloneData.pos;
    if (Array.isArray(cloneData.inputs)) for (const i of cloneData.inputs) i.link = null;
    if (Array.isArray(cloneData.outputs)) for (const o of cloneData.outputs) o.links = [];
    try { newNode.configure(cloneData); }
    catch (e) { console.warn(`${LOG} configure failed for id=${origNode.id}:`, e); }

    newNode.pos = [layout.x, layout.y];
    newNode.__mirrorOrigId = origNode.id;

    // 共享原节点所有非结构性对象引用 → 任何把状态藏在 node.X 的自定义 widget
    // 都能自动纠缠（properties、intpos、capture、自定义 state... 不限于已知字段）
    // 结构性字段（pos/size/widgets/inputs/outputs/graph/id/type 等）保持独立
    const STRUCTURAL_KEYS = new Set([
        "id", "pos", "size", "min_size", "_pos", "_size", "_posSize",
        "graph", "type", "comfyClass", "constructor",
        "inputs", "outputs", "widgets", "_state",
        "flags", "mode", "order", "color", "bgcolor", "boxcolor",
        "title", "_relative_id", "boundingRect",
        "last_serialization", "serialize_widgets",
        "__mirrorOrigId", "__mirrorReverseOrigCb",
        "onDrawForeground", "onDrawBackground", "onMouseDown", "onMouseUp",
        "onMouseMove", "onMouseLeave", "onMouseEnter", "onDblClick",
        "onConfigure", "onSerialize", "onAdded", "onRemoved",
        "onConnectInput", "onConnectOutput", "onConnectionsChange",
        // subgraph host 关系相关：分享会让 mirror.remove 误伤原节点
        "subgraph", "_subgraph", "_root", "rootGraph", "host",
        "promotedWidgets", "_promotedWidgets",
    ]);
    for (const key of Object.keys(origNode)) {
        if (STRUCTURAL_KEYS.has(key)) continue;
        if (key.startsWith("_") && key !== "_widgets_values") continue;
        const val = origNode[key];
        if (val && typeof val === "object") {
            try { newNode[key] = val; } catch (_) {}
        }
    }

    // widget value 量子纠缠：用 Object.defineProperty 把 mirror widget 的 value
    // 完全代理到原节点 widget 的 value。读总是拿原节点最新值，写总是写到原节点。
    // ComfyUI 1.42 widget 内部走 _state.value 全局 store，单纯 mw.value = X 不会
    // 触发 callback，所以以前 wrap callback 的方案漏了直接赋值的代码（如 ResolutionMaster）
    const len = Math.min(
        Array.isArray(newNode.widgets) ? newNode.widgets.length : 0,
        Array.isArray(origNode.widgets) ? origNode.widgets.length : 0,
    );
    for (let i = 0; i < len; i++) {
        const mw = newNode.widgets[i];
        const ow = origNode.widgets[i];
        if (!mw || !ow) continue;
        const t = (mw.type || ow.type || "").toLowerCase();
        if (t === "button") continue;

        // 在 mirror widget 实例上覆盖 value 访问器（屏蔽原型上的 BaseWidget getter/setter）
        // 某些 widget 的 value 是 configurable:false（不可重定义），跳过即可——
        // callback wrap 路径仍然兜得住通过 callback 改值的情况
        const existing = Object.getOwnPropertyDescriptor(mw, "value");
        if (!existing || existing.configurable !== false) {
            try {
                Object.defineProperty(mw, "value", {
                    configurable: true,
                    enumerable: true,
                    get() { return ow.value; },
                    set(v) {
                        if (Object.is(ow.value, v)) return;
                        ow.value = v;
                    },
                });
            } catch (_) { /* 静默：落到下面 DOM widget 兜底 */ }
        }

        // DOM widget 兜底：addDOMWidget 给 widget.value 装的是 configurable:false 的存取器，
        // 上面的 defineProperty 装不上。这类 widget 的内部 toggle/输入都走
        // widget.value = X → options.setValue(X) → 写到自己的闭包，根本不到对面。
        // 双向包 setValue：mirror→root 让 mirror 内的修改回写 root；
        // root→mirror 让 root 节点 (例如 Lora Manager 的"发送到节点") 更新到 mirror。
        // 两个包装都只调对方的"原始"setValue（不进对方的 wrap），不会形成 setValue 循环。
        if (mw.options && typeof mw.options.setValue === "function" &&
            ow.options && typeof ow.options.setValue === "function") {
            const mwOrigSetValue = mw.options.setValue;
            const owOrigSetValue = ow.options.setValue;
            mw.options.setValue = function (v) {
                const r = mwOrigSetValue.call(this, v);
                try { owOrigSetValue.call(ow.options, v); } catch (_) {}
                return r;
            };
            ow.__mirrorOrigSetValue = owOrigSetValue;
            ow.options.setValue = function (v) {
                const r = owOrigSetValue.call(this, v);
                try { mwOrigSetValue.call(mw.options, v); } catch (_) {}
                return r;
            };
            state.reverseSyncRestorers.push(() => {
                if (ow.__mirrorOrigSetValue && ow.options) {
                    ow.options.setValue = ow.__mirrorOrigSetValue;
                    delete ow.__mirrorOrigSetValue;
                }
            });
        }

        // mirror widget callback 包一层：除了原 callback 行为，再触发 root callback
        // 让其他扩展通过 callback 钩子接收变化
        const mwOrigCb = mw.callback;
        mw.callback = function (v, ...rest) {
            const r = mwOrigCb?.call(this, v, ...rest);
            try { ow.callback?.(v, app.canvas, origNode); } catch (_) {}
            return r;
        };

        // 反向：root 节点 callback 包一层，触发 mirror 重绘（值已自动同步，只需刷屏）
        const owOrigCb = ow.callback;
        ow.__mirrorReverseOrigCb = owOrigCb;
        ow.callback = function (v, ...rest) {
            const r = owOrigCb?.call(this, v, ...rest);
            try { app.canvas?.setDirty?.(true, true); } catch (_) {}
            return r;
        };
        state.reverseSyncRestorers.push(() => {
            ow.callback = ow.__mirrorReverseOrigCb;
            delete ow.__mirrorReverseOrigCb;
        });
    }

    // SubgraphNode 兜底
    if (isSubgraphNode) {
        // 关键：SubgraphNode 构造时往共享的 this.subgraph.events 上挂了一套
        // (input-added / removing-input / output-added / removing-output / renaming-input...)
        // 监听器。pin 多个 wrapper 就在同一个 events bus 上挂多套，任何事件 fire 都会
        // 级联触发所有 mirror clone 的 listener → 卡死。
        // mirror 是只读快照视图，不需要响应 subgraph 内部变更，clone 完立刻 abort。
        try { newNode._eventAbortController?.abort?.(); } catch (_) {}
        try {
            if (Array.isArray(newNode.inputs)) {
                for (const inp of newNode.inputs) {
                    try { inp?._listenerController?.abort?.(); } catch (_) {}
                }
            }
        } catch (_) {}

        // 默认 onRemoved 还会在共享 subgraph events 上派 widget-demoted、
        // 写 R().setPromotions(rootGraph.id, this.id, []) —— 这些会反噬 root 上原节点。
        // listener 已经在上面 abort 掉，无清理可做，换成 noop。
        newNode.onRemoved = function () {};
    }

    return newNode;
}

function buildMirrorGraph() {
    let mirror = createMirrorSubgraphInstance();
    if (!mirror) {
        const LGraph = getLGraphCtor();
        if (!LGraph) {
            console.error(`${LOG} no LGraph constructor available`);
            return null;
        }
        console.warn(`${LOG} fallback to plain LGraph (subgraph optimizations may not trigger)`);
        mirror = new LGraph();
    }

    // mirrorGraph 删节点 → 自动 unpin（用户按 Delete 键 / 用 Remove 菜单都走这里）
    // 不影响 rootGraph 原节点。退出 Mirror 时的批量删除有 _suppressUnpin 标记，不触发 unpin。
    const origOnNodeRemoved = mirror.onNodeRemoved;
    mirror.onNodeRemoved = function (node) {
        try {
            if (!state._suppressUnpin) {
                const origId = node?.__mirrorOrigId;
                if (origId != null) {
                    const map = getPinnedMap();
                    if (map[origId]) {
                        delete map[origId];
                        console.log(`${LOG} mirror node removed → unpinned uid=${origId}`);
                    }
                }
            }
        } catch (_) {}
        if (origOnNodeRemoved) return origOnNodeRemoved.apply(this, arguments);
    };

    const map = getPinnedMap();
    const idMap = {};
    let success = 0, fail = 0;
    for (const [origIdStr, layout] of Object.entries(map)) {
        const origId = Number(origIdStr);
        const orig = state.rootGraph.getNodeById(origId);
        if (!orig) { fail++; continue; }
        const mNode = cloneNodeIntoMirror(orig, mirror, layout);
        if (mNode) { idMap[origId] = mNode.id; success++; }
        else fail++;
    }
    console.log(`${LOG} mirrorGraph built: ${success} cloned, ${fail} failed`);
    return { mirror, idMap };
}

// ---------- 视口 / 布局 ----------

function fitMirrorView() {
    const nodes = state.mirrorGraph?._nodes;
    if (!nodes?.length) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of nodes) {
        const w = n.size?.[0] ?? 200;
        const h = n.size?.[1] ?? 100;
        minX = Math.min(minX, n.pos[0]);
        minY = Math.min(minY, n.pos[1] - 30);
        maxX = Math.max(maxX, n.pos[0] + w);
        maxY = Math.max(maxY, n.pos[1] + h);
    }
    if (!isFinite(minX)) return;
    const cw = app.canvas.canvas.clientWidth || app.canvas.canvas.width;
    const ch = app.canvas.canvas.clientHeight || app.canvas.canvas.height;
    const pad = 80;
    const bw = (maxX - minX) + pad * 2;
    const bh = (maxY - minY) + pad * 2;
    const scale = Math.min(cw / bw, ch / bh, 1);
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const ds = app.canvas.ds;
    if (ds) {
        ds.scale = scale;
        ds.offset[0] = cw / 2 / scale - cx;
        ds.offset[1] = ch / 2 / scale - cy;
    }
    app.canvas.setDirty?.(true, true);
}

function syncMirrorLayoutBack() {
    if (!state.mirrorGraph || !state.rootGraph) return;
    const pinned = state.rootGraph.extra?.mirrorPanel?.pinned;
    if (!pinned) return;
    for (const mNode of state.mirrorGraph._nodes) {
        const origId = mNode.__mirrorOrigId;
        if (origId == null) continue;
        if (pinned[origId]) {
            pinned[origId].x = mNode.pos[0];
            pinned[origId].y = mNode.pos[1];
        }
    }
}

// 全量 mirror → root（兜底，退出时调一次）
function syncMirrorDataToRoot() {
    if (!state.mirrorGraph || !state.rootGraph) return;
    for (const mNode of state.mirrorGraph._nodes) {
        const origId = mNode.__mirrorOrigId;
        if (origId == null) continue;
        const orig = state.rootGraph.getNodeById(origId);
        if (!orig) continue;
        try {
            const len = Math.min(
                Array.isArray(orig.widgets) ? orig.widgets.length : 0,
                Array.isArray(mNode.widgets) ? mNode.widgets.length : 0,
            );
            for (let i = 0; i < len; i++) {
                const ow = orig.widgets[i];
                const mw = mNode.widgets[i];
                if (!mw || !("value" in mw) || !ow) continue;
                const t = (mw.type || ow.type || "").toLowerCase();
                if (t === "button") continue;
                if (valueEqual(ow.value, mw.value)) continue;
                ow.value = mw.value;
                try { ow.callback?.(mw.value, app.canvas, orig); } catch (_) {}
            }
        } catch (_) {}
    }
}

// 全量 root → mirror（执行后调一次，让 randomize 等回写值显示在 mirror）
function syncRootDataToMirror() {
    if (!state.mirrorGraph || !state.rootGraph) return;
    let touched = 0;
    for (const mNode of state.mirrorGraph._nodes) {
        const origId = mNode.__mirrorOrigId;
        if (origId == null) continue;
        const orig = state.rootGraph.getNodeById(origId);
        if (!orig) continue;
        try {
            const len = Math.min(
                Array.isArray(orig.widgets) ? orig.widgets.length : 0,
                Array.isArray(mNode.widgets) ? mNode.widgets.length : 0,
            );
            for (let i = 0; i < len; i++) {
                const ow = orig.widgets[i];
                const mw = mNode.widgets[i];
                if (!mw || !("value" in mw) || !ow) continue;
                const t = (mw.type || ow.type || "").toLowerCase();
                if (t === "button") continue;
                if (valueEqual(mw.value, ow.value)) continue;
                mw.value = ow.value;
                touched++;
            }
        } catch (_) {}
    }
    if (touched > 0) {
        console.log(`${LOG} post-exec sync root→mirror touched ${touched} widgets`);
        app.canvas?.setDirty?.(true, true);
    }
}

// ---------- 视图切换 ----------

function switchView(mode) {
    if (mode === state.view) return;

    if (mode === VIEW_MIRROR) {
        const pinnedCount = Object.keys(getPinnedMap()).length;
        if (pinnedCount === 0) {
            alert("请先右键节点 → Pin to Mirror 标记至少一个节点");
            return;
        }
        state.rootGraph = app.canvas.graph;

        if (app.canvas.ds) {
            state._savedDs = {
                offset: [app.canvas.ds.offset[0], app.canvas.ds.offset[1]],
                scale: app.canvas.ds.scale,
            };
        }

        // ===== 调试探针 =====
        // 深度遍历 + 在 SubgraphNode.prototype 上 wrap rootGraph getter（捕获所有实例）
        try {
            // 1) 在 prototype 上拦 rootGraph getter，throw 之前打 id + this 的引用上下文
            const sample = (state.rootGraph?._nodes || []).find(n => n?.isSubgraphNode?.());
            if (sample) {
                const proto = Object.getPrototypeOf(sample);
                const desc = Object.getOwnPropertyDescriptor(proto, "rootGraph");
                if (desc && desc.get && !proto.__mirrorRootGraphPatched) {
                    const origGet = desc.get;
                    Object.defineProperty(proto, "rootGraph", {
                        configurable: true,
                        enumerable: desc.enumerable,
                        get() {
                            if (!this.graph) {
                                console.error(`${LOG} [PROBE-NULLGRAPH] SubgraphNode id=${this.id} type=${this.type} subgraph=${this.subgraph?.id} about to throw. Walking refs...`);
                                // Find which graph references this node
                                const root = state.rootGraph;
                                const checkGraph = (g, path) => {
                                    if (!g || !g._nodes) return;
                                    if (g._nodes.includes(this)) {
                                        console.error(`  found in ${path}._nodes`);
                                    }
                                    if (g._nodes_by_id?.[this.id] === this) {
                                        console.error(`  found in ${path}._nodes_by_id[${this.id}]`);
                                    }
                                    if (g.subgraphs?.values) {
                                        for (const sg of g.subgraphs.values()) {
                                            checkGraph(sg, `${path}>sg:${sg?.id}`);
                                        }
                                    }
                                };
                                checkGraph(root, "root");
                                if (state.mirrorGraph) checkGraph(state.mirrorGraph, "mirror");
                            }
                            return origGet.call(this);
                        },
                    });
                    proto.__mirrorRootGraphPatched = true;
                    window.__mirrorRootGraphRestore = () => {
                        Object.defineProperty(proto, "rootGraph", desc);
                        delete proto.__mirrorRootGraphPatched;
                    };
                    console.log(`${LOG} [PROBE] patched SubgraphNode.prototype.rootGraph getter`);
                }
            }
        } catch (e) { console.warn(`${LOG} prototype probe failed:`, e); }
        // 2) 深度遍历 + 实例 graph setter（保留之前的，作为补充信号）
        try {
            window.__mirrorGraphProbes = window.__mirrorGraphProbes || [];
            const seen = new Set();
            const probeOne = (n, hostLabel) => {
                if (!n?.isSubgraphNode?.()) return;
                if (n.__mirrorGraphProbed) return;
                const id = n.id;
                let val = n.graph;
                const initialNull = !val;
                Object.defineProperty(n, "graph", {
                    configurable: true,
                    enumerable: true,
                    get() { return val; },
                    set(v) {
                        if (!v && val) {
                            console.error(`${LOG} [PROBE-SET] SubgraphNode id=${id} (host=${hostLabel}) .graph nulled. stack:`, new Error().stack);
                        }
                        val = v;
                    },
                });
                n.__mirrorGraphProbed = true;
                if (initialNull) {
                    console.warn(`${LOG} [PROBE-INIT] SubgraphNode id=${id} (host=${hostLabel}) had .graph=null AT INSTALL TIME (pre-existing)`);
                }
                window.__mirrorGraphProbes.push({ node: n, id, hostLabel, restore: () => {
                    delete n.graph;
                    n.graph = val;
                    delete n.__mirrorGraphProbed;
                }});
            };
            const visit = (g, label) => {
                if (!g || seen.has(g)) return;
                seen.add(g);
                for (const n of g._nodes || []) probeOne(n, label);
                if (g.subgraphs?.values) {
                    for (const sg of g.subgraphs.values()) visit(sg, `${label}>sg:${sg?.id || "?"}`);
                }
            };
            visit(state.rootGraph, "root");
            const ids = window.__mirrorGraphProbes.map(p => `${p.id}@${p.hostLabel}`).join(", ");
            console.log(`${LOG} [PROBE] installed graph setter on ${window.__mirrorGraphProbes.length} SubgraphNode(s). ids: ${ids}`);
        } catch (e) { console.warn(`${LOG} probe install failed:`, e); }

        // 全局 LGraph.remove 钩子：谁 remove SubgraphNode 都打堆栈
        try {
            const LG = (typeof LiteGraph !== "undefined" && LiteGraph?.LGraph) || window.LGraph;
            const proto = LG?.prototype;
            if (proto && !proto.__mirrorRemovePatched) {
                const origRemove = proto.remove;
                proto.remove = function (n) {
                    if (n?.isSubgraphNode?.()) {
                        const isRootNode = state.rootGraph?._nodes?.includes(n);
                        const tag = isRootNode ? "ROOT-NODE" : "non-root";
                        console.error(`${LOG} [PROBE-REMOVE] ${tag} SubgraphNode id=${n.id} being removed by graph (this).id=${this.id}, this===root?${this===state.rootGraph}, this===mirror?${this===state.mirrorGraph}. stack:`, new Error().stack);
                    }
                    return origRemove.apply(this, arguments);
                };
                proto.__mirrorRemovePatched = true;
                window.__mirrorRemoveRestore = () => {
                    proto.remove = origRemove;
                    delete proto.__mirrorRemovePatched;
                };
            }
        } catch (e) { console.warn(`${LOG} remove probe install failed:`, e); }

        // 监控 rootGraph._nodes 数组变更 (push 和 splice)
        try {
            const arr = state.rootGraph?._nodes;
            if (arr && !arr.__mirrorArrayPatched) {
                const origPush = arr.push;
                const origSplice = arr.splice;
                arr.push = function (...nodes) {
                    for (const n of nodes) {
                        if (n?.isSubgraphNode?.()) {
                            console.error(`${LOG} [PROBE-PUSH] root._nodes.push(SubgraphNode id=${n.id} type=${n.type}). stack:`, new Error().stack);
                        }
                    }
                    return origPush.apply(this, nodes);
                };
                arr.splice = function () {
                    if (arguments.length > 1 && arguments[1] > 0) {
                        const removed = origSplice.apply(this, arguments);
                        for (const r of removed) {
                            if (r?.isSubgraphNode?.()) {
                                console.error(`${LOG} [PROBE-SPLICE] root._nodes spliced out SubgraphNode id=${r.id}. stack:`, new Error().stack);
                            }
                        }
                        return removed;
                    }
                    return origSplice.apply(this, arguments);
                };
                arr.__mirrorArrayPatched = true;
                window.__mirrorSpliceRestore = () => {
                    arr.push = origPush;
                    arr.splice = origSplice;
                    delete arr.__mirrorArrayPatched;
                };
            }
        } catch (e) { console.warn(`${LOG} array probe install failed:`, e); }

        const built = buildMirrorGraph();
        if (!built || !built.mirror) {
            console.error(`${LOG} buildMirrorGraph failed`);
            state.rootGraph = null;
            return;
        }
        state.mirrorGraph = built.mirror;
        state.nodeIdMap = built.idMap;

        try { safeSetGraph(state.mirrorGraph); }
        catch (e) {
            console.error(`${LOG} setGraph(mirror) failed:`, e);
            // 还原状态
            for (const r of state.reverseSyncRestorers) try { r(); } catch (_) {}
            state.reverseSyncRestorers = [];
            purgeMirrorSubgraphsFrom(state.rootGraph);
            state.mirrorGraph = null;
            state.nodeIdMap = null;
            state.rootGraph = null;
            return;
        }
        fitMirrorView();
        console.log(`${LOG} entered Mirror (pinned=${pinnedCount})`);
    } else {
        exitMirrorCleanup({ doSetGraph: true });
    }

    state.view = mode;
    syncToggleButtonsLabel();
}

// 抽出退出清理逻辑：正常退出 + 外部检测（用户走 ComfyUI 面包屑）共用
// doSetGraph=false 用于"已经被外部切走"，避免重复 setGraph
function exitMirrorCleanup({ doSetGraph }) {
    if (!state.rootGraph) return;

    syncMirrorDataToRoot();
    syncMirrorLayoutBack();
    for (const r of state.reverseSyncRestorers) try { r(); } catch (_) {}
    state.reverseSyncRestorers = [];

    // 关键：移除 mirror 节点必须在 canvas.graph === mirrorGraph 的上下文里做。
    // 否则 ComfyUI 的 Vue watcher 看到"这节点不在当前图里"会跳过 DOM widget 清理，
    // reactive watcher + DOM 元素留在页面上累积 → 工作流越来越卡。
    // 外部退出（面包屑）时 canvas.graph 已经是 rootGraph 了，需要先临时切回 mirror。
    if (state.mirrorGraph?._nodes?.length) {
        const needTempSwap = !doSetGraph && app.canvas.graph !== state.mirrorGraph;
        if (needTempSwap) {
            try { safeSetGraph(state.mirrorGraph); } catch (_) {}
        }
        state._suppressUnpin = true;
        try {
            const nodesCopy = [...state.mirrorGraph._nodes];
            for (const n of nodesCopy) {
                try {
                    // 已知的第三方插件清理钩子（ComfyUI-Prompt-Assistant 等）
                    try { window.imageCaption?.cleanup?.(n.id, true); } catch (_) {}
                    try { window.promptAssistant?.cleanup?.(n.id, true); } catch (_) {}
                    // 触发自定义 widget 的 onRemove
                    if (Array.isArray(n.widgets)) {
                        const widgets = [...n.widgets];
                        for (const w of widgets) {
                            try { w.onRemove?.(); } catch (_) {}
                        }
                        n.widgets.length = 0;
                    }
                    try { n.properties = {}; } catch (_) {}
                    try { n.intpos = undefined; } catch (_) {}
                    // SubgraphNode clone 不走 LGraph.remove —— 它对 SubgraphNode 有
                    // 特殊清理：[rootGraph, ...rootGraph.subgraphs.values()] 里如果找
                    // 不到其他 wrapper 引用同一个 subgraph，就 forEachNode 调 onRemoved
                    // 并 rootGraph.subgraphs.delete(subgraph.id) —— 在 mirrorGraph
                    // 上下文里这条分支条件不可控（会扫到 mirrorGraph 自己的 subgraphs），
                    // 一旦命中就把 root 上原 SubgraphNode 引用的 subgraph 状态打没，
                    // root 画布下次 draw 那个 wrapper 立刻 NullGraphError。
                    // 手动从 mirror 的 _nodes / _nodes_by_id 摘掉、置 graph=null 即可。
                    if (n.isSubgraphNode?.()) {
                        const arr = state.mirrorGraph._nodes;
                        const idx = arr.indexOf(n);
                        if (idx !== -1) arr.splice(idx, 1);
                        if (state.mirrorGraph._nodes_by_id) {
                            delete state.mirrorGraph._nodes_by_id[n.id];
                        }
                        try { n.graph = null; } catch (_) {}
                    } else {
                        state.mirrorGraph.remove(n);
                    }
                } catch (_) {}
            }
        } finally {
            state._suppressUnpin = false;
        }
        if (needTempSwap) {
            try { safeSetGraph(state.rootGraph); } catch (_) {}
        }
    }

    if (doSetGraph) {
        try { safeSetGraph(state.rootGraph); }
        catch (e) { console.error(`${LOG} setGraph(root) failed:`, e); return; }
    }

    const savedDs = state._savedDs;
    state._savedDs = null;
    if (savedDs && doSetGraph) {
        // ComfyUI 的 ds.min_scale 默认 0.1，但用户用滚轮可以缩到 0.1 以下
        // 我们在 enter Mirror 时若保存了 scale < 0.1，restore 时会被 changeScale 钳到 0.1
        // → 临时把 min_scale 拉低，还原结束后恢复
        const restore = (attempt = 0) => {
            if (!app.canvas.ds) return;
            const ds = app.canvas.ds;
            const origMin = ds.min_scale;
            try {
                if (savedDs.scale < (origMin ?? 0.1)) {
                    ds.min_scale = Math.min(savedDs.scale * 0.5, 0.001);
                }
                ds.scale = savedDs.scale;
                ds.offset[0] = savedDs.offset[0];
                ds.offset[1] = savedDs.offset[1];
                try { ds.offset = [savedDs.offset[0], savedDs.offset[1]]; } catch (_) {}
            } finally {
                // 等 1 帧再恢复 min_scale，避免本帧 watcher 立刻把 scale clamp 回去
                requestAnimationFrame(() => {
                    if (ds.min_scale !== origMin) ds.min_scale = origMin ?? 0.1;
                });
            }
            app.canvas.setDirty?.(true, true);

            const ok = Math.abs(ds.scale - savedDs.scale) < 1e-6
                && Math.abs(ds.offset[0] - savedDs.offset[0]) < 0.5
                && Math.abs(ds.offset[1] - savedDs.offset[1]) < 0.5;
            if (!ok && attempt < 5) {
                requestAnimationFrame(() => restore(attempt + 1));
            } else if (!ok) {
                console.warn(`${LOG} ds restore failed after retries: target scale=${savedDs.scale}, actual=${ds.scale}`);
            }
        };
        requestAnimationFrame(() => restore(0));
    }
    purgeMirrorSubgraphsFrom(state.rootGraph);

    // 卸探针并报告结果
    try {
        const probes = window.__mirrorGraphProbes || [];
        let nulled = 0;
        for (const p of probes) {
            try {
                if (p.node && !p.node.graph) nulled++;
                p.restore?.();
            } catch (_) {}
        }
        if (nulled > 0) console.error(`${LOG} [PROBE] ${nulled} root SubgraphNode(s) had graph=null at exit (see earlier stacks)`);
        window.__mirrorGraphProbes = [];
        try { window.__mirrorRemoveRestore?.(); window.__mirrorRemoveRestore = null; } catch (_) {}
        try { window.__mirrorSpliceRestore?.(); window.__mirrorSpliceRestore = null; } catch (_) {}
        try { window.__mirrorRootGraphRestore?.(); window.__mirrorRootGraphRestore = null; } catch (_) {}
    } catch (e) { console.warn(`${LOG} probe teardown failed:`, e); }

    state.mirrorSubgraphId = null;
    state.mirrorGraph = null;
    state.nodeIdMap = null;
    state.rootGraph = null;
    state.view = VIEW_CANVAS;
    syncToggleButtonsLabel();
    console.log(`${LOG} exited Mirror (doSetGraph=${doSetGraph})`);
}

// hijack canvas.setGraph：检测外部切走 mirror（ComfyUI 面包屑 / 其他扩展导航）
let _setGraphHijacked = false;
let _internalSetGraph = false;  // 标记自己调用，避免误触
function hijackCanvasSetGraph() {
    if (_setGraphHijacked) return;
    const canvas = app.canvas;
    if (!canvas || typeof canvas.setGraph !== "function") return;
    const origSetGraph = canvas.setGraph.bind(canvas);
    canvas.setGraph = function (g, ...rest) {
        const wasInternal = _internalSetGraph;
        const result = origSetGraph(g, ...rest);
        if (!wasInternal && state.view === VIEW_MIRROR && g !== state.mirrorGraph) {
            console.log(`${LOG} external setGraph detected, running cleanup`);
            exitMirrorCleanup({ doSetGraph: false });
        }
        return result;
    };
    _setGraphHijacked = true;
}

// 包装一下我们自己的 setGraph 调用以打标记
function safeSetGraph(g) {
    _internalSetGraph = true;
    try { app.canvas.setGraph(g); }
    finally { _internalSetGraph = false; }
}

// 性能探针：在 console 调用，例如 await mirrorPerf("canvas-baseline")
// 录 N 个 bucket 的 FPS / 最大帧时长，便于客观对比 Canvas 与 Mirror 视图的渲染开销
window.mirrorPerf = function (label = "probe", bucketMs = 500, nBuckets = 10) {
    return new Promise((resolve) => {
        const buckets = [];
        const startAll = performance.now();
        let bucketStart = startAll;
        let frames = 0, maxFrame = 0, lastFrame = bucketStart;
        function tick(t) {
            const dt = t - lastFrame;
            if (dt > maxFrame) maxFrame = dt;
            frames++;
            lastFrame = t;
            if (t - bucketStart >= bucketMs) {
                buckets.push({
                    bucket: buckets.length + 1,
                    tMs: Math.round(t - startAll),
                    frames,
                    fps: +(frames * 1000 / (t - bucketStart)).toFixed(1),
                    maxFrameMs: +maxFrame.toFixed(1),
                });
                bucketStart = t; frames = 0; maxFrame = 0;
            }
            if (buckets.length < nBuckets) requestAnimationFrame(tick);
            else {
                console.log(`%c=== mirrorPerf [${label}] ===`, "color:#4a6cf7;font-weight:bold");
                console.table(buckets);
                const avgFps = buckets.reduce((s, b) => s + b.fps, 0) / buckets.length;
                const worstFrame = Math.max(...buckets.map(b => b.maxFrameMs));
                console.log(`avg FPS: ${avgFps.toFixed(1)}, worst frame: ${worstFrame.toFixed(1)}ms`);
                resolve(buckets);
            }
        }
        requestAnimationFrame(tick);
        console.log(`${LOG} probe started: label="${label}" ${bucketMs}ms × ${nBuckets} buckets, total ${bucketMs * nBuckets / 1000}s`);
    });
};

function syncToggleButtonsLabel() {
    if (state.actionbarBtn) {
        state.actionbarBtn.dataset.view = state.view;
        renderMirrorButtonContent(state.actionbarBtn);
    }
    if (state.fallbackBtn) {
        state.fallbackBtn.dataset.view = state.view;
        state.fallbackBtn.textContent = state.view === VIEW_MIRROR ? "✓ Mirror" : "Mirror";
    }
}

// ---------- 操作栏按钮 ----------

function isVisible(el) {
    if (!el) return false;
    if (el.offsetParent === null) return false;
    const r = el.getBoundingClientRect();
    return r.width > 4 && r.height > 4;
}

function matchButton(btn, name) {
    const t = (btn.textContent || "").replace(/\s+/g, " ").trim();
    const aria = btn.getAttribute("aria-label") || "";
    const title = btn.getAttribute("title") || "";
    const lname = name.toLowerCase();
    return (
        t.toLowerCase().includes(lname) ||
        aria.toLowerCase().includes(lname) ||
        title.toLowerCase().includes(lname)
    );
}

function findAnchorButton() {
    const allBtns = Array.from(document.querySelectorAll("button")).filter(isVisible);
    const candidates = ["运行", "Run", "Queue", "Show Image Feed", "Manager"];
    for (const name of candidates) {
        const btn = allBtns.find((b) => matchButton(b, name));
        if (btn) return { btn, label: name };
    }
    return null;
}

// 简洁的"面板/网格"图标 SVG，避免 emoji 字体兜底问题
const MIRROR_ICON_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/></svg>`;

function renderMirrorButtonContent(btn) {
    btn.innerHTML = `${MIRROR_ICON_SVG}<span>Mirror</span>`;
}

function makeMirrorButton() {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "mirror-actionbar-btn";
    btn.title = "Toggle Mirror Panel view";
    btn.dataset.mirrorBtn = "true";
    btn.dataset.view = state.view;
    renderMirrorButtonContent(btn);
    btn.addEventListener("click", (e) => {
        e.stopPropagation();
        switchView(state.view === VIEW_CANVAS ? VIEW_MIRROR : VIEW_CANVAS);
    });
    return btn;
}

function tryInjectIntoActionbar() {
    if (state.actionbarBtn && document.contains(state.actionbarBtn)) return true;
    const found = findAnchorButton();
    if (!found) return false;
    const btn = makeMirrorButton();
    found.btn.insertAdjacentElement("afterend", btn);
    requestAnimationFrame(() => {
        const rect = btn.getBoundingClientRect();
        const visible = btn.offsetParent !== null && rect.width > 0 && rect.height > 0;
        if (!visible) return;
        if (state.fallbackBtn) { state.fallbackBtn.remove(); state.fallbackBtn = null; }
    });
    state.actionbarBtn = btn;
    console.log(`${LOG} actionbar button inserted after "${found.label}"`);
    return true;
}

function watchActionbar() {
    if (tryInjectIntoActionbar()) return;
    const obs = new MutationObserver(() => {
        if (tryInjectIntoActionbar()) {
            obs.disconnect();
            state.actionbarObserver = null;
        }
    });
    obs.observe(document.body, { childList: true, subtree: true });
    state.actionbarObserver = obs;
    setTimeout(() => {
        if (state.actionbarObserver) {
            state.actionbarObserver.disconnect();
            state.actionbarObserver = null;
        }
    }, 30000);
}

function injectFallbackToggle() {
    if (state.fallbackBtn) return;
    const btn = document.createElement("button");
    btn.className = "mirror-toggle-btn";
    btn.dataset.view = VIEW_CANVAS;
    btn.textContent = "Mirror";
    Object.assign(btn.style, {
        position: "fixed", top: "8px", right: "8px", zIndex: "1000",
    });
    btn.addEventListener("click", () => {
        switchView(state.view === VIEW_CANVAS ? VIEW_MIRROR : VIEW_CANVAS);
    });
    document.body.appendChild(btn);
    state.fallbackBtn = btn;
}

// ---------- 右键菜单 ----------

function buildPinMenuItem(node) {
    if (state.view === VIEW_MIRROR) {
        const origId = node.__mirrorOrigId;
        if (origId == null) return null;
        return {
            content: "✗ Remove from Mirror",
            callback: () => {
                // 直接从 mirrorGraph 删节点 → 触发 mirrorGraph.onNodeRemoved → 清 pin
                try { state.mirrorGraph?.remove(node); }
                catch (e) {
                    // 兜底：直接清 pin map（onNodeRemoved 没触发的情况）
                    const map = getPinnedMap();
                    delete map[origId];
                    console.warn(`${LOG} mirrorGraph.remove failed, fallback to pin delete:`, e);
                }
                app.canvas?.setDirty?.(true, true);
            },
        };
    }
    // Canvas 视图：支持批量。如果当前选中多个节点（含右键的这个），全部一起处理
    const selected = collectSelectedNodes(node);
    const pinned = isPinned(node);
    if (selected.length > 1) {
        // 多选时根据"右键的这个节点"的状态决定整组动作（与原生 unpin/pin 一致）
        const label = pinned
            ? `✓ Unpin ${selected.length} nodes from Mirror`
            : `🪞 Pin ${selected.length} nodes to Mirror Panel`;
        return {
            content: label,
            callback: () => {
                for (const n of selected) {
                    if (pinned) unpinNode(n);
                    else if (!isPinned(n)) pinNode(n);
                }
            },
        };
    }
    return {
        content: pinned ? "✓ Unpin from Mirror" : "🪞 Pin to Mirror Panel",
        callback: () => { if (pinned) unpinNode(node); else pinNode(node); },
    };
}

// 收集当前选中的所有节点（含右键的这个），用于批量 pin/unpin
function collectSelectedNodes(rightClickedNode) {
    const sel = app.canvas?.selected_nodes;
    const out = new Set();
    if (rightClickedNode) out.add(rightClickedNode);
    if (sel) {
        // selected_nodes 可能是 object map (id→node) 或 Set
        if (sel instanceof Set || Array.isArray(sel)) {
            for (const n of sel) if (n) out.add(n);
        } else if (typeof sel === "object") {
            for (const k of Object.keys(sel)) {
                const n = sel[k];
                if (n) out.add(n);
            }
        }
    }
    return [...out];
}

function hijackCanvasMenu() {
    const LGCanvas =
        (typeof LiteGraph !== "undefined" ? LiteGraph?.LGraphCanvas : null) ||
        window.LGraphCanvas ||
        app.canvas?.constructor;
    if (!LGCanvas?.prototype?.getNodeMenuOptions) {
        console.warn(`${LOG} LGraphCanvas.getNodeMenuOptions not found`);
        return false;
    }
    if (LGCanvas.prototype.__mirrorPanelMenuHooked) return false;
    const orig = LGCanvas.prototype.getNodeMenuOptions;
    LGCanvas.prototype.getNodeMenuOptions = function (node) {
        const options = orig.apply(this, arguments);
        try {
            const item = buildPinMenuItem(node);
            if (item && Array.isArray(options)) options.push(null, item);
        } catch (e) {
            console.warn(`${LOG} canvas menu hook error:`, e);
        }
        return options;
    };
    LGCanvas.prototype.__mirrorPanelMenuHooked = true;
    return true;
}

// ---------- 入口 ----------

app.registerExtension({
    name: "MirrorPanel",

    async setup() {
        console.log(`${LOG} setup()`);
        const env = detectEnv();
        console.log(`${LOG} env:`, env);
        if (!env.hasApp || !env.hasGraph || !env.hasCanvas || !env.hasSetGraph) {
            console.error(`${LOG} required APIs missing, abort`);
            return;
        }

        injectStyles();
        const ok = hijackCanvasMenu();
        console.log(`${LOG} canvas menu hook: ${ok ? "ok" : "skipped"}`);
        // 拦截外部 setGraph（ComfyUI 面包屑、第三方导航等）→ 自动跑退出清理
        hijackCanvasSetGraph();

        // 启动 + 工作流加载时清掉前次会话遗留
        sweepStaleMirrorSubgraphs("setup");
        pruneDeadPins("setup");
        if (typeof app.graph?.configure === "function") {
            const orig = app.graph.configure;
            app.graph.configure = function (...args) {
                const r = orig.apply(this, args);
                try { sweepStaleMirrorSubgraphs("graph.configure"); pruneDeadPins("graph.configure"); }
                catch (_) {}
                return r;
            };
        }

        // 节点删除自动 unpin
        if (app.graph) {
            const origOnRemoved = app.graph.onNodeRemoved;
            app.graph.onNodeRemoved = function (node) {
                try {
                    const pinned = state.rootGraph?.extra?.mirrorPanel?.pinned
                        || app.graph?.extra?.mirrorPanel?.pinned;
                    if (pinned && node && pinned[node.id]) {
                        delete pinned[node.id];
                    }
                } catch (_) {}
                if (origOnRemoved) return origOnRemoved.apply(this, arguments);
            };
        }

        // 执行结束后 root → mirror 同步（randomize 等回写值的展示路径）
        if (!state.apiListenerInstalled && api && typeof api.addEventListener === "function") {
            api.addEventListener("execution_success", () => {
                if (state.view === VIEW_MIRROR) syncRootDataToMirror();
            });
            api.addEventListener("executed", () => {
                if (state.view === VIEW_MIRROR) syncRootDataToMirror();
            });
            state.apiListenerInstalled = true;
        }

        injectFallbackToggle();
        watchActionbar();

        console.log(`${LOG} setup OK`);
    },
});

console.log(`${LOG} module loaded`);
