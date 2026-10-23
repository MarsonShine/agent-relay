# 用 Agent Relay 开发 MS.Microservice

目标项目是 `E:\repositories\MS.Microservice`，工具在 `E:\repositories\agent-relay`。**在工具目录启动程序，让它处理目标项目；不是进入 MS.Microservice 执行 npm。**

本页只走一条主线：配置这个项目 → 输入需求 → 看进度 → 查状态 → 找到候选代码 → 退出后回看。完整命令和其他 demo 放在 [参考手册](cli-reference.md)，不用先全部读完。

## 配置好以后，日常只运行这条命令

在 **PowerShell 7** 执行：

```powershell
Set-Location -LiteralPath 'E:\repositories\agent-relay'
$data = Join-Path $env:LOCALAPPDATA 'AgentRelay\MS.Microservice\session'
npm start -- chat --repo E:\repositories\MS.Microservice --data-dir $data
```

出现 `需求 >` 后输入一行完整需求，程序自动执行；出现 `答复 >` 就直接回答。通常只看这个终端即可。想深入查看时，再在第二个 PowerShell 中执行下文的查询命令。

第一次使用先完成下面的准备和首次接入，生成 `chat.json` 后再用这条日常命令；只写好 config/runtime 文件还不算完成接入。**以下各查询块都自行定义路径、读取最近任务 ID，可以在新开的终端里单独复制执行，不依赖上一段里的变量。**

| 位置 | 本教程固定使用 | 用途 |
| --- | --- | --- |
| 工具目录 | `E:\repositories\agent-relay` | 执行 npm、启动工具 |
| 目标项目 | `E:\repositories\MS.Microservice` | 提供提交基线、项目规则和业务代码 |
| 任务数据 | `%LOCALAPPDATA%\AgentRelay\MS.Microservice\session` | 配置、任务 ID、状态、日志、证据 |
| 候选代码 | `%LOCALAPPDATA%\AgentRelay\MS.Microservice\worktrees` 下的任务目录 | 本次修改与候选提交 |

`%LOCALAPPDATA%` 是当前用户的本地应用数据目录，命令会自动展开，无需替换用户名。不要将 `$data` 改成默认 `.agent-relay`，那是另一个实例。

## 第一次使用：确认版本和项目状态

在工具目录安装、构建：

```powershell
Set-Location -LiteralPath 'E:\repositories\agent-relay'
node --version
npm --version
npm ci
if ($LASTEXITCODE -ne 0) { throw '依赖安装失败，请先处理版本或安装错误' }
npm run build
if ($LASTEXITCODE -ne 0) { throw '构建失败，请先处理构建错误' }
node dist/cli.js --help
```

需要 Node `26.8.2`、npm `11.14.1`；帮助里应有 `chat`。找不到 chat 说明当前源码/构建没有交互入口，不能用旧程序照抄新文档。

再检查真实运行条件。这段只读版本和 Git 状态，不启动任务：

```powershell
$repo = 'E:\repositories\MS.Microservice'
$codex = (Get-Command codex.exe -CommandType Application -ErrorAction Stop).Source
$dotnet = (Get-Command dotnet.exe -CommandType Application -ErrorAction Stop).Source
$codex
& $codex --version
& $dotnet --list-sdks
git -C $repo status --short
git -C $repo rev-parse HEAD
```

- 当前适配器严格接受 `codex-cli 0.163.0-alpha.10.2`。例如 `0.163.0-alpha.11.1` **会被拒绝**，不是找到 codex.exe 就能用。需要指定受支持的原生程序，或另行完成新版兼容验证；本教程不安装版本、不放宽预检。
- Codex 还需要在当前用户下完成认证；版本正确不代表认证可用。
- MS.Microservice 的 `global.json` 固定 .NET `10.0.401`、允许 `latestPatch`；安装能满足它的 SDK，以项目当前文件为准。
- `git status --short` 有输出时先辨认已有改动。任务使用已提交基线，未提交业务修改不会复制进去；不要自动提交或清空它们。
- 阅读目标项目的 `AGENTS.md`、`docs/status.md`、`docs/tasks/active.md`。项目已记录的基线测试失败不会因接入工具而消失，也不能通过减少检查掩盖。

**版本或环境不满足时先停在这里。** 下文说明条件满足后的操作，不代表这台机器已完成真实接入验收。

## 第一次使用：保存这个任务的配置

这里用“完善 TextNormalizer 的调用说明”作为具体任务。它不是正在执行的业务试点，输入需求后才会产生模型用量。

MS.Microservice 要保留 restore、build、test 三步检查，因此本例直接生成配置文件，不要求你在向导里猜“测试命令”怎么填。只做一次，之后使用开头的日常命令。

