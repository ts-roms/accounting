# Purchase orders

Purchase orders share the `orders` table and `OrdersService`; they never
post. Prompt #7 adds the same lifecycle the sales order got:

```text
DRAFT ─submit─▶ SUBMITTED ─approve─▶ APPROVED ─close─▶ CLOSED
  │                 └─reject─▶ REJECTED ─submit─▶ SUBMITTED
  └─approve (direct, no workflow configured)─▶ APPROVED      any open ─cancel─▶ CANCELLED
```

- `submit` opens the `PURCHASE_ORDER` approval workflow (when one matches
  the amount) and raises `purchase_order.submitted`.
- `approve` needs `purchase-order.approve` (delegable through
  `AuthorityService`), a complete workflow, and passes the document-level
  SoD check against the creator.
- Both steps run `VendorsService.assertUsable`: a held, blocked or pending
  vendor cannot be ordered from.
- Receiving (`goods-receipts`) and billing (`purchase-orders/:id/bill`)
  are unchanged; the three-way match still gates bill payment.

Received-not-billed lines feed the GRNI analysis (see `accruals.md`).
