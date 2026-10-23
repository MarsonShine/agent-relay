# Agent Relay 命令、配置与演示参考

日常使用从 [MS.Microservice 操作教程](usage.md) 开始。本页用于按需查命令、配置、模拟场景和 GitHub 交付，不需要顺序执行所有 demo。默认目录和管理命令属于独立实例；不要把本页的 `.agent-relay/tutorial` 与实际项目实例混用。

## 先理解三个目录和两种模式

- **工具目录**：检出 Agent Relay 源码并执行 `npm ci`、`npm run build` 的目录。
- **目标仓库**：你希望调查或修改的项目，真实开发模式需要 Git 提交基线。
- **数据目录**：`--data-dir` 指定的位置，保存任务、认证令牌、数据库、日志与成果。服务和操作终端必须指向同一个目录。

真实模式另有一个**工作树根目录**：工具为任务创建独立 Git worktree，在其中实施修改和提交。它与数据目录、目标仓库都要分开。工作树不是独立安全沙箱，仍受权限和项目规则约束。

只执行 `serve` 启动模拟模式，不会调用模型。真实模式需要同时提供 Codex 配置和 `--runtime`。命令输出中的 `backend` 会明确显示 `simulation` 或 `codex-cli`；不要把模拟成功误认为真实需求已经实现。

Windows 示例使用 PowerShell 7 的 `ConvertFrom-Json` 和 `utf8NoBOM`。所有 JSON 配置、任务与答复文件使用 UTF-8 无 BOM。`<ID>`、`<N>` 等尖括号内容是命令速查中的占位符，不能原样执行；demo 使用变量来避免手工填错。

## 基本操作与结果解读

### 服务、健康检查与退出

```powershell
node dist/cli.js serve --data-dir .agent-relay/tutorial --port 4318
```

保留这个前台终端，在第二个终端执行：

```powershell
node dist/cli.js doctor --data-dir .agent-relay/tutorial
```

正常情况下 `backend` 为预期模式，`schedulerError` 为 null。`outstandingRuns` 是活动或停止未知的运行数量，不是任务总数。`doctor` 必须在服务启动后执行；真实 Codex 版本检查发生在带 `--runtime` 的服务启动期间。

在服务终端按 Ctrl+C，服务会尝试暂停活动任务并关闭。重新启动时沿用原数据目录和端口；状态保留，不重新分配预算。同一个数据目录不能同时启动两个服务。启动新 demo 可以使用新的数据目录和端口；不要删除旧目录来处理未知执行。

### 创建任务与幂等键

```powershell
'说明本次需要完成的工作' | Set-Content -Encoding utf8NoBOM .agent-relay/tutorial/task.txt
$created = node dist/cli.js task create --repo . --input .agent-relay/tutorial/task.txt --key tutorial-001 --data-dir .agent-relay/tutorial | ConvertFrom-Json
$taskId = $created.task.id
```

`--repo` 是目标目录；模拟模式可用当前工具仓库，真实模式必须与运行时登记的仓库一致。`--input` 是文本文件路径，不是直接输入的需求句子。`--key` 用来识别一次提交：重复发送同一个请求时沿用 key，需要新任务时换 key。相同 key 与不同内容或请求快照会产生冲突，不会覆盖旧任务。

### 查询状态、成果和事件

```powershell
$data = '.agent-relay/tutorial'
$s = node dist/cli.js task status $taskId --data-dir $data | ConvertFrom-Json
$s | ConvertTo-Json -Depth 30
```

| 字段 | 怎么读 |
| --- | --- |
| `task.id` | 后续命令使用的任务 ID，保存它；当前没有 `task list` 命令 |
| `task.status` / `task.stage` | 当前运行状态 / 工作阶段 |
| `task.version` | 操作状态的版本；每次修改前重新读取 |
| `task.requirementVersion` | 需求版本；与任务状态版本不是同一回事 |
| `task.codeRevision` | 当前关联的代码提交 |
| `task.question` | 待回答的问题及 ID/version；没有问题时为 null |
| `task.diagnostic` / `evidenceIssues` | 阻塞原因 / 成果缺失或验证问题 |
| `accepted` | 当前本地结果的验收状态；模拟任务只验证模拟证据 |
| `delivered` | GitHub 交付是否完成；本地成功不自动创建 PR |
| `runs` | 每次运行及 active/unknown/stopped 状态；停止未知不等于已结束 |
| `artifacts` | 成果和日志的 ID、哈希、大小与版本绑定 |
| `handoffs` / `validations` / `workspaces` | 真实模式的交接内容、可信检查、任务工作树 |
| `delivery` / `deliveryIntent` / `deliveryCI` / `inbox` | GitHub 状态、发布意图、当前 CI 和反馈处置 |

| `task.status` | 下一步 |
| --- | --- |
| `queued`、`running` | 等待或查询；需要中断时使用 pause/cancel |
| `waiting_user` | 阅读 question，使用 answer，不要反复 resume |
| `recovering` | 等待停止核对，先看 runs 和诊断；不得启动第二个写入者 |
| `paused` | 已确认暂停，可 resume；问题仍未回答时恢复到 waiting_user |
| `blocked` | 阅读诊断并先解决原因，见排错章节；resume 只接受 paused |
| `succeeded` | 再检查 accepted、evidenceIssues 和候选；需要远端交付时另行 publish |
| `failed`、`cancelled` | 本地终态，不能重新启动；保留记录，必要时创建新任务 |