下方文件清单是这个小任务的授权范围，不是任意修改整个项目的许可。任务/交接文档路径用于遵守目标仓库协议，不要求全部修改；独立工作树按项目规则写交接，不擅自改原 checkout 的状态。换模块时需重新确定文件范围和检查，修改配置不会追溯改变旧任务。

复制整个块。它只写当前用户应用数据目录里的配置，不调用模型、不修改目标项目：

```powershell
Set-Location -LiteralPath 'E:\repositories\agent-relay'
$repo = 'E:\repositories\MS.Microservice'
$data = Join-Path $env:LOCALAPPDATA 'AgentRelay\MS.Microservice\session'
$trees = Join-Path $env:LOCALAPPDATA 'AgentRelay\MS.Microservice\worktrees'
$codex = (Get-Command codex.exe -CommandType Application -ErrorAction Stop).Source
$dotnet = (Get-Command dotnet.exe -CommandType Application -ErrorAction Stop).Source

# PATH 若指向不兼容版本，将 $codex 换为已验证原生程序的实际路径。
$nativeVersion = & $codex --version
if ($LASTEXITCODE -ne 0 -or $nativeVersion.Trim() -ne 'codex-cli 0.163.0-alpha.10.2') {
    throw "Codex 版本不兼容：$nativeVersion。先解决版本问题，不要修改检查来绕过。"
}
if ((Test-Path "$data/chat.json") -or (Test-Path "$data/state.db")) {
    throw '此实例已有配置或任务。已配置过请直接启动；旧管理实例请另选目录，不要覆盖或删除。'
}
$cfg = Get-Content -Raw examples/m2.config.json | ConvertFrom-Json
$cfg.allowedFiles = @(
    'src/MS.Microservice.Core/Common/TextNormalizer.cs'
    'test/MS.Microservice.Core.Tests/Text/TextNormalizerTests.cs'
    'test/MS.Microservice.Core.Tests/Common/TextNormalizerTests.cs'
    'HANDOFF.md'
    'docs/tasks/active.md'
    'docs/validation/relay-text-normalizer/task.md'
    'docs/validation/relay-text-normalizer/summary.md'
)
$cfg.verification.commands = @(
    [ordered]@{ id='restore'; version=1; executable=$dotnet; args=@('restore','--configfile','nuget.config'); cwd='.'; timeoutMs=600000 }
    [ordered]@{ id='build'; version=1; executable=$dotnet; args=@('build','--no-restore','-c','Release'); cwd='.'; timeoutMs=600000 }
    [ordered]@{ id='test'; version=1; executable=$dotnet; args=@('test','--no-build','-c','Release'); cwd='.'; timeoutMs=600000 }
)
$runtime = [ordered]@{
    repo = $repo
    workspaces = $trees
    command = [ordered]@{ executable = $codex }
}
New-Item -ItemType Directory -Force -Path $data | Out-Null
$cfg | ConvertTo-Json -Depth 30 | Set-Content -Encoding utf8NoBOM "$data/config.json"
$runtime | ConvertTo-Json -Depth 10 | Set-Content -Encoding utf8NoBOM "$data/runtime.json"
Write-Host "配置已保存：$data。尚未启动任务。"
```

模板使用 GPT-6 Luna：每任务最多 8 次调用、总期限 1 小时、最多 3 轮修复；单次模型调用最多 180 秒，每个可信检查最多 600 秒。总期限包含人工等待和检查时间。费用未知，这个预算不保证能完成任意需求。项目新增的强制门禁仍须保留，示例配置不是永久通用政策。

## 启动并输入需求

**终端 A** 执行以下完整块，首次接入刚才保存的配置：

```powershell
Set-Location -LiteralPath 'E:\repositories\agent-relay'
$data = Join-Path $env:LOCALAPPDATA 'AgentRelay\MS.Microservice\session'
npm start -- chat --config "$data/config.json" --runtime "$data/runtime.json" --data-dir $data
```

确认屏幕显示“项目：E:\repositories\MS.Microservice”和“真实 Codex 开发”。如果显示“模拟体验”，它不会做真实业务修改。预检通过后设置会保存到 `chat.json`，以后不必再传两个配置文件。

在 `需求 >` 后输入一行，例如：

```text
先阅读项目规则、TextNormalizer.Normalize 和两处现有测试。完善该方法的 XML 注释，明确 null、空白输入原样返回以及标点和空白规范化规则，不改变现有行为。仅在确有覆盖缺口时补回归测试。遵守项目工作树交接协议，任务证据归档到 docs/validation/relay-text-normalizer，完成后报告可信检查结果与候选提交。
```

这是示例需求，不是已经确认的业务缺陷。输入后会打印任务 ID 并自动推进；出现 `答复 >` 时在同一个终端回答。已有基线检查失败、授权范围不足或预算耗尽都可能使任务 blocked，要依据诊断处理。

