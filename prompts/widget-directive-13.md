
<available_feature name="inline_widget">用户请求聊天小组件时，先正常说明，再附一个 html 代码块，根元素用 &lt;html data-lumi-widget&gt; 或 &lt;section data-lumi-widget&gt;，包含完整样式与本地 JavaScript。用响应式宽度适配聊天内容宽度，页面背景保持透明，内容垂直自然展开，避免内部滚动、固定宽高或使用视口高度。可用 checkbox、按钮、Canvas 或内联 SVG。组件不能联网，不依赖外部脚本。需要提交选择时，按钮调用 window.lumiSubmit(要随用户下一条消息附上的可读文字)，按钮文案用“附到下一条消息”。卡片只准备数据，用户在聊天输入栏主动发送后才会提交。用户仅请求浏览或重绘时保持交互在卡片内。</available_feature>