读取某份已登记成果：

```powershell
$artifact = $s.artifacts | Where-Object kind -eq result | Select-Object -Last 1
if ($null -eq $artifact) { throw '任务还没有结果成果，请先查状态' }
Get-Content -Raw -LiteralPath (Join-Path (Join-Path $data 'evidence') $artifact.sha256)
```

改用 `kind -eq log` 可以查看日志。先查询 status，确认 `evidenceIssues` 没有报告损坏；直接打开文件不能代替验收。真实模式还可查看 `$s.handoffs`、`$s.validations` 和 `$s.workspaces`。不要从文件名或模型总结推断 accepted。

```powershell
$page = node dist/cli.js task events $taskId --after 0 --limit 100 --data-dir $data | ConvertFrom-Json
$page.events
$cursor = $page.nextCursor
node dist/cli.js task events $taskId --after $cursor --limit 100 --data-dir $data
```

事件按序号分页，`--after` 使用上次的 `nextCursor`。这是一次查询，不是实时订阅。事件中 `usage` 载荷可能提供输入/输出 token；未提供的用量和金额是未知，不应记为零。

## Demo 1：成功、失败与模拟场景

单终端成功 demo 已在 README 中给出；要练习本页管理命令，先按上面的“服务、健康检查与退出”和“创建任务”启动独立模拟实例。其他模拟场景通过复制 [m1.config.json](../examples/m1.config.json)，修改 `profiles.design.native.scenario` 后传入 `serve --config` 演示。模拟工作流使用 design 角色，不需要修改另外两个角色。

| scenario | 用途与预期 |
| --- | --- |
| `success` | 输出模拟成果，succeeded 且 accepted |
| `input` | 首轮 waiting_user，答复后可完成，见 Demo 2 |
| `slow` | 保持执行直到暂停、取消或超时，见 Demo 3 |
| `failure` | 注入执行失败；不能 accepted |
| `missing-terminal` | 没有有效完成证据；不能 accepted，查看诊断 |
| `duplicate` | 重复 progress 事件，用于观察事件去重，任务仍可完成 |
| `cancel-race` | 测试取消与完成竞争；取消可能与终态先后发生，不能将它当作永远可暂停的慢任务 |

配置修改只作用于新任务；已有任务保留创建时快照。不要修改配置后期待旧任务自动切换模型、权限或场景。重复试验使用新 key；需要不同配置时停止旧服务，或使用新的数据目录和不同端口。

## Demo 2：等待用户答复

终端 A，从工具根目录创建一份私有配置。demo 给人工操作留出 1 小时总期限；这不是生产任务的推荐预算。

```powershell
New-Item -ItemType Directory -Force .agent-relay | Out-Null
$cfg = Get-Content -Raw examples/m1.config.json | ConvertFrom-Json
$cfg.profiles.design.native.scenario = 'input'
$cfg.budget.maxTaskMs = 3600000
$cfg | ConvertTo-Json -Depth 20 | Set-Content -Encoding utf8NoBOM .agent-relay/tutorial-input.json
node dist/cli.js serve --config .agent-relay/tutorial-input.json --data-dir .agent-relay/tutorial-input --port 4319
```

终端 B：

```powershell
$data = '.agent-relay/tutorial-input'
'演示需要人工选择范围的任务' | Set-Content -Encoding utf8NoBOM "$data/task.txt"
$created = node dist/cli.js task create --repo . --input "$data/task.txt" --key question-001 --data-dir $data | ConvertFrom-Json
$taskId = $created.task.id
```

后续 demo 可复用以下有界等待函数。它只查询状态，不修改任务或重置预算：

```powershell
function Wait-RelayState([string]$taskId, [string[]]$states, [string]$data) {
    for ($attempt = 0; $attempt -lt 120; $attempt++) {
        $snapshot = node dist/cli.js task status $taskId --data-dir $data | ConvertFrom-Json
        if ($LASTEXITCODE -ne 0) { throw '状态查询失败' }
        if ($snapshot.task.status -in $states) { return $snapshot }
        Start-Sleep -Milliseconds 250
    }
    throw '等待超时，请查看 task status 的诊断信息'
}
$s = Wait-RelayState $taskId @('waiting_user') $data
$s.task.question
'范围确定为只验证模拟流程' | Set-Content -Encoding utf8NoBOM "$data/answer.txt"
node dist/cli.js task answer $taskId --version $s.task.version --question $s.task.question.id --question-version $s.task.question.version --input "$data/answer.txt" --data-dir $data
$s = Wait-RelayState $taskId @('succeeded', 'blocked', 'failed') $data
$s.accepted
```

预期 accepted 为 true，需求版本增加，`runsUsed` 累计而不清零。真实任务的回答也会升级需求版本并重新判断阶段。只把 answer 用于当前 waiting_user 问题；答错 ID、问题版本或任务版本会被拒绝。

## Demo 3：控制长任务

终端 A 创建 slow 配置；终端 B 继续使用 Demo 2 的 `Wait-RelayState` 函数：

