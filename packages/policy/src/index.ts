import type { Plan, PolicyDecision } from "@vibecore/contracts";

export interface PolicyContext {
  approval?: string;
  productionApproved?: boolean;
}

export interface PolicyEvaluation {
  allowed: boolean;
  decisions: PolicyDecision[];
}

export function evaluatePlan(plan: Plan, context: PolicyContext = {}): PolicyEvaluation {
  const decisions: PolicyDecision[] = [];
  const isProduction = plan.environment === "production";

  if (isProduction && !context.productionApproved) {
    decisions.push({
      code: "policy.production.approval-required",
      effect: "deny",
      message: "Production execution requires explicit production approval",
    });
  }

  for (const action of plan.actions) {
    if (action.risk === "read") {
      decisions.push({
        code: "policy.read.allowed",
        effect: "allow",
        actionId: action.id,
        message: "Read-only action is allowed",
      });
      continue;
    }

    if (context.approval !== plan.digest) {
      decisions.push({
        code: "policy.plan.approval-required",
        effect: "require-approval",
        actionId: action.id,
        message: `${action.risk} action requires approval of the exact plan digest`,
      });
    } else {
      decisions.push({
        code: "policy.plan.approved",
        effect: "allow",
        actionId: action.id,
        message: "Action is covered by exact plan-digest approval",
      });
    }

    if (isProduction && action.risk === "destructive" && !hasVerifiedBackup(action.inputs)) {
      decisions.push({
        code: "policy.production.backup-required",
        effect: "deny",
        actionId: action.id,
        message: "Destructive production action requires verified backup evidence",
      });
    }
  }

  return {
    allowed: decisions.every(({ effect }) => effect === "allow"),
    decisions,
  };
}

function hasVerifiedBackup(inputs: unknown): boolean {
  if (!inputs || typeof inputs !== "object") return false;
  return (inputs as Record<string, unknown>).backupVerified === true;
}
