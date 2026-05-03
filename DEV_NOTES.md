# comfyui-mirror-panel — DEV_NOTES

## What

ComfyUI 自定义节点插件。把用户标记的节点（任意位置、跨 group）"镜像"到一个独立的 DOM 面板里，可自由拖拽排版。切到镜像视图时主画布 `pause_rendering=true` + `display:none`，LiteGraph rAF 停掉——大工作流下 CPU 几乎归零。

## How

- `web/mirror-panel.js`：单文件前端扩展，挂 `app.registerExtension`。
- 双向同步 = **不绑值**。镜像卡片只是视觉投射 / DOM 镜像，改值统一走 `widget.callback(value)`，反向通过 wrap callback + 监听 `api.executing` / `execution_success` 事件。
- pin 状态存 `graph.extra.mirrorPanel`，跟随 workflow JSON。

## Source layout

源在 `E:\MAA\1111\misc\comfyui-mirror-panel\`，部署在 `E:\ComfyUI\ComfyUI\custom_nodes\comfyui-mirror-panel\`。**部署位置是真实文件夹（不是 junction）**——直接编辑部署位置，misc/ 当冷备份。

## Deploy

拷到 `ComfyUI/custom_nodes/comfyui-mirror-panel/`，重启 ComfyUI，刷新页面。F12 看 console 有 `[MirrorPanel]` 前缀的日志。