```powershell
$cfg = Get-Content -Raw examples/m1.config.json | ConvertFrom-Json
$cfg.profiles.design.native.scenario = 'slow'
$cfg.profiles.design.timeoutMs = 600000
$cfg.budget.maxTaskMs = 3600000
$cfg.budget.maxRuns = 8
$cfg | ConvertTo-Json -Depth 20 | Set-Content -Encoding utf8NoBOM .agent-relay/tutorial-slow.json
node dist/cli.js serve --config .agent-relay/tutorial-slow.json --data-dir .agent-relay/tutorial-slow --port 4320
```

终端 B 创建并暂停任务：

```powershell
$data = '.agent-relay/tutorial-slow'
'演示暂停和恢复' | Set-Content -Encoding utf8NoBOM "$data/task.txt"
$created = node dist/cli.js task create --repo . --input "$data/task.txt" --key control-001 --data-dir $data | ConvertFrom-Json
$taskId = $created.task.id
$s = Wait-RelayState $taskId @('running') $data
node dist/cli.js task pause $taskId --version $s.task.version --data-dir $data
$s = Wait-RelayState $taskId @('paused') $data
$s.runs
```

pause 返回 recovering 是正常的中间状态；只有确认停止后才变为 paused。检查 runs 均已 stopped，再继续。

在暂停期间，分别演示增加调用数上限和替换需求：

```powershell
'同意本演示把最大运行次数从 8 增加到 12，总期限不变' | Set-Content -Encoding utf8NoBOM "$data/budget-approval.txt"
$s = node dist/cli.js task status $taskId --data-dir $data | ConvertFrom-Json
node dist/cli.js task budget $taskId --version $s.task.version --max-runs 12 --input "$data/budget-approval.txt" --data-dir $data

'改为验证恢复后还能取消，仍不调用模型' | Set-Content -Encoding utf8NoBOM "$data/revised-task.txt"
$s = node dist/cli.js task status $taskId --data-dir $data | ConvertFrom-Json
node dist/cli.js task revise $taskId --version $s.task.version --requirement-version $s.task.requirementVersion --input "$data/revised-task.txt" --data-dir $data
```

revise 替换整个需求正文，保留历史，增加需求版本；暂停任务仍暂停。budget 只增加最大运行次数，不增加总期限、不清空已用次数、不自动恢复。它要求执行和占用都已停止、原期限未到，且新上限大于原上限和已用次数，最大 100。

恢复并取消：

```powershell
$s = node dist/cli.js task status $taskId --data-dir $data | ConvertFrom-Json
node dist/cli.js task resume $taskId --version $s.task.version --data-dir $data
$s = Wait-RelayState $taskId @('running') $data
node dist/cli.js task cancel $taskId --version $s.task.version --data-dir $data
$s = Wait-RelayState $taskId @('cancelled') $data
$s.task.runsUsed
$s.budgetChanges
```

预期调用计数继续累积，任务终态 cancelled。slow 场景不会因为修改需求或 resume 就变为 success。cancel 也不会撤销已经产生的文件、提交或 PR。需要另一个 demo 时创建新任务，不要恢复 cancelled 任务。

## Demo 4：真实代码修复（Windows）

本节会调用模型并在任务工作树中创建本地提交。先准备已认证的原生 Codex CLI `0.163.0-alpha.10.2`，确认允许模型使用量，再主动执行。没有这个已验证版本时，先使用模拟 demo；本教程不自动安装或替换本机 Codex。

### 创建一个独立示例仓库

以下操作只创建新的 demo 目录，不使用你的业务仓库。保留 `$demoRoot` 的打印值，第二个终端要使用它。

```powershell
$relay = (Get-Location).Path
$demoRoot = Join-Path $env:USERPROFILE ('agent-relay-demo-' + [guid]::NewGuid().ToString('N'))
$repo = Join-Path $demoRoot 'repository'
$data = Join-Path $demoRoot 'state'
$worktrees = Join-Path $demoRoot 'worktrees'
New-Item -ItemType Directory -Force "$repo/src", "$repo/test", $data | Out-Null
Copy-Item examples/tutorial/label.mjs "$repo/src/label.mjs"
Copy-Item examples/tutorial/label.test.mjs "$repo/test/label.test.mjs"
'* text=auto eol=lf' | Set-Content -Encoding utf8NoBOM "$repo/.gitattributes"
'Only modify src/label.mjs. Preserve tests. Local implementation commits are allowed in the assigned task worktree.' | Set-Content -Encoding utf8NoBOM "$repo/AGENTS.md"
git -C $repo init -q
git -C $repo config user.name 'Demo User'
git -C $repo config user.email 'demo@example.invalid'
git -C $repo add .
git -C $repo commit -m 'demo: add label normalization acceptance tests'
$demoRoot
node --test "$repo/test/label.test.mjs"
```

**此时应是 2 通过、1 失败。** `normalizeLabel` 只去除了首尾空白，第二条测试要求将内部连续空白折叠为一个空格。这是待修复的业务缺陷；不要删除失败测试。

### 配置执行器、范围和可信检查

给出已安装的原生 `codex.exe` 绝对路径。`Get-Command codex` 可能返回 `.ps1`/`.cmd` 包装脚本，它不一定能被无 shell 的执行器直接启动；应使用安装目录中的真实可执行文件，并核对版本与该 OS 用户的认证。

