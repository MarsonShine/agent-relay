import { createHash, randomUUID } from 'node:crypto';
import {
  commandSchema,
  requirementRecordSchema,
  questionRecordSchema,
  createTaskSchema,
  decisionSchema,
  eventSchema,
  taskSchema,
  budgetAmendmentSchema,
} from '../core/contracts.ts';
import type {
  Command,
  CreateTask,
  Decision,
  Event,
  Task,
} from '../core/contracts.ts';
import { assertTransition, terminal } from '../core/state.ts';
import { RelayError } from '../core/errors.ts';
import type { Database } from './database.ts';
import { redact } from './redaction.ts';

export class Tasks {
  readonly db: Database;
  readonly secrets: readonly string[];
  constructor(db: Database, secrets: readonly string[] = []) {
    this.db = db;
    this.secrets = secrets;
  }
  get(id: string): Task {
    const row = this.db.sql
      .prepare('SELECT document FROM tasks WHERE id=?')
      .get(id);
    if (!row) throw new RelayError('not_found', 'task does not exist');
    return taskSchema.parse(JSON.parse(String(row.document)));
  }
  list(status?: Task['status']): Task[] {
    const rows =
      status === undefined
        ? this.db.sql.prepare('SELECT document FROM tasks ORDER BY rowid').all()
        : this.db.sql
            .prepare('SELECT document FROM tasks WHERE status=? ORDER BY rowid')
            .all(status);
    return rows.map((row) =>
      taskSchema.parse(JSON.parse(String(row.document))),
    );
  }
  create(
    value: CreateTask,
    now = Date.now(),
    persist?: (task: Task) => void,
  ): Task {
    const input = createTaskSchema.parse(value);
    const fingerprint = createHash('sha256')
      .update(JSON.stringify(input))
      .digest('hex');
    return this.db.transaction(() => {
      const existing = this.db.sql
        .prepare('SELECT id, fingerprint FROM tasks WHERE request_key=?')
        .get(input.requestKey);
      if (existing) {
        if (persist)
          throw new RelayError(
            'conflict',
            'atomic source creation cannot reuse an existing task',
          );
        if (existing.fingerprint !== fingerprint)
          throw new RelayError(
            'conflict',
            'request key was used for different input',
          );
        return this.get(String(existing.id));
      }
      const task = taskSchema.parse({
        schemaVersion: 1,
        id: randomUUID(),
        kind: input.kind ?? 'simulation',
        repo: input.repo,
        input: input.input,
        requirementVersion: 1,
        codeRevision: input.codeRevision,
        stage: 'triage',
        status: 'queued',
        version: 1,
        config: input.config,
        runsUsed: 0,
        iterationsUsed: 0,
        createdAt: now,
        deadlineAt: now + input.config.budget.maxTaskMs,
        control: null,
        question: null,
        diagnostic: null,
      });
      this.db.sql
        .prepare(
          'INSERT INTO tasks(id, request_key, fingerprint, document) VALUES(?,?,?,?)',
        )
        .run(task.id, input.requestKey, fingerprint, JSON.stringify(task));
      this.recordRequirement(task, 'created');
      persist?.(task);
      this.append(
        task.id,
        null,
        'task.created',
        'task.created',
        'simulation task queued',
        now,
      );
      return task;
    });
  }
  // Internal transaction primitive; callers must hold db.transaction().
  save(previous: Task, next: Task): Task {
    assertTransition(previous.status, next.status);
    const parsed = taskSchema.parse({
      ...next,
      diagnostic:
        next.diagnostic === null ? null : redact(next.diagnostic, this.secrets),
      version: previous.version + 1,
    });
    const result = this.db.sql
      .prepare(
        "UPDATE tasks SET document=? WHERE id=? AND json_extract(document,'$.version')=?",
      )
      .run(JSON.stringify(parsed), previous.id, previous.version);
    if (Number(result.changes) !== 1)
      throw new RelayError('conflict', 'task version changed');
    return parsed;
  }
  command(id: string, value: Command): Task {
    const command = commandSchema.parse(value);
    return this.db.transaction(() => {
      const task = this.get(id);
      if (task.version !== command.expectedVersion)
        throw new RelayError(
          'conflict',
          'task version changed; read status before retrying',
        );
      if (command.action === 'budget') {
        if (
          ![
            'queued',
            'waiting_user',
            'paused',
            'blocked',
            'succeeded',
          ].includes(task.status) ||
          task.control ||
          Date.now() >= task.deadlineAt ||
          command.maxRuns <= task.config.budget.maxRuns ||
          command.maxRuns <= task.runsUsed ||
          this.db.sql
            .prepare("SELECT 1 FROM runs WHERE task_id=? AND status!='stopped'")
            .get(id) ||
          this.db.sql
            .prepare('SELECT 1 FROM workspace_access WHERE task_id=?')
            .get(id)
        )
          throw new RelayError(
            'conflict',
            'budget amendment requires stopped ownership, remaining original time and a strictly higher finite run limit',
          );
        const saved = this.save(task, {
          ...task,
          config: {
            ...task.config,
            budget: { ...task.config.budget, maxRuns: command.maxRuns },
          },
        });
        const audit = budgetAmendmentSchema.parse({
          schemaVersion: 1,
          taskId: id,
          taskVersion: saved.version,
          source: 'local-user',
          approval: command.approval,
          previousBudget: task.config.budget,
          budget: saved.config.budget,
          runsUsed: task.runsUsed,
          iterationsUsed: task.iterationsUsed,
          infrastructureRetriesUsed: task.infrastructureRetriesUsed,
          deadlineAt: task.deadlineAt,
          requirementVersion: task.requirementVersion,
          codeRevision: task.codeRevision,
        });
        this.db.sql
          .prepare('INSERT INTO budget_amendments VALUES(?,?,?)')
          .run(id, saved.version, JSON.stringify(audit));
        this.append(
          id,
          null,
          `budget:${saved.version}`,
          'task.run_budget_amended',
          `run limit ${task.config.budget.maxRuns} -> ${command.maxRuns}; private audit version ${saved.version}; counters and deadline unchanged`,
        );
        return saved;
      }
      if (terminal.has(task.status))
        throw new RelayError('conflict', 'terminal tasks cannot be changed');
      let next: Task = { ...task };
      if (command.action === 'answer' || command.action === 'revise') {
        this.recordQuestion(task, null);
        if (this.decisions(id).length >= 100)
          throw new RelayError('conflict', 'decision history limit reached');
      }
      if (command.action === 'revise') {
        if (
          task.requirementVersion !== command.requirementVersion ||
          !['queued', 'waiting_user', 'paused', 'blocked'].includes(
            task.status,
          ) ||
          this.db.sql
            .prepare("SELECT 1 FROM runs WHERE task_id=? AND status!='stopped'")
            .get(id)
        )
          throw new RelayError(
            'conflict',
            'requirement change requires current version and confirmed idle execution',
          );
        const decision = decisionSchema.parse({
          schemaVersion: 1,
          id: randomUUID(),
          taskId: id,
          question: {
            id: randomUUID(),
            version: task.requirementVersion,
            text: 'User requirement replacement',
          },
          answer: command.input,
          source: 'local-user',
          requirementVersion: task.requirementVersion + 1,
        });
        this.db.sql
          .prepare('INSERT INTO decisions VALUES(?,?,?)')
          .run(decision.id, id, JSON.stringify(decision));
        next = {
          ...next,
          input: command.input,
          requirementVersion: decision.requirementVersion,
          stage: 'triage',
          question: null,
          diagnostic: null,
          status: task.status === 'paused' ? 'paused' : 'queued',
        };
      } else if (command.action === 'answer') {
        if (
          task.status !== 'waiting_user' ||
          !task.question ||
          task.question.id !== command.questionId ||
          task.question.version !== command.questionVersion
        ) {
          throw new RelayError(
            'conflict',
            'answer does not match the current pending question',
          );
        }
        const decision = decisionSchema.parse({
          schemaVersion: 1,
          id: randomUUID(),
          taskId: id,
          question: task.question,
          answer: command.answer,
          source: 'local-user',
          requirementVersion: task.requirementVersion + 1,
        });
        this.db.sql
          .prepare('INSERT INTO decisions VALUES(?,?,?)')
          .run(decision.id, id, JSON.stringify(decision));
        next = {
          ...next,
          requirementVersion: decision.requirementVersion,
          stage: task.kind === 'development' ? 'triage' : task.stage,
          question: null,
          status: 'queued',
        };
      } else if (command.action === 'resume') {
        if (task.status !== 'paused')
          throw new RelayError(
            'conflict',
            'only a confirmed paused task can resume',
          );
        next.status = task.question ? 'waiting_user' : 'queued';
        next.control = null;
      } else if (task.status === 'running' || task.status === 'recovering') {
        if (task.control === 'cancel' && command.action === 'pause')
          throw new RelayError(
            'conflict',
            'cancel cannot be downgraded to pause',
          );
        next.control = command.action;
        next.status = 'recovering';
      } else {
        next.status = command.action === 'pause' ? 'paused' : 'cancelled';
        next.control = null;
      }
      const saved = this.save(task, next);
      if (command.action === 'answer' || command.action === 'revise')
        this.recordRequirement(saved, command.action);
      this.append(
        id,
        null,
        `command:${saved.version}`,
        `task.${command.action}`,
        saved.status,
      );
      return saved;
    });
  }
  // History writes share the task/Run transition transaction.
  feedbackInside(
    task: Task,
    kind: 'requirement' | 'implementation' | 'design',
    text: string,
    source: 'github-feedback' | 'github-ci' | 'local-user',
    sourceKey: string,
  ): Task {
    const delivery = this.db.sql
      .prepare('SELECT document FROM deliveries WHERE task_id=?')
      .get(task.id);
    const eligible =
      source === 'local-user'
        ? kind !== 'requirement' &&
          !delivery &&
          !!this.db.sql
            .prepare('SELECT 1 FROM github_sources WHERE task_id=?')
            .get(task.id)
        : !!delivery &&
          JSON.parse(String(delivery.document)).status === 'watching';
    if (
      task.status !== 'succeeded' ||
      task.stage !== 'deliver' ||
      !eligible ||
      this.db.sql
        .prepare("SELECT 1 FROM runs WHERE task_id=? AND status!='stopped'")
        .get(task.id) ||
      this.db.sql
        .prepare('SELECT 1 FROM workspace_access WHERE task_id=?')
        .get(task.id) ||
      task.iterationsUsed >= task.config.budget.maxIterations ||
      task.runsUsed >= task.config.budget.maxRuns ||
      Date.now() >= task.deadlineAt
    )
      throw new RelayError(
        'conflict',
        'feedback requires idle accepted delivery within original budgets',
      );
    const decisionId = randomUUID();
    const decision = decisionSchema.parse({
      schemaVersion: 1,
      id: decisionId,
      taskId: task.id,
      ...(kind === 'requirement'
        ? {}
        : { obligation: { id: `G-${decisionId}`, origin: kind, sourceKey } }),
      question: {
        id: randomUUID(),
        version: task.requirementVersion,
        text: `Authorized ${source}: ${kind}`,
      },
      answer: text,
      source,
      requirementVersion:
        task.requirementVersion + (kind === 'requirement' ? 1 : 0),
    });
    if (this.decisions(task.id).length >= 100)
      throw new RelayError('conflict', 'decision history limit reached');
    this.db.sql
      .prepare('INSERT INTO decisions VALUES(?,?,?)')
      .run(decision.id, task.id, JSON.stringify(decision));
    const next = this.save(task, {
      ...task,
      requirementVersion: decision.requirementVersion,
      input:
        kind === 'requirement'
          ? `${task.input}\n\nAuthorized requirement update:\n${text}`
          : task.input,
      status: 'queued',
      stage:
        kind === 'requirement'
          ? 'triage'
          : kind === 'design'
            ? 'design'
            : 'implement',
      iterationsUsed: task.iterationsUsed + 1,
      diagnostic: null,
    });
    if (kind === 'requirement') this.recordRequirement(next, 'github-feedback');
    this.append(
      task.id,
      null,
      `feedback:${decision.id}`,
      'task.feedback',
      `${kind}:${next.requirementVersion}`,
    );
    return next;
  }
  private recordRequirement(
    task: Task,
    source: 'created' | 'answer' | 'revise' | 'github-feedback',
  ): void {
    const record = requirementRecordSchema.parse({
      taskId: task.id,
      requirementVersion: task.requirementVersion,
      input: task.input,
      source,
    });
    this.db.sql
      .prepare('INSERT INTO requirement_history VALUES(?,?,?)')
      .run(task.id, task.requirementVersion, JSON.stringify(record));
  }
  recordQuestion(task: Task, runId: string | null): void {
    if (!task.question) return;
    const record = questionRecordSchema.parse({
      taskId: task.id,
      runId,
      question: task.question,
      evidence: {
        requirementVersion: task.requirementVersion,
        codeRevision: task.codeRevision,
      },
    });
    this.db.sql
      .prepare('INSERT OR IGNORE INTO question_history VALUES(?,?,?,?)')
      .run(
        task.id,
        task.question.id,
        task.question.version,
        JSON.stringify(record),
      );
  }
  requirements(id: string) {
    return this.db.sql
      .prepare(
        'SELECT document FROM requirement_history WHERE task_id=? ORDER BY version',
      )
      .all(id)
      .map((r) =>
        requirementRecordSchema.parse(JSON.parse(String(r.document))),
      );
  }
  questions(id: string) {
    return this.db.sql
      .prepare(
        'SELECT document FROM question_history WHERE task_id=? ORDER BY rowid',
      )
      .all(id)
      .map((r) => questionRecordSchema.parse(JSON.parse(String(r.document))));
  }
  append(
    taskId: string,
    runId: string | null,
    key: string,
    type: string,
    payload: string,
    at = Date.now(),
  ): Event {
    payload = redact(payload, this.secrets);
    if (Buffer.byteLength(payload) > 8192)
      throw new RelayError('storage', 'event size limit exceeded');
    const old = this.db.sql
      .prepare('SELECT document FROM events WHERE task_id=? AND event_key=?')
      .get(taskId, key);
    if (old) {
      const event = eventSchema.parse(JSON.parse(String(old.document)));
      if (
        event.runId !== runId ||
        event.type !== type ||
        event.payload !== payload
      )
        throw new RelayError(
          'conflict',
          'duplicate event key has different content',
        );
      return event;
    }
    const sequence = Number(
      this.db.sql
        .prepare('SELECT coalesce(max(sequence),0)+1 AS next FROM events')
        .get()!.next,
    );
    const event = eventSchema.parse({
      schemaVersion: 1,
      sequence,
      taskId,
      runId,
      key,
      type,
      payload,
      at,
    });
    this.db.sql
      .prepare('INSERT INTO events VALUES(?,?,?,?)')
      .run(sequence, taskId, key, JSON.stringify(event));
    return event;
  }
  events(id: string, after = 0, limit = 100): Event[] {
    this.get(id);
    if (
      !Number.isSafeInteger(after) ||
      after < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 500
    ) {
      throw new RelayError('invalid', 'invalid event cursor or limit');
    }
    return this.db.sql
      .prepare(
        'SELECT document FROM events WHERE task_id=? AND sequence>? ORDER BY sequence LIMIT ?',
      )
      .all(id, after, limit)
      .map((row) => eventSchema.parse(JSON.parse(String(row.document))));
  }
  decisions(id: string): Decision[] {
    return this.db.sql
      .prepare('SELECT document FROM decisions WHERE task_id=? ORDER BY rowid')
      .all(id)
      .map((row) => decisionSchema.parse(JSON.parse(String(row.document))));
  }
  budgetChanges(id: string) {
    return this.db.sql
      .prepare(
        'SELECT document FROM budget_amendments WHERE task_id=? ORDER BY task_version',
      )
      .all(id)
      .map((row) => {
        const record = budgetAmendmentSchema.parse(
          JSON.parse(String(row.document)),
        );
        return { ...record, approval: redact(record.approval, this.secrets) };
      });
  }
}
