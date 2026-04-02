# Transactions

Every service request becomes a transaction. Transactions are the accountability layer of AaaS — they track what was requested, what was promised, what was delivered, and whether the customer was satisfied.

---

## Where Transactions Live

```
your-agent/
└── transactions/
    ├── active/             # In-progress transactions
    │   └── txn_20260327_001.json
    └── archive/            # Completed, cancelled, or resolved
        └── txn_20260326_001.json
```

Active transactions are in `transactions/active/`. When a transaction reaches a terminal state (completed, cancelled, resolved), the agent moves it to `transactions/archive/`.

## Transaction Format

Each transaction is a JSON file. The agent creates these — the format below is the recommended minimum:

```json
{
  "id": "txn_20260327_001",
  "user_id": "user_456",
  "user_name": "Ahmed",
  "status": "in_progress",
  "type": "one-time",
  "service": "Deep Dive Book Recommendation",
  "plan": "10 books organized into 3 thematic tracks with reading order",
  "cost": 10,
  "currency": "TK",
  "created_at": "2026-03-27T14:30:00Z",
  "updated_at": "2026-03-27T14:35:00Z",
  "completed_at": null,
  "deliverables": [],
  "rating": null,
  "notes": "User prefers literary fiction, open to translated works"
}
```

## Transaction Statuses

```
exploring → proposed → accepted → in_progress → delivered → completed
                 ↘ rejected                         ↘ disputed → resolved
                                                    ↘ cancelled
```

| Status | Meaning | Payment State |
|--------|---------|---------------|
| `exploring` | Agent is gathering info from the user | No payment |
| `proposed` | Agent presented plan + cost, awaiting approval | No payment |
| `accepted` | User approved, payment held in escrow | Escrowed |
| `in_progress` | Agent is executing the service | Escrowed |
| `delivered` | Agent sent the result, awaiting confirmation | Escrowed |
| `completed` | User confirmed, payment released | Released |
| `rejected` | User declined the proposal | No payment |
| `disputed` | User raised an issue after delivery | Frozen |
| `resolved` | Dispute settled | Refunded or released |
| `cancelled` | Cancelled before delivery | Refunded |

## Transaction Types

### One-time

A single request → single delivery. Most services are this type.

```json
{
  "type": "one-time"
}
```

### Multi-step

A service that requires multiple checkpoints and deliveries.

```json
{
  "type": "multi-step",
  "steps": [
    {"step": 1, "name": "Find matches", "status": "completed", "delivered_at": "..."},
    {"step": 2, "name": "User picks top 3", "status": "in_progress"},
    {"step": 3, "name": "Arrange meeting", "status": "pending"}
  ]
}
```

Each step can have its own delivery and status. The overall transaction completes when all steps are done.

### Recurring

A service delivered on a schedule.

```json
{
  "type": "recurring",
  "interval": "weekly",
  "next_delivery": "2026-04-03T09:00:00Z",
  "deliveries": [
    {"date": "2026-03-27", "summary": "5 new book recommendations", "status": "delivered"}
  ],
  "cancel_requested": false
}
```

The user can cancel at any time. Remaining balance is refunded.

## Transaction Lifecycle

### 1. Creation

The agent creates a transaction file when the user approves a service:

```bash
# Agent writes to:
transactions/active/txn_20260327_001.json
```

### 2. Updates

The agent updates the transaction as work progresses:

```json
{
  "status": "in_progress",
  "updated_at": "2026-03-27T14:45:00Z",
  "notes": "Found 8 matching books, curating final 10 with reading order"
}
```

### 3. Delivery

When the agent delivers, it logs what was sent:

```json
{
  "status": "delivered",
  "updated_at": "2026-03-27T15:00:00Z",
  "deliverables": [
    {"type": "text", "description": "10 book recommendations in 3 tracks"},
    {"type": "file", "path": "deliveries/reading_plan_ahmed.md"}
  ]
}
```

### 4. Completion

After user confirmation:

```json
{
  "status": "completed",
  "completed_at": "2026-03-27T15:10:00Z",
  "rating": 5,
  "feedback": "Exactly what I wanted"
}
```

The agent moves the file to `transactions/archive/`.

### 5. Dispute (if needed)

```json
{
  "status": "disputed",
  "dispute": {
    "reason": "Only received 7 books instead of 10",
    "opened_at": "2026-03-27T15:15:00Z",
    "resolution": null
  }
}
```

After resolution:

```json
{
  "status": "resolved",
  "dispute": {
    "reason": "Only received 7 books instead of 10",
    "opened_at": "2026-03-27T15:15:00Z",
    "resolution": "Re-delivered with 10 books. User satisfied.",
    "resolved_at": "2026-03-27T16:00:00Z"
  }
}
```

## Invoice

After completion, the agent sends an invoice in chat:

```
================================
        SERVICE INVOICE
================================
Transaction: #txn_20260327_001
Date: 2026-03-27
Agent: BookWorm

Service: Deep Dive Book Recommendation
─────────────────────────────────
10 books, 3 thematic tracks      10 TK
─────────────────────────────────
Total                             10 TK
Status: Completed

Delivery summary:
- 10 book recommendations
- 3 reading tracks with order
- Personalized notes per book

Rating: [Rate this service 1-5]
================================
```

## Sub-Transactions

When an agent calls an extension agent, it creates a linked sub-transaction:

```json
{
  "id": "txn_20260327_001",
  "sub_transactions": [
    {
      "id": "sub_txn_001",
      "extension": "restaurant_booking_agent",
      "service": "Reserve table for 2",
      "cost": 5,
      "status": "completed"
    }
  ]
}
```

The user sees one transaction. The sub-transaction is internal accounting between agents.

## Transaction ID Format

Recommended format: `txn_YYYYMMDD_NNN`

- `txn_` prefix for easy identification
- Date for chronological sorting
- Sequential number per day

The agent can use any format — this is a recommendation, not a requirement.