终端 A 自动显示阶段、状态和调用数，例如“调查需求 · running · 调用 1/8”。它不是完成百分比，也不是逐 token 输出；没有新阶段时会定期显示状态。**不要在正在等待需求/答复的终端粘贴查询命令，那会被当作任务文本。**

## 运行中想看详细状态

保持终端 A 运行，另开 **PowerShell 7 终端 B**。这段会自动读取最近任务 ID：

```powershell
$data = Join-Path $env:LOCALAPPDATA 'AgentRelay\MS.Microservice\session'
$taskId = (Get-Content -Raw "$data/chat.json" | ConvertFrom-Json).lastTaskId
if (-not $taskId) { throw '还没有任务：先在终端 A 的 需求 > 输入需求' }
$s = node 'E:\repositories\agent-relay\dist\cli.js' task status $taskId --data-dir $data | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw '查询失败。若 chat 已退出，请先按“退出后回看”启动原实例服务。' }
[pscustomobject]@{
    TaskId = $s.task.id
    Status = $s.task.status
    Stage = $s.task.stage
    Runs = "$($s.task.runsUsed)/$($s.task.config.budget.maxRuns)"
    Accepted = $s.accepted
    Diagnostic = $s.task.diagnostic
}
```

| 看到什么 | 说明与下一步 |
| --- | --- |
| queued / running，accepted=False | 等待或执行中，正常；继续看终端 A |
| waiting_user | 回终端 A 的 `答复 >` 回答 |
| succeeded，accepted=True | 当前本地结果通过验收；再检查候选与验证记录 |
| succeeded，accepted=False | 证据不完整或失效，不能作为成功；看 evidenceIssues |
| blocked / failed | 看 Diagnostic 与验证记录，不要反复 resume |
| paused | 已确认暂停，同一 chat 重开后会问是否继续 |
| recovering 或 Run 为 unknown | 不能证明执行停止，保留隔离，不删库或新开写任务绕过 |

这条命令只查询一次。终端 A 已在自动跟踪，不需要你写轮询。交互完成后服务很快关闭，终端 B 此时查询失败通常是服务已退出，不是结果丢失。

## 查看执行进度和事件

**服务仍在运行时**，在终端 B 执行：

```powershell
$data = Join-Path $env:LOCALAPPDATA 'AgentRelay\MS.Microservice\session'
$taskId = (Get-Content -Raw "$data/chat.json" | ConvertFrom-Json).lastTaskId
if (-not $taskId) { throw '尚未创建任务' }
$page = node 'E:\repositories\agent-relay\dist\cli.js' task events $taskId --after 0 --limit 100 --data-dir $data | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw '事件查询失败，请确认原实例服务仍在运行' }
$page.events | Format-Table sequence,type,payload -Wrap
Write-Host "本页游标：$($page.nextCursor)；继续翻页时将 --after 0 换成这个数字。"
```

事件说明发生了什么，不是完整原生转录。调用数是运行次数，不等于 token 或费用。停止终端 B 的查询不会取消任务；在终端 A 按 Ctrl+C 才会请求暂停交互所拥有的执行。

## 程序已退出怎样回看上次结果

若主终端还在运行，直接查询，不要启动第二个服务。若已显示结果并回到 PowerShell 提示符，当前没有离线 status，需要重新打开原实例。

在终端 A 执行整个块，**不输入新的需求**：

```powershell
$data = Join-Path $env:LOCALAPPDATA 'AgentRelay\MS.Microservice\session'
$saved = Get-Content -Raw "$data/chat.json" | ConvertFrom-Json
if (-not $saved.runtime) { throw '此目录不是本教程的真实开发实例，请核对数据目录' }
$saved.config | ConvertTo-Json -Depth 30 | Set-Content -Encoding utf8NoBOM "$data/config.json"
$saved.runtime | ConvertTo-Json -Depth 10 | Set-Content -Encoding utf8NoBOM "$data/runtime.json"
node 'E:\repositories\agent-relay\dist\cli.js' serve --config "$data/config.json" --runtime "$data/runtime.json" --data-dir $data
```

看到 listening 后保留终端 A，在终端 B 查询。这里是**完整服务，不是只读查看器**：目录里若还有 queued 任务或已授权交付，可能继续调度。这个步骤面向上次任务已结束的情况；未完成任务应按下文“暂停与继续”操作。真实模式重开仍要求受支持的 Codex，不能为“只想查看”绕过版本预检。

不要为了查看结果重新输入原需求或 task create，那会创建新任务。当前没有 `task list`，`chat.json` 只记最近一个任务 ID。要长期查询旧任务，记下每次打印的 ID，之后用该 ID 查询。

## 查看结果检查记录和实际改动

服务运行时，在终端 B 执行完整块：

