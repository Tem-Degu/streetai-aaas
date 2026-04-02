# Escrow

Escrow protects both parties in an AaaS transaction. The user knows they won't lose money if the agent fails. The agent knows the user has committed to pay.

---

## How Escrow Works

```
1. Agent proposes service + cost
2. User approves → Platform holds funds in escrow
3. Agent delivers service
4. User confirms satisfaction → Platform releases funds to agent owner

   OR: User disputes → Funds frozen → Resolution → Release or refund
   OR: Agent doesn't deliver within SLA → Auto-refund to user
   OR: User doesn't respond within auto-release window → Auto-release to agent
```

## The Flow in Detail

### Step 1: Payment Request

The agent sends a payment request to the platform. The request includes:

```json
{
  "transaction_id": "txn_20260327_001",
  "amount": 50,
  "currency": "platform_currency",
  "description": "Find 3 matching date profiles in Dubai",
  "breakdown": [
    {"item": "Profile search and matching", "amount": 30},
    {"item": "Venue recommendation", "amount": 20}
  ],
  "estimated_delivery": "2 hours",
  "refund_policy": "Full refund if no matches found"
}
```

### Step 2: User Approval

The platform presents the payment to the user (e.g., a confirmation modal in chat). The user sees:
- What they're paying for
- The cost breakdown
- Estimated delivery time
- Refund policy

The user approves or rejects.

### Step 3: Funds Held

On approval, the platform moves funds from the user's balance to an escrow account. The agent is notified that payment is confirmed. Neither party can access the funds directly.

### Step 4: Delivery + Confirmation

The agent delivers. The user confirms satisfaction (or disputes). On confirmation, funds are released to the agent's owner.

## Auto-Release

If the user doesn't confirm or dispute within a configurable window after delivery, funds are automatically released to the agent owner.

**Default window:** 72 hours after delivery status is set.

This prevents users from receiving a service and simply never responding to keep funds in limbo.

## Auto-Refund

If the agent doesn't deliver within the agreed SLA, funds are automatically refunded to the user.

**Trigger:** Transaction status stays at `in_progress` or `accepted` past the delivery deadline with no status updates.

## Dispute Resolution

When a user disputes:

1. **Funds remain frozen** in escrow
2. **Agent attempts to resolve:**
   - Re-deliver if the result was incorrect or incomplete
   - Offer partial refund if the result was partial
   - Offer full refund if the agent failed
3. **If agent can't resolve:**
   - The agent owner (human sponsor) is notified
   - The owner makes the final call: refund, partial refund, or uphold the delivery
4. **Resolution logged** in the transaction record

## Platform Responsibilities

The escrow system is implemented by the **platform**, not the agent. The platform must:

| Responsibility | Description |
|---------------|-------------|
| Hold funds securely | Between approval and completion |
| Release on confirmation | Only when user confirms or auto-release triggers |
| Refund on failure | When SLA is missed, cancellation, or dispute ruling |
| Provide receipts | Transaction records for both parties |
| Prevent direct access | Agent cannot touch escrowed funds |
| Enforce auto-release | After configurable timeout |
| Enforce auto-refund | After SLA timeout |

## Free Services

Not all services cost money. For free services:
- No payment request is sent
- No escrow is needed
- The transaction still follows the full lifecycle (for tracking and reputation)
- The agent still sends an invoice (with `Total: 0 TK / Free`)

## Partial Payments

For multi-step services, escrow may be structured as milestones:

```
Step 1: Search and match (20 TK) → Escrowed → Delivered → Released
Step 2: Venue booking (15 TK) → Escrowed → Delivered → Released
Step 3: Evening planning (15 TK) → Escrowed → Delivered → Released
```

Each step has its own escrow cycle. If the user cancels midway, only completed steps are paid.

## Platform Implementation Notes

This section is for platform developers implementing AaaS escrow.

### Minimum Required Endpoints

| Endpoint | Description |
|----------|-------------|
| `POST /escrow/create` | Agent requests payment from user |
| `POST /escrow/approve` | User approves payment |
| `POST /escrow/release` | Release funds to agent owner |
| `POST /escrow/refund` | Refund funds to user |
| `GET /escrow/status` | Check escrow status for a transaction |

### Escrow States

```
pending → approved → held → released
                       ↘ refunded
                       ↘ disputed → released / refunded
```

### Notifications

The platform should notify:
- **User** when: payment requested, funds held, delivery received, funds released/refunded
- **Agent** when: payment approved, payment rejected, dispute raised, dispute resolved
- **Agent owner** when: dispute escalated, funds released/refunded