```powershell
$codexExe = Read-Host '输入已认证的原生 codex.exe 绝对路径'
& $codexExe --version
& $codexExe login status
$nodeExe = (Get-Command node.exe).Source
$cfg = Get-Content -Raw examples/m2.config.json | ConvertFrom-Json
$cfg.allowedFiles = @('src/label.mjs')
$cfg.verification.commands[0].executable = $nodeExe
$cfg.verification.commands[0].args = @('--test', 'test/label.test.mjs')
$cfg | ConvertTo-Json -Depth 20 | Set-Content -Encoding utf8NoBOM "$data/config.json"
@{
    repo = $repo
    workspaces = $worktrees
    command = @{ executable = $codexExe }
} | ConvertTo-Json -Depth 10 | Set-Content -Encoding utf8NoBOM "$data/runtime.json"
node dist/cli.js serve --config "$data/config.json" --runtime "$data/runtime.json" --data-dir $data --port 4321
```

版本输出必须为 `codex-cli 0.163.0-alpha.10.2`。服务启动成功应显示 `backend: codex-cli`。示例冻结 design/implement/review 三个角色为 `gpt-6-luna`、low 思考强度，最多 8 次运行、1 小时总期限、3 次修复迭代，每次模型运行上限 180 秒。超出预算会阻塞，不承诺每次都能完成。

若尚未登录，先在普通终端运行 `& $codexExe login --help` 查看该安装版本的登录方式，再运行 `& $codexExe login` 完成登录，之后重启服务。Agent Relay 复用同一 OS 用户的 Codex 认证，不要求把密钥写进 config.json。如果本机只有其他版本，即使是更新的 alpha 版本也会被拒绝；兼容性升级需要单独验证，不要改版本字符串绕过检查。

`allowedFiles` 只有实现文件；检查来自私有配置，执行全部三条测试。实现者不能修改测试来消除失败。命令的工作目录 `.` 指任务工作树，不是工具目录或原始 checkout。

### 提交需求并验收

在终端 B 进入工具目录，把第一终端打印的路径填入：

```powershell
$demoRoot = Read-Host '输入第一终端打印的 demoRoot'
$repo = Join-Path $demoRoot 'repository'
$data = Join-Path $demoRoot 'state'
'修复 normalizeLabel：输入为字符串；去掉首尾空白，把内部连续空格、制表符和换行折叠为一个空格，保留中文，空白字符串返回空串。只修改 src/label.mjs，不修改测试。完成后执行检查并创建本地候选提交。' | Set-Content -Encoding utf8NoBOM "$data/task.txt"
$created = node dist/cli.js task create --repo $repo --input "$data/task.txt" --key label-fix-001 --data-dir $data | ConvertFrom-Json
$taskId = $created.task.id
$s = node dist/cli.js task status $taskId --data-dir $data | ConvertFrom-Json
$s.task | Select-Object status, stage, runsUsed, diagnostic
```

模型调用不会立即完成，稍后重复 status。若 waiting_user，按 Demo 2 使用当前问题 ID 答复；若 blocked，先检查诊断，不扩大范围或降低检查要求。任务通常经过 triage、implement、code_review；复杂任务还会经过 design/design_review。无需手工指定角色或按固定阶段顺序逐个执行。

成功后应同时满足：

- `accepted: true`，`evidenceIssues` 为空，所有 runs 已 stopped。
- validations 中当前候选的三条测试通过，独立代码审查覆盖需求，未解决发现为空。
- workspaces 中 implementation 的 path/branch 指向任务工作树；只改了 `src/label.mjs`，原始仓库没有被实施修改。

```powershell
$s = node dist/cli.js task status $taskId --data-dir $data | ConvertFrom-Json
$s.validations | ConvertTo-Json -Depth 20
$s.handoffs | ConvertTo-Json -Depth 30
$work = $s.workspaces | Where-Object kind -eq implementation | Select-Object -Last 1
git -C $work.path show --stat $s.task.codeRevision
git -C $repo status --short
```

不要在验收后手工修改任务工作树，否则 accepted 的证据可能失效。候选默认仅保留在任务分支；本工具不会自动合并回目标分支。评审后如何采用候选由项目维护者决定。停止并重新启动服务后再查询同一个 ID，可核对证据是否仍完整。

## Demo 5：只读咨询

在 Demo 4 的真实服务上创建一个新任务，问题明确为调查，不请求改代码：

```powershell
'只读解释 src/label.mjs 当前如何处理空白，引用实际源码说明局限，不实施修改。' | Set-Content -Encoding utf8NoBOM "$data/question.txt"
$created = node dist/cli.js task create --repo $repo --input "$data/question.txt" --key label-explain-001 --data-dir $data | ConvertFrom-Json
$taskId = $created.task.id
node dist/cli.js task status $taskId --data-dir $data
```

这会产生真实模型使用量，但咨询路径不需要实现分支或代码提交。成果解释的是登记仓库的基线；Demo 4 的候选没有合并时，不会自动成为这个新任务的输入。不要把两个独立任务当成共享会话。模型需要澄清范围时，仍使用 answer。

## Demo 6：GitHub 交付

### 准备目标与可信策略

本节会向远端推送分支并创建 PR，应在你有权限的测试仓库进行。Demo 4 的纯本地仓库没有 GitHub 远端，不能直接 import；先选择真实存在的 GitHub 仓库、issue 和固定 base，再按 Demo 4 的方式登记其 checkout、允许文件和检查。