```powershell
$data = Join-Path $env:LOCALAPPDATA 'AgentRelay\MS.Microservice\session'
$taskId = (Get-Content -Raw "$data/chat.json" | ConvertFrom-Json).lastTaskId
if (-not $taskId) { throw '尚未创建任务' }
$s = node 'E:\repositories\agent-relay\dist\cli.js' task status $taskId --data-dir $data | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw '先启动同一实例服务，再查询结果' }
Write-Host "本地验收：$($s.accepted)；候选提交：$($s.task.codeRevision)"
$s.evidenceIssues
$s.handoffs | ForEach-Object { $_.result } |
    Where-Object { $_.stage -in @('implement','answer') } |
    Select-Object stage,summary,conclusion,resultRevision,changedFiles | Format-List
$s.validations | Select-Object status,stopped,evidence | Format-List
$s.validations | ForEach-Object { $_.checks } |
    Select-Object id,exitCode,stopped,reason | Format-Table -Wrap
$w = $s.workspaces | Where-Object kind -eq implementation | Select-Object -First 1
if ($null -ne $w) {
    Write-Host "用编辑器打开这个候选目录：$($w.path)"
    Write-Host "候选分支：$($w.branch)"
    if ($s.accepted) {
        git -C $w.path diff --stat $w.baselineRevision $s.task.codeRevision
        git -C $w.path diff $w.baselineRevision $s.task.codeRevision
    }
}
```

重点看 accepted=True、evidenceIssues 为空、当前需求/提交的验证和独立审查成立，以及候选 diff 是否符合需求。验证历史可能保留旧失败，须结合 evidence 的需求版本与提交号解读，不能只看一个退出码。

**代码在打印的 `$w.path` 中，不在原来的 MS.Microservice 目录里。** 打开原项目发现“没变化”是正常的。git diff 只读，不会复制或合并候选；是否采用候选由你检查后另行决定。本地验收也不等于已发 PR，本教程不推送、不合并。

看原始成果文件时，服务运行中在终端 B 执行：

```powershell
$data = Join-Path $env:LOCALAPPDATA 'AgentRelay\MS.Microservice\session'
$taskId = (Get-Content -Raw "$data/chat.json" | ConvertFrom-Json).lastTaskId
if (-not $taskId) { throw '尚未创建任务' }
$s = node 'E:\repositories\agent-relay\dist\cli.js' task status $taskId --data-dir $data | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw '原实例服务没有返回状态' }
$a = $s.artifacts | Where-Object kind -eq result | Select-Object -Last 1
if ($null -eq $a) { throw '任务尚未生成结果成果' }
Get-Content -Raw -LiteralPath (Join-Path (Join-Path $data 'evidence') $a.sha256)
```

改为 `kind -eq log` 可读日志。文件可能是结构化交接内容；打开文件不能代替验收。这些目录有私有需求、认证令牌和运行记录，不要上传整个目录。

## 暂停与继续

在交互终端 A 按 Ctrl+C，等待退出，不要直接杀进程或删数据。再次启动同一实例：

```powershell
Set-Location -LiteralPath 'E:\repositories\agent-relay'
$data = Join-Path $env:LOCALAPPDATA 'AgentRelay\MS.Microservice\session'
npm start -- chat --repo E:\repositories\MS.Microservice --data-dir $data
```

- 上次 paused：看到继续提示后输入 `yes`。
- 上次 waiting_user：回答保存的问题，不创建第二个任务。
- 上次 blocked/recovering：阅读诊断；不会自动加预算或重放未知副作用，见 [排错参考](cli-reference.md#排错与恢复)。
- 上次已结束：会提示输入新任务，不是自动接着改旧候选。只想回看就用回看步骤，不输入新需求。

暂停、人工等待和重开不重置总期限与已用调用数。另一个模块/范围应使用明确的新配置与交互实例，不能通过换目录绕过旧任务的未知执行。

## 其他用法按需查

| 需要 | 入口 |
| --- | --- |
| 不调用模型体验交互 | 在工具目录执行 `npm start -- chat --demo`，这是独立模拟实例，与上面的项目目录不同 |
| 为简单项目使用设置向导 | [README](../README.md#跑通第一个任务)；本 .NET 例子用文件配置保留三步检查 |
| 所有命令与配置字段 | [命令速查](cli-reference.md#命令速查)、[配置参考](cli-reference.md#配置参考) |
| 手工答复、取消、修改需求、追加预算 | [控制任务](cli-reference.md#demo-3控制长任务)，使用实际实例和当前版本 |
| issue → PR → 反馈 → 更新 | [GitHub 交付](cli-reference.md#demo-6github-交付)，需要另行明确交付授权 |
| 独立小项目与模拟演示 | [演示参考](cli-reference.md#demo-1成功失败与模拟场景) |

配置结构、命令和模拟流程可验证，不等于真实项目已经完成模型业务验收。Codex 兼容、认证、项目规则、基线检查和任务预算仍要在实际执行中成立。
