/**
 * Durable multi-step workflow lease engine used by long-running processes (payment webhook
 * processing, subscription renewal) that must survive crashes and retries without duplicating or
 * losing a step.
 */
import type { WorkflowDocument } from "../../types/documents";
import type { ISODateTime, JsonObject } from "../../types/primitives";
import type { MikaBackendRepositories } from "./ports";

export class WorkflowRunnerLeaseLostError extends Error {
  constructor() {
    super("Workflow lease is no longer active.");
  }
}

export class WorkflowRunner<TStep extends string> {
  private readonly input: {
    readonly ops: MikaBackendRepositories["ops"];
    readonly workflow: WorkflowDocument;
    readonly now: () => ISODateTime;
    readonly nextAttemptAt: (now: ISODateTime, workflow: WorkflowDocument) => ISODateTime;
    readonly stepFailureMessage: string;
  };
  private workflow: WorkflowDocument;
  private readonly leaseKey: string;
  private workflowFailurePersisted = false;

  constructor(input: {
    readonly ops: MikaBackendRepositories["ops"];
    readonly workflow: WorkflowDocument;
    readonly now: () => ISODateTime;
    readonly nextAttemptAt: (now: ISODateTime, workflow: WorkflowDocument) => ISODateTime;
    readonly stepFailureMessage: string;
  }) {
    const leaseKey = input.workflow.record.leaseKey;
    if (!leaseKey) throw new WorkflowRunnerLeaseLostError();

    this.input = input;
    this.workflow = input.workflow;
    this.leaseKey = leaseKey;
  }

  get failurePersisted(): boolean {
    return this.workflowFailurePersisted;
  }

  async runStep<TResult>(name: TStep, fn: () => Promise<TResult>): Promise<TResult> {
    this.workflow = this.requireLease(
      await this.input.ops.startWorkflowStep({
        workflowId: this.workflow.id,
        leaseKey: this.leaseKey,
        stepName: name,
        now: this.input.now(),
      }),
    );

    try {
      const result = await fn();
      this.workflow = this.requireLease(
        await this.input.ops.completeWorkflowStep({
          workflowId: this.workflow.id,
          leaseKey: this.leaseKey,
          stepName: name,
          now: this.input.now(),
        }),
      );

      return result;
    } catch (error) {
      const now = this.input.now();
      this.workflow = this.requireLease(
        await this.input.ops.failWorkflowStep({
          workflowId: this.workflow.id,
          leaseKey: this.leaseKey,
          stepName: name,
          now,
          lastError: error instanceof Error ? error.message : this.input.stepFailureMessage,
          nextAttemptAt: this.input.nextAttemptAt(now, this.workflow),
        }),
      );
      this.workflowFailurePersisted = true;
      throw error;
    }
  }

  async complete(state: JsonObject): Promise<void> {
    this.workflow = this.requireLease(
      await this.input.ops.completeWorkflow({
        workflowId: this.workflow.id,
        leaseKey: this.leaseKey,
        now: this.input.now(),
        state,
      }),
    );
  }

  async fail(lastError: string): Promise<void> {
    const now = this.input.now();
    this.workflow = this.requireLease(
      await this.input.ops.failWorkflow({
        workflowId: this.workflow.id,
        leaseKey: this.leaseKey,
        now,
        lastError,
        nextAttemptAt: this.input.nextAttemptAt(now, this.workflow),
      }),
    );
  }

  private requireLease(workflow: WorkflowDocument | null): WorkflowDocument {
    if (!workflow) throw new WorkflowRunnerLeaseLostError();

    return workflow;
  }
}