```powershell
gh auth login --hostname github.com
gh auth status --hostname github.com
$repoName = Read-Host '输入 owner/repository'
gh api "repos/$repoName" --jq '{id,full_name}'
gh api user --jq '{id,login}'
```

查询返回的数字仓库 ID 与账户 ID 分别对应 `repositoryId` 和可信反馈者 `id`，不是 issue 编号。`gh` 的 API 认证和 Git HTTPS 推送权限都必须可用；只有读权限不能发布 PR。

已登录时跳过 `gh auth login`。如果需要让 Git 使用 gh 管理的凭据，可在你确认使用该凭据助手后运行 `gh auth setup-git --hostname github.com`；这会配置 Git 凭据助手，不是创建 PR。不要把 token 放入 issue、任务正文或公开配置。

检出已确定的 base 提交，并保持它与远端 base 一致。用一个已经运行过 CI 的提交查检查名称和 App ID：

```powershell
$baseSha = git -C $repo rev-parse HEAD
gh api "repos/$repoName/commits/$baseSha/check-runs" --jq '.check_runs[] | {name,appId:.app.id}'
```

如果没有检查，先建立并运行目标项目自己的 CI。不要照抄本工具仓库的检查名称或 App ID，也不要用空 requiredChecks 绕过门禁。`codeStep` 是 Actions 中明确的项目检查步骤名；不填时不能靠普通失败文本自动判定为代码问题。

复制 [m4.github.json](../examples/m4.github.json) 到私有目录，填写真实 repository、repositoryId、base、可信反馈者和 requiredChecks，明确授权发布时才将 publish 改为 true。该文件是一个 **配置片段**，不能单独传给 `serve --config`：

```powershell
Copy-Item examples/m4.github.json "$data/github-policy.json"
# 先编辑 github-policy.json，核对所有占位值和 publish，再执行以下合并。
$cfg = Get-Content -Raw "$data/config.json" | ConvertFrom-Json
$policy = Get-Content -Raw "$data/github-policy.json" | ConvertFrom-Json
$cfg | Add-Member -NotePropertyName github -NotePropertyValue $policy.github -Force
$cfg | ConvertTo-Json -Depth 30 | Set-Content -Encoding utf8NoBOM "$data/github-config.json"
```

停止旧服务，用同样的 runtime 和数据目录/端口启动 `--config "$data/github-config.json"`。只有新导入的任务使用该配置；既有本地任务不会因此获得 GitHub 来源或发布权限。建议 GitHub demo 使用独立数据目录，避免混淆任务。

### 导入、完成本地任务、发布

```powershell
node dist/cli.js serve --config "$data/github-config.json" --runtime "$data/runtime.json" --data-dir $data --port 4321
```

另一个终端初始化相同的 `$data` 后：

```powershell
$issueNumber = Read-Host '输入现有 issue 编号'
$created = node dist/cli.js task import --issue $issueNumber --key github-demo-001 --data-dir $data | ConvertFrom-Json
$taskId = $created.task.id
node dist/cli.js task status $taskId --data-dir $data
```

import 不接受 `--repo`，仓库来自可信运行时和 GitHub 策略。issue 内容是需求，不是执行授权；后续编辑 issue 不会自动更新已冻结的需求。

等待本地 accepted 后再发布：

```powershell
$s = node dist/cli.js task status $taskId --data-dir $data | ConvertFrom-Json
if (-not $s.accepted) { throw '先解决本地验收问题，不要发布' }
node dist/cli.js task publish $taskId --version $s.task.version --data-dir $data
$s = node dist/cli.js task status $taskId --data-dir $data | ConvertFrom-Json
$s.delivery
$s.deliveryIntent.url
```

publish 记录发布意图，服务随后推送专属分支并创建 PR，不是命令返回就已经交付。等待 delivery 进入 watching，查看 URL、deliveryCI 和 inbox。目标 base 变化、外来 head 修改或结果未知时会阻塞，不会 force push。

### 发布前发现问题：本地 feedback

此命令仅用于**已导入、当前 accepted、尚未准备任何发布意图**的任务，不是所有本地任务的通用反馈入口。下面是一个可编辑的实现类发现：

这是可选分支，必须在上一节的 publish 之前执行；已经发布的任务直接跳到下一节。

```powershell
$s = node dist/cli.js task status $taskId --data-dir $data | ConvertFrom-Json
@{
    kind = 'implementation'
    requirementVersion = $s.task.requirementVersion
    revision = $s.task.codeRevision
    files = @('src/label.mjs')
    text = '实际复核发现内部换行未折叠，请按现有验收修复。'
} | ConvertTo-Json -Depth 5 | Set-Content -Encoding utf8NoBOM "$data/feedback.json"
node dist/cli.js task feedback $taskId --version $s.task.version --input "$data/feedback.json" --data-dir $data
```

仅在真实发现成立且文件属于冻结范围时提交；示例不是要求捏造问题。kind 支持 implementation/design。命令撤销当前 accepted，修复后必须重新检查并独立解决发现，再 publish。已经 publish 的任务使用下节授权远端反馈。

### 发布后收到反馈：更新同一 PR

