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

### 2. 运行配置 `gmail_config.json`

控制目标页面与并发数。首次启动服务时若不存在会自动生成：

```json
{
  "targetUrl": "https://build.nvidia.com/settings/api-keys",
  "parallelism": 3
}
```

- `targetUrl`：自动化目标页面地址。
- `parallelism`：并发窗口数，**取值范围 1~5**（默认 3）。也可以在控制台里修改。

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
5. **人工介入**：遇到验证码或邮箱验证码时，请**直接在弹出的目标 Chrome 窗口内**完成操作（控制台仅显示状态提示）。
6. **停止**：随时可点击停止，脚本会清理临时浏览器资源。

---

## 六、自动化流程概览

脚本会自动推进以下已知步骤（其余保持人工辅助）：

- 自动关闭 Cookie 同意弹窗（优先「Reject Optional / Reject All」）。
- 填写邮箱并自动点击 Next。
- 填写账户表单并自动提交。
- 跳过通行密钥（点「稍后再说」），并自动确认「确定要跳过设置通行密钥吗？」弹窗中的「确定」。
- 开发者设置确认页（「快完成了！/ 请确认以下信息以完成注册」）自动点击「提交」（两个推荐设置复选框保持不勾选）。
- Cloud Account 命名页用 `testCompany` 填入账户名并自动点击「Create NVIDIA Cloud Account」。
- 进入 Build API-key 页面后采集生成的 API Key。

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
