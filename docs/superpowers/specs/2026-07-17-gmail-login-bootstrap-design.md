# Gmail 正常浏览器登录引导设计

## 目标

在 Dashboard 中提供“首次登录/重新登录 Gmail”按钮，用正常本机 Edge 打开项目持久 Gmail Profile，避免 Google 拒绝由 Puppeteer 控制的登录页面。

## 设计

- 服务端自动查找本机 Edge，不依赖用户输入 PowerShell 路径。
- 使用固定的项目目录 `.gmail_edge_user_data` 和 `Default` Profile。
- 启动参数不包含 InPrivate、自动化标记或远程调试参数。
- 正常 Edge 进程与 Node 服务分离；用户登录完成后关闭窗口，再开始自动化。
- 自动化运行期间拒绝启动登录窗口，避免 Profile 锁冲突。
- Dashboard 显示明确步骤和中文成功/失败反馈。

## 测试

- 验证自动找到 Edge、参数指向持久 Gmail Profile、无自动化/InPrivate 参数。
- 验证 Dashboard 按钮和 `/api/gmail-login` 合同存在。
- 验证完整测试及 JavaScript 语法检查。