由策略中登记的可信账户，在 issue 或 PR 的**顶层评论**中提交以下格式，替换需求版本、当前 40 位候选 SHA、允许文件和实际反馈：

```text
/relay {"kind":"implementation","requirementVersion":1,"revision":"<当前40位候选SHA>","files":["src/label.mjs"],"text":"实际发现与可复核证据"}
```

这里的占位 SHA 必须替换，不能直接发送。普通评论、未授权账户、旧 SHA、范围外文件、额外字段和 review-thread 回复都不会成为有效修复指令。

| kind | 处理方式 |
| --- | --- |
| `implementation` | 回到实现；保留需求版本，生成待独立解决的发现 |
| `design` | 回到设计并重新经过相关审查 |
| `requirement` | 升级需求版本并重新 triage；仍不能突破原文件和权限范围 |

服务有界轮询评论与 CI，修复重新 accepted 后更新同一个 PR。任务运行数、迭代数、轮询次数和总期限都累计。配置中的 `pollIntervalMs` 决定基本轮询间隔；限流可能推迟下一次请求。

### 完成交付、核对与取消

确认当前候选本地 accepted，当前 SHA 的必需 CI 全部通过、反馈已处理后，显式结束反馈窗口：

```powershell
$s = node dist/cli.js task status $taskId --data-dir $data | ConvertFrom-Json
node dist/cli.js task complete-delivery $taskId --version $s.task.version --data-dir $data
node dist/cli.js task status $taskId --data-dir $data
```

预期 delivered 为 true，PR 仍保持打开。CI 证据需要新鲜；若失败提示 current CI 或 pending feedback，检查状态并等下一次有效轮询，不要忽略错误。

交付 blocked 且外部原因已解决时：

```powershell
$s = node dist/cli.js task status $taskId --data-dir $data | ConvertFrom-Json
node dist/cli.js task reconcile-delivery $taskId --version $s.task.version --data-dir $data
```

该命令只核对已有结果，不能重置期限、轮询次数或终态，不授权重放未知 push/PR 创建。例如分支推送已成功但 PR head 短暂滞后，可在远端同步后核对。

停止后续交付操作：

```powershell
$s = node dist/cli.js task status $taskId --data-dir $data | ConvertFrom-Json
node dist/cli.js task cancel-delivery $taskId --version $s.task.version --data-dir $data
```

这不删除已创建的 PR/分支，不撤销已经发生的操作，也不停止正在进行的本地实现。需要停止本地任务时，再读当前 task.version 并执行 task cancel。complete/cancel 后不再通过 reconcile 重新打开反馈窗口。

## 命令速查

下面覆盖 `node dist/cli.js --help` 的所有命令。交互入口直接读取需求；管理命令继续通过 UTF-8 文件传入正文并输出 JSON。管理命令默认数据目录为用户主目录的 `.agent-relay`，chat 默认使用 `.agent-relay-chat`，`chat --demo` 默认使用 `.agent-relay-chat-demo`；管理交互任务时要显式指定同一目录。未知参数会报错。

| 命令（省略共同前缀） | 参数与用途 |
| --- | --- |
| 无参数 / `chat` | 单终端交互；可选 `--demo --repo DIR --config FILE --runtime FILE --data-dir DIR --port PORT`，模式组合限制见交互章节 |
| `--help` | 显示帮助；chat 使用可读提示，管理命令输出 JSON，错误返回非零退出码 |
| `serve` | 可选 `--config FILE --runtime FILE --port PORT`；默认模拟、127.0.0.1:4318；已有目录沿用保存的端口 |
| `doctor` | 查询运行中服务的 backend、调度错误及占用数 |
| `task create` | 必需 `--repo DIR --input FILE --key KEY`；本地来源任务 |
| `task import` | 必需 `--issue N --key KEY`；可信 GitHub 来源，不接受 `--repo` |
| `task status ID` | 读取完整状态、版本、成果与交付信息 |
| `task events ID` | 可选 `--after N --limit N`，默认 0/100；按 nextCursor 翻页 |
| `task pause ID` | 必需 `--version N`；活动执行先进入 recovering |
| `task resume ID` | 必需 `--version N`；仅已确认 paused 的任务 |
| `task cancel ID` | 必需 `--version N`；停止本地任务，保留历史和已发生副作用 |
| `task answer ID` | 必需 `--version N --question ID --question-version N --input FILE`；回答当前问题 |
| `task revise ID` | 必需 `--version N --requirement-version N --input FILE`；闲置非终态任务替换完整需求 |
| `task budget ID` | 必需 `--version N --max-runs N --input APPROVAL_FILE`；只提高最大运行数，保留批准审计 |
| `task feedback ID` | 必需 `--version N --input JSON_FILE`；已导入任务发布前的 implementation/design 发现 |
| `task publish ID` | 必需 `--version N`；本地验收后显式发布 |
| `task reconcile-delivery ID` | 必需 `--version N`；核对受阻交付，不重置预算或重放未知副作用 |
| `task complete-delivery ID` | 必需 `--version N`；关闭有效反馈窗口，要求当前验收和新鲜 CI |
| `task cancel-delivery ID` | 必需 `--version N`；停止新远端操作，不撤销旧操作 |

