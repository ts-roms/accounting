# Vendor master

Vendors carry the classic party fields plus (Prompt #7) a type, a group, a
named payment term, a default withholding tax code, a buyer, industry /
region and an onboarding state. Contacts, addresses (remit-to / order-from /
return-to) and bank accounts hang off the vendor; the profile row keeps the
hold trail, risk rating and payment preferences.

## Onboarding and holds (`vendors.vendor_status`)

```text
PENDING ─approve─▶ APPROVED ─hold─▶ ON_HOLD ─release─▶ APPROVED
   └─reject─▶ INACTIVE       └─block─▶ BLOCKED ─approve─▶ APPROVED
```

- New vendors start `PENDING` when `ap_settings.requireVendorApproval` is
  on, otherwise `APPROVED`. `vendor.approve` is delegable; the decision is
  audited and raises `vendor.approved` / `vendor.on_hold`.
- A hold (`COMPLIANCE`, `QUALITY`, `DISPUTE`, `DUPLICATE`,
  `TAX_DOCUMENTS`, `OTHER`) blocks new purchase orders, bills and payments
  (`VENDOR_ON_HOLD`). Posted balances are untouched and still age.
- `VendorsService.assertUsable` is the single gate used by orders, bills and
  payments.

## Defaults

Group → vendor → document: the group's payment term, expense account and
withholding code fill what the vendor leaves blank; the company default term
(`ap_settings.defaultPaymentTermId`) applies to new vendors only. Explicit
`paymentTermsDays` on a vendor win over a default term.

## Bank accounts

Stored in full for remittance files, returned masked
(`accountNumberMasked`, last four visible) everywhere else, including the
audit trail. `verify` records who checked the instructions.

## API

```text
GET/POST/PATCH /api/v1/vendors                        list filters: vendorStatus, vendorGroupId, vendorType, onHold, search
POST  /api/v1/vendors/:id/approve   { decision: APPROVE | REJECT | BLOCK }   (vendor.approve)
POST  /api/v1/vendors/:id/hold      { hold, reason, note }                    (vendor.approve)
PATCH /api/v1/vendors/:id/profile                                             (vendor.manage)
POST/PATCH/DELETE /api/v1/vendors/:id/contacts | addresses | bank-accounts   (vendor.manage)
GET/POST/PATCH /api/v1/vendor-groups                                          (ap-settings.manage)
```
