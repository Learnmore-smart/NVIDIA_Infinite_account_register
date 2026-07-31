# NovaPuraAI-Nvidia-js 使用说明

一个本地运行的浏览器自动化工具：通过 Web 控制台批量管理测试用户，驱动本地 Chrome 完成 NVIDIA 账户注册流程，并采集生成的 API Key。整体采用 **人工辅助（manual-assist）** 模式——脚本自动填写表单和推进已知的固定步骤，但敏感环节（验证码、邮箱验证码等）保留人工介入。

---

## 一、环境要求

- **Node.js**（建议 18 及以上）
- **本地已安装 Chrome**（脚本使用本机 Chrome，不使用 Puppeteer 自带浏览器）
- **操作系统**：Windows（脚本包含 Windows 窗口焦点处理逻辑）

---

## 二、安装

在项目根目录执行：

```powershell
npm install
```

---

## 三、准备配置文件

### 1. 测试用户列表 `users_config.json`

这是自动化运行时读取的用户清单。仓库提供了示例文件 `users_config_example.json`，请**复制并重命名**为 `users_config.json`：

```powershell
Copy-Item users_config_example.json users_config.json
```

> ⚠️ `users_config.json` 已被 `.gitignore` 忽略（内含邮箱、密码等敏感信息），不会提交到 Git。

每条用户记录包含 6 个字段：

| 字段 | 含义 | 示例 |
|------|------|------|
| `testName` | 用户标识（结果按此排序，建议用 `test_user_N`） | `test_user_1` |
| `testCompany` | 公司名，**同时用作 NVIDIA Cloud Account 账户名** | `Example-Labs` |
| `testEmail` | 注册邮箱 | `example@gmail.com` |
| `testUsername` | 用户名 | `exampleuser1` |
| `testDOB` | 出生日期（`YYYY-MM-DD`） | `1995-01-01` |
| `testPassword` | 账户密码 | `Ex@mple_Passw0rd!` |

示例（`users_config_example.json` 内容）：

```json
[
  {
    "testName": "test_user_1",
    "testCompany": "Example-Labs",
    "testEmail": "example@gmail.com",
    "testUsername": "exampleuser1",
    "testDOB": "1995-01-01",
    "testPassword": "Ex@mple_Passw0rd!"
  }
]
```

### 2. 运行配置 `gmail_config.json`（仅非密钥）

```json
{
  "targetUrl": "https://build.nvidia.com/settings/api-keys",
  "parallelism": 3
}
```

- `targetUrl`：自动化目标页面地址。
- `parallelism`：并发窗口数，**1~5**（默认 3）。

### 3. 密钥全部放在 `.env`（CapSolver + Gmail）

启动时会自动加载项目根目录 `.env`，并补全缺失的密钥字段模板：

```env
# CapSolver
CAPSOLVER_API_KEY=your_capsolver_key

# Gmail OAuth 客户端（Google Cloud Console 创建）
GMAIL_CLIENT_ID=...
GMAIL_CLIENT_SECRET=...
# 下面两项可点控制台「用 Google 登录并连接 Gmail」自动写入
# GMAIL_REFRESH_TOKEN=
# GMAIL_MAILBOX=
```

**连接 Gmail（推荐）：**

1. 在 [Google Cloud Console](https://console.cloud.google.com/) 创建 OAuth 客户端（类型选「桌面应用」或「Web 应用」）。
2. 启用 **Gmail API**；授权重定向 URI 添加：  
   `http://localhost:8080/api/gmail/callback`
3. 把 `Client ID` / `Client Secret` 写入 `.env`。
4. 打开控制台 → 侧栏 **「用 Google 登录并连接 Gmail」** → 在官方 Google 窗口登录授权。
5. 成功后 `GMAIL_REFRESH_TOKEN`（及邮箱）会写回 `.env`。

- `users_config.json` 里可用 plus 地址：`you+test_user_5@gmail.com`。
- 也可 IMAP：`EMAIL_CODE_PROVIDER=imap` + `TEST_GMAIL_EMAIL` + `TEST_GMAIL_APP_PASSWORD`。
- 成功采集的 `nvapi-...` 仍会追加到同一 `.env`。

---

## 四、启动

```powershell
npm start
```

启动后控制台会输出：

```
[成功] Web 控制台运行于 http://localhost:8080
```

用浏览器打开 <http://localhost:8080> 即可进入 Web 控制台。

---

## 五、在控制台里操作

1. **管理测试用户**：增删改用户列表（对应写入 `users_config.json`）。
2. **配置运行参数**：设置目标地址与并发窗口数（1~5）。
3. **开始运行**：点击开始后，脚本会为每个用户打开一个独立的 Chrome 窗口并自动推进流程。
4. **实时日志**：控制台通过 SSE 实时显示运行日志与状态。
5. **人工介入（回退）**：未配置打码/邮箱 API 时，验证码与邮箱验证码请**直接在目标 Chrome 窗口内**完成（控制台仅显示状态）。
6. **停止**：随时可点击停止，脚本会清理临时浏览器资源。

---

## 六、自动化流程概览

脚本会自动推进以下已知步骤：

- 自动关闭 Cookie 同意弹窗（优先「Reject Optional / Reject All」）。
- 填写邮箱并自动点击 Next。
- 填写账户表单并自动提交。
- **人机验证**：优先 CapSolver；失败则人工。通过后**自动再点「创建账户 / Create Account / 登录」**（并防误关窗口）。
- **邮箱验证码**：配置 Gmail API / IMAP 后自动拉取（支持 plus-addressing）并填入提交；否则人工。
- 跳过通行密钥（点「稍后再说」），并自动确认「确定要跳过设置通行密钥吗？」弹窗中的「确定」。
- 开发者设置确认页（「快完成了！/ 请确认以下信息以完成注册」）自动点击「提交」（两个推荐设置复选框保持不勾选）。
- Cloud Account 命名页用 `testCompany` 填入账户名并自动点击「Create NVIDIA Cloud Account」。
- 进入 Build API-key 页面后采集生成的 API Key。
- 可选：每用户 sticky 住宅代理（Chrome `--proxy-server` + `page.authenticate`）。

---

## 七、运行结果

- 成功采集到的 API Key 会写入 `api_keys_test.md`（按 `test_user_N` 编号排序，仅记录成功项）。
- 其中的 `nvapi-...` 值会被追加同步到 `.env`（保留手动添加的其他环境变量）。
- 控制台也提供「查看结果」接口读取 `api_keys_test.md`。

> ⚠️ `api_keys_test.md` 与 `.env` 均含敏感信息，已被 `.gitignore` 忽略。

---

## 八、运行测试（可选）

```powershell
npm test
```

（等价于 `node --test`，运行仓库内的单元测试。）

---

## 九、注意事项

- **密钥即机密**：`users_config.json`、`api_keys_test.md`、`.env` 都不要提交或外发。
- **使用本地 Chrome**：不要退回 Puppeteer 自带浏览器。
- 若修改了脚本代码，请**重启正在运行的服务**，否则加载的是旧代码。