除 create/import 外，任务控制与交付命令使用紧邻操作前读取的 task.version；chat 会为自己的答复/恢复操作处理版本。遇到版本冲突先重新检查状态，确认原决定仍适用再操作，不把旧命令盲目循环重发。没有 `task retry`、`task list`、`task delete`、`task merge`、`task export` 或通用 `artifact` CLI；也不能通过 CLI 修改运行中的权限、文件范围或验证策略。

## 配置参考

配置示例均为结构模板；真实运行前必须替换路径、文件范围、检查和 GitHub 身份。字段名大小写敏感，未知字段会被拒绝。

| 文件 | 如何使用 |
| --- | --- |
| [m1.config.json](../examples/m1.config.json) | 完整模拟配置，直接传 `serve --config` |
| [m2.config.json](../examples/m2.config.json) | 完整 Codex 角色/预算/可信检查模板，与 runtime 一起使用 |
| [m2.runtime.json](../examples/m2.runtime.json) | 登记目标仓库、工作树根、原生可执行路径；传 `--runtime` |
| [m4.github.json](../examples/m4.github.json) | 仅 github 配置片段，合入 M2 配置；默认 publish:false |
| [m4-feedback.md](../examples/m4-feedback.md) | issue→PR 反馈流程的简短英文示例 |
| [tutorial](../examples/tutorial/README.md) | Demo 4 的故意有缺陷实现与可信测试 |

### 主配置

| 字段 | 含义与限制 |
| --- | --- |
| `schemaVersion` | 固定 1 |
| `profiles.design/implement/review` | 三个角色均必需，内部 role 必须与键名一致 |
| `profiles.*.executor/provider/model` | 模拟：fake/simulation/simulator-v1；真实：codex-cli/openai/gpt-6-luna；不是任意字符串选择器 |
| `profiles.*.permission` | 模拟只读；Codex design/review 只读，开发服务的 implement 必须 workspace-write |
| `profiles.*.native` | 模拟为 scenario 与 0–10000 ms 的 delayMs；Codex 仅支持 reasoningEffort:low |
| `profiles.*.timeoutMs` | 单次运行时限，正整数且不超过 3600000 ms，也不能超过 maxTaskMs |
| `budget.maxRuns` | 每任务最多运行次数，1–100；不是金额上限 |
| `budget.maxTaskMs` | 总期限，1–86400000 ms，含人工等待/暂停；重启不重置 |
| `budget.maxIterations` | 0–10 次任务修复/迭代额度 |
| `budget.maxInfrastructureRetries` | 可选，0–10，默认 2；仅明确分类且确认停止的只读基础设施失败可重试 |
| `budget.retryBaseMs` | 可选，100–10000 ms，默认 1000；重试退避基数 |
| `leaseMs` | 1000–60000 ms；默认模拟 5000，真实模板 60000；过期不是停止证明 |
| `maxArtifactBytes/maxLogBytes` | 每份成果/执行日志上限，1–16777216 字节；超限不能算成功 |
| `allowedFiles` | 真实运行必需，1–100 个明确的仓库相对文件路径；使用 `/`，不是任意 glob；不允许范围外修改 |
| `verification` | 真实运行必需，版本化可信检查，见下表 |
| `github` | 可选可信交付策略；不配置时没有 GitHub 交付能力 |

### 运行时与可信检查

runtime 的 `repo`、`workspaces`、`command.executable` 均为绝对路径；`command.prefixArgs` 是可选参数数组（最多 10 项），不是可以拼接的 shell 命令。示例使用原生可执行文件无需 prefixArgs。一个服务登记一个目标仓库；要处理另一仓库，请创建独立配置和数据目录。

| verification 字段 | 用法 |
| --- | --- |
| `version` | 正整数，标识可信检查定义版本 |
| `maxLogBytes` | 1024–1048576 字节的验证日志限额 |
| `commands` | 1–20 条检查，全部满足才能验收，id 不可重复 |
| `commands[].id/version` | 稳定检查 ID（字母、数字、`_`、`-`）和正整数版本 |
| `commands[].executable` | 绝对可执行路径，例如 node.exe；不要把 `npm test` 写成路径 |
| `commands[].args` | 参数数组，最多 100 项；需要 npm 时明确调用 Node 和 npm 的真实入口，不使用 shell 拼串 |
| `commands[].cwd` | `.` 或工作树内的 `/` 分隔相对目录，不能越界 |
| `commands[].timeoutMs` | 100–3600000 ms；检查超时、失败、输出超限都不能验收 |

所有检查命令来自本机可信配置，不由模型、issue 或评论改写。目标仓库已有检查和规则应保留；不要为了跑通 demo 降低业务项目的门禁。

### GitHub 策略

`repository` 使用 owner/name，`repositoryId` 是对应数字 ID；`base` 是冻结目标分支；`publish` 是发布许可。`feedback` 最多 20 位可信账户，每位包含数字 id、login 和允许的 scopes。`requiredChecks` 必须非空，最多 20 项，每项的 name 与 appId 要来自目标项目实际 CI，可选 codeStep 用于识别具体项目检查失败。

`pollIntervalMs` 为 1000–3600000，`maxPolls` 为 1–1000，`maxPages` 为 1–100。分页不足、证据不完整或预算耗尽会明确阻塞，不静默忽略评论/检查。仅支持 github.com、同仓库 head/base 和顶层 issue/PR 评论；没有 webhook、自动合并或跨仓库 fork 交付。

