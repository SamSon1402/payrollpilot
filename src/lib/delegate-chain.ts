/**
 * Delegate-chain resolution.
 *
 * "Approver OOO" is the single most common payroll exception we hear
 * about from finance teams. The mistake most systems make is treating
 * it as an alert — "CFO is out, do something". The right shape is a
 * declarative policy: each role has an ordered fallback chain, and the
 * system walks the chain until someone available is found.
 *
 * Why this lives in a typed module and not in the database:
 *   - It's an org policy, not customer data — versioning matters more
 *     than dynamic editing.
 *   - The compiler should fail a build that references an unknown role.
 *   - It needs to be auditable: when David Park approves a payroll
 *     because Jane Mitchell was OOO, the audit log must show that the
 *     CHAIN said this was allowed, not that the system improvised.
 *
 * In production this would be loaded per-org from a versioned policy
 * store (we'd keep a hash of the policy doc in the audit event), but
 * the shape stays the same.
 */

export type ApproverRole =
  | 'CFO'
  | 'HEAD_OF_FINANCE'
  | 'FINANCE_CONTROLLER'
  | 'CEO'
  | 'TREASURER';

const DELEGATE_CHAINS: Record<ApproverRole, ApproverRole[]> = {
  CFO:                ['CFO', 'HEAD_OF_FINANCE', 'CEO'],
  HEAD_OF_FINANCE:    ['HEAD_OF_FINANCE', 'FINANCE_CONTROLLER', 'CFO'],
  FINANCE_CONTROLLER: ['FINANCE_CONTROLLER', 'HEAD_OF_FINANCE'],
  CEO:                ['CEO'],                          // never delegated
  TREASURER:          ['TREASURER', 'CFO'],
};

export interface ApproverAvailability {
  role: ApproverRole;
  userId: string;
  available: boolean;
  reason?: 'OOO' | 'OFFBOARDED' | 'NO_RESPONSE';
}

export interface ResolvedApprover {
  userId: string;
  role: ApproverRole;
  isDelegate: boolean;
  attemptedChain: ApproverRole[];
}

export class ApproverChainExhaustedError extends Error {
  constructor(
    public readonly requestedRole: ApproverRole,
    public readonly attempted: ApproverRole[],
  ) {
    super(`no available approver in chain for ${requestedRole}: tried ${attempted.join(' → ')}`);
    this.name = 'ApproverChainExhaustedError';
  }
}

/**
 * Walk the delegate chain in order, return the first available user.
 * Throws when the chain is exhausted — the workflow turns that into an
 * APPROVER_UNAVAILABLE exception which gets escalated to the CEO.
 */
export function resolveApprover(
  requestedRole: ApproverRole,
  availabilities: ApproverAvailability[],
): ResolvedApprover {
  const chain = DELEGATE_CHAINS[requestedRole];
  const byRole = new Map<ApproverRole, ApproverAvailability>();
  for (const a of availabilities) byRole.set(a.role, a);

  const attempted: ApproverRole[] = [];
  for (const role of chain) {
    attempted.push(role);
    const candidate = byRole.get(role);
    if (candidate?.available) {
      return {
        userId: candidate.userId,
        role,
        isDelegate: role !== requestedRole,
        attemptedChain: attempted,
      };
    }
  }
  throw new ApproverChainExhaustedError(requestedRole, attempted);
}