## 排错与恢复

| 现象 | 处理顺序 |
| --- | --- |
| `npm ci` 报版本不匹配 | 核对 Node 26.8.2/npm 11.14.1；不要关闭 engine-strict；重新安装匹配工具链 |
| 找不到 dist/cli.js | 在工具根目录运行 npm ci、npm run build |
| doctor/CLI 提示 local operation failed | 先确认服务仍运行、两个终端的数据目录相同、端口可用；再看服务终端错误 |
| 端口被占用 | 停止已知旧服务，或给新的数据目录选择新端口；已有目录必须复用登记端口 |
| JSON/schema invalid | 检查无 BOM 的 UTF-8、未知字段、必需参数、整数与范围；GitHub 片段不能直接替代完整配置 |
| version changed | 重读 status；状态变化期间旧 version 不再有效，确认操作仍适用后再提交 |
| not registered / workspace path 拒绝 | 核对 runtime.repo 和 task create --repo，数据/工作树/源 checkout 分离，使用绝对路径 |
| Codex 版本或权限预检失败 | 核对原生 executable、精确版本、同一用户的认证及 OS 支持；不要绕过预检 |
| 项目规则、hooks、filters、子模块或链接被拒绝 | 检查仓库契约并解决不受支持能力；不要删除规则来获得访问权。已跟踪的 .codex 扩展或 .mcp.json 也需要专门审计接入 |
| waiting_user 一直不动 | 使用当前 question.id/version 和 task.version 答复；等待不会启动模型，但总期限仍流逝 |
| blocked | 看 task.diagnostic、events、结果/日志与 validations；不得仅凭模型说完成就强行 accepted |
| recovering / unknown | 用原数据目录重启服务并查看恢复结果；只有可信停止凭证成立才回收占用。无法证明时保持隔离，交给操作员调查 |
| resume 拒绝 blocked | resume 仅接受 paused。确认无活动/unknown 执行且问题已解决后，可 pause→确认 paused→resume；已耗尽的期限/迭代不会因此重置 |
| 运行次数用完 | 只有原期限未到且执行/占用停止后，才可用 budget 明确提高 maxRuns；它不能修复 deadline 或 maxIterations 耗尽 |
| 总期限已过或任务终态 | 保留旧记录；明确重新授权后用新 key 创建新任务，不手工改数据库延长期限 |
| accepted 为 false | 检查 evidenceIssues、当前提交、可信验证和独立审查；恢复缺失的可信证据，不用旧 SHA 成功替代 |
| GitHub 401/403 或 push 失败 | 在控制器账户核对 gh 认证、仓库权限和 Git 推送认证；先解决原因，再按交付状态核对 |
| PR 已存在但交付 blocked | 查看 deliveryIntent、远端分支/PR SHA；用 reconcile-delivery 核对已有结果，不重复创建/推送未知副作用 |
| 评论没有触发修复 | 检查 `/relay` JSON、顶层评论、账户数字 ID/login/scopes、需求版本、当前 SHA 和 files 范围，再看 inbox.disposition |
| delivered 一直为 false | accepted 不等于 delivered；需要显式 publish、当前 CI 和反馈处理完成，再 complete-delivery |

服务重启后，活动或 unknown Run 不会直接被再次领取。新执行器由守护进程保存子进程所有权，恢复需要核对停止；旧版未登记或守护失联的执行可能持续隔离。没有安全的通用“清除 unknown”命令。

备份时先正常停止服务，确认所需任务无活动/unknown 执行，再按私有数据管理方式保留数据目录和相关工作树；数据目录中的 SQLite、成果和运行凭证相互关联，不要只复制一个数据库文件，也不要通过删 token/connection/租约来“修复”任务。Windows 目录权限依赖当前用户 ACL，Unix 数据目录必须是当前用户私有。

## Linux 模拟起步

真实开发模式目前仅支持 Windows；Linux 可以运行以下模拟流程。先在工具根目录安装锁定工具链并构建：

```bash
npm ci
npm run build
node dist/cli.js serve --data-dir .agent-relay/tutorial --port 4318
```

第二个终端进入同一工具目录：

```bash
node dist/cli.js doctor --data-dir .agent-relay/tutorial
printf '%s\n' '验证模拟任务' > .agent-relay/tutorial/task.txt
node dist/cli.js task create --repo . --input .agent-relay/tutorial/task.txt --key tutorial-linux-001 --data-dir .agent-relay/tutorial > .agent-relay/tutorial/created.json
task_id=$(node --input-type=module -e "import fs from 'node:fs'; console.log(JSON.parse(fs.readFileSync('.agent-relay/tutorial/created.json','utf8')).task.id)")
node dist/cli.js task status "$task_id" --data-dir .agent-relay/tutorial
node dist/cli.js task events "$task_id" --after 0 --limit 100 --data-dir .agent-relay/tutorial
```

正常完成仍应为 succeeded/accepted:true；必要时稍后重新查询。其余 CLI 参数与 Windows 相同，将 PowerShell 的文件与 JSON 操作替换为你熟悉的工具即可。不要事先创建宽权限的数据目录；让 serve 创建，或将自己已有的专用目录设为仅当前用户可访问。停止服务同样使用 Ctrl+C。
