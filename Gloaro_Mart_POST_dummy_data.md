# Gloaro Mart — POST request bodies (dummy data)

Base URL `http://localhost:4000`. Send `Content-Type: application/json`. Unless marked *no login*, send `Authorization: Bearer <token>` from the matching account (customer / vendor / admin). Ids (`1`) are placeholders. Money is in **paise** (`50000` = ₹500).

## Auth

**POST** `/api/auth/signup`  — *no login*  
role: customer or vendor
```json
{
  "fullName": "Test Customer",
  "email": "customer@example.com",
  "phoneNumber": "9876543210",
  "password": "Password123",
  "role": "customer"
}
```

**POST** `/api/auth/signup`  — *no login*  
vendor account
```json
{
  "fullName": "Test Vendor",
  "email": "vendor@example.com",
  "phoneNumber": "9876500000",
  "password": "Password123",
  "role": "vendor"
}
```

**POST** `/api/auth/login`  — *no login*  
returns { token }
```json
{
  "email": "customer@example.com",
  "password": "Password123"
}
```

**POST** `/api/auth/otp/send`  — *no login*  
code is emailed (console if no RESEND_API_KEY)
```json
{
  "email": "customer@example.com"
}
```

**POST** `/api/auth/otp/verify`  — *no login*  
use the emailed code
```json
{
  "email": "customer@example.com",
  "otp": "123456"
}
```

**POST** `/api/auth/forgot-password`  — *no login*
```json
{
  "email": "customer@example.com"
}
```

**POST** `/api/auth/reset-password`  — *no login*
```json
{
  "token": "<code from email>",
  "password": "NewPassword123"
}
```

## Catalogue (public)

**POST** `/api/products/ai-search`  — *no login*
```json
{
  "query": "cheap basmati rice"
}
```

## Cart & Wishlist

**POST** `/api/cart/items`  — *customer*
```json
{
  "productId": 1,
  "quantity": 2
}
```

**POST** `/api/wishlist`  — *customer*
```json
{
  "productId": 1
}
```

## Addresses & Matching

**POST** `/api/addresses`  — *customer*  
pincode 6 digits, mobile 10 digits
```json
{
  "receiverName": "Test User",
  "mobileNumber": "9876543210",
  "houseBuilding": "12, Rose Villa",
  "street": "MG Road",
  "area": "Indiranagar",
  "landmark": "Near Metro",
  "city": "Bengaluru",
  "district": "Bengaluru Urban",
  "state": "Karnataka",
  "pincode": "560038",
  "latitude": 12.9784,
  "longitude": 77.6408,
  "addressType": "home",
  "isDefault": true
}
```

**POST** `/api/serviceability/check`  — *customer*
```json
{
  "addressId": 1,
  "items": [
    {
      "productId": 1,
      "quantity": 1
    }
  ]
}
```

**POST** `/api/matching/vendors`  — *customer*
```json
{
  "addressId": 1,
  "items": [
    {
      "productId": 1,
      "quantity": 1
    }
  ],
  "strategy": "recommended"
}
```

**POST** `/api/matching/reassignments/1/respond`  — *customer*  
accept the alternative shop; false declines
```json
{
  "accept": true
}
```

## Orders & Payments

**POST** `/api/coupons/validate`  — *customer*
```json
{
  "vendorId": 1,
  "code": "WELCOME10",
  "subtotalCents": 100000
}
```

**POST** `/api/orders/checkout`  — *customer*  
paymentMethod: cod | upi | card | netbanking (wallet not usable yet)
```json
{
  "addressId": 1,
  "deliveryMethod": "delivery",
  "paymentMethod": "cod",
  "couponsByVendor": {
    "1": "WELCOME10"
  }
}
```

**POST** `/api/orders/1/cancel`  — *customer*
```json
{
  "reason": "Changed my mind"
}
```

**POST** `/api/orders/1/returns`  — *customer*  
reasonCode: damaged | wrong_item | not_as_described | missing_items | other
```json
{
  "reasonCode": "damaged",
  "comment": "Box was broken"
}
```

**POST** `/api/orders/1/reject`  — *vendor / admin*  
vendor rejects an order → triggers reassignment
```json
{
  "reason": "Out of stock"
}
```

**POST** `/api/payments/group/1/attempts`  — *customer*
```json
{
  "method": "upi"
}
```

## Wallet

**POST** `/api/wallet/topup`  — *customer*  
1000 – 5000000 paise (₹10 – ₹50,000)
```json
{
  "amountCents": 50000
}
```

**POST** `/api/payments/webhook/manual`  — *gateway*  
needs header x-gloaro-signature = HMAC-SHA256(rawBody, PAYMENTS_WEBHOOK_SECRET)
```json
{
  "eventId": "evt_1001",
  "event": "captured",
  "providerPaymentId": "manual_topup_1",
  "amountCents": 50000
}
```

## Notifications

**POST** `/api/notifications/device-token`  — *customer*  
platform: android | ios | web
```json
{
  "token": "test-fcm-token-123",
  "platform": "android"
}
```

## Vendor

**POST** `/api/vendors/profile`  — *vendor*  
businessType: b2b | b2c | both
```json
{
  "businessName": "Sharma Traders",
  "businessType": "both",
  "gstNumber": "29ABCDE1234F1Z5",
  "addressLine": "45, Market Road",
  "city": "Bengaluru",
  "state": "Karnataka",
  "pincode": "560001",
  "latitude": 12.9716,
  "longitude": 77.5946
}
```

**POST** `/api/vendors/service-areas`  — *vendor*
```json
{
  "areaType": "radius",
  "radiusKm": 10
}
```

**POST** `/api/vendors/service-areas`  — *vendor*  
pincode variant
```json
{
  "areaType": "pincode",
  "pincode": "560038"
}
```

**POST** `/api/products`  — *vendor*  
priceCents in paise
```json
{
  "name": "Basmati Rice 5kg",
  "description": "Premium aged basmati",
  "priceCents": 65000,
  "currency": "INR",
  "stockQuantity": 100,
  "imageUrl": "https://example.com/rice.jpg",
  "category": "Grocery",
  "brandId": null,
  "gstRatePercent": 5,
  "moq": 1
}
```

**POST** `/api/coupons`  — *vendor*  
discountType: flat | percentage
```json
{
  "code": "WELCOME10",
  "discountType": "percentage",
  "discountValue": 10,
  "minOrderValueCents": 50000,
  "expiresAt": "2027-12-31T23:59:59Z"
}
```

**POST** `/api/vendor/products/1/variants`  — *vendor*  
attributeValueIds required
```json
{
  "sku": "RICE-5KG",
  "priceCents": 65000,
  "mrpCents": 70000,
  "sortOrder": 0,
  "attributeValueIds": [
    1
  ],
  "availableQty": 50,
  "lowStockThreshold": 5
}
```

**POST** `/api/vendor/products/1/media`  — *vendor*  
mediaType: image | video
```json
{
  "url": "https://example.com/rice-front.jpg",
  "mediaType": "image",
  "altText": "Front of pack",
  "isPrimary": true,
  "sortOrder": 0
}
```

## B2B & Network

**POST** `/api/org/states`  — *logged in*
```json
{
  "name": "Karnataka"
}
```

**POST** `/api/org/districts`  — *customer*
```json
{
  "stateId": 1,
  "name": "Bengaluru Urban"
}
```

**POST** `/api/org/chapters`  — *customer*
```json
{
  "districtId": 1,
  "name": "Indiranagar Chapter"
}
```

**POST** `/api/org/membership`  — *customer*  
join a chapter
```json
{
  "chapterId": 1
}
```

**POST** `/api/referrals`  — *customer*  
both users must be chapter members
```json
{
  "receivingUserId": 2,
  "note": "Needs 200kg rice weekly",
  "estimatedValueCents": 2500000
}
```

## Admin — Account & Staff

**POST** `/api/admin/me/password/otp`  — *admin*  
emails an OTP
```json
{
  "currentPassword": "AdminPass123",
  "newPassword": "NewAdminPass123"
}
```

**POST** `/api/admin/me/password/otp/confirm`  — *admin*
```json
{
  "otp": "123456"
}
```

**POST** `/api/admin/staff`  — *admin*
```json
{
  "email": "staff@example.com",
  "fullName": "Support Staff",
  "password": "StaffPass123",
  "roleId": 1
}
```

**POST** `/api/admin/roles`  — *admin*  
permission keys from GET /api/admin/permissions
```json
{
  "name": "Catalogue Manager",
  "description": "Manages products and categories",
  "permissions": [
    "products",
    "categories",
    "brands",
    "inventory"
  ]
}
```

**POST** `/api/admin/feature-flags`  — *admin*  
key: lowercase, e.g. wallet.topup
```json
{
  "key": "wallet.topup",
  "description": "Enable wallet top-up",
  "enabled": true
}
```

## Admin — Vendors

**POST** `/api/admin/vendors/1/documents`  — *admin*  
docType: gstin | pan | bank | fssai | other; docNumber or fileUrl required
```json
{
  "docType": "gstin",
  "docNumber": "29ABCDE1234F1Z5",
  "fileUrl": "https://example.com/gst.pdf"
}
```

**POST** `/api/admin/vendors/1/service-areas`  — *admin*
```json
{
  "areaType": "pincode",
  "pincode": "560038"
}
```

**POST** `/api/admin/commission-plans`  — *admin*  
scope: global | category (+categoryId) | vendor (+vendorId)
```json
{
  "scope": "global",
  "commissionPercent": 8,
  "flatFeeCents": 0,
  "notes": "Default platform commission"
}
```

## Admin — Catalogue

**POST** `/api/admin/products`  — *admin*  
vendorId required
```json
{
  "vendorId": 1,
  "name": "Toor Dal 1kg",
  "description": "Unpolished toor dal",
  "priceCents": 15000,
  "stockQuantity": 200,
  "gstRatePercent": 5,
  "moq": 1,
  "category": "Grocery",
  "tiers": [
    {
      "minQuantity": 10,
      "unitPriceCents": 14000
    }
  ]
}
```

**POST** `/api/admin/products/1/variants`  — *admin*
```json
{
  "sku": "DAL-1KG",
  "priceCents": 15000,
  "mrpCents": 16000,
  "attributeValueIds": [
    1
  ],
  "availableQty": 100,
  "lowStockThreshold": 10
}
```

**POST** `/api/admin/products/1/media`  — *admin*
```json
{
  "url": "https://example.com/dal.jpg",
  "mediaType": "image",
  "altText": "Toor dal",
  "isPrimary": true,
  "sortOrder": 0
}
```

**POST** `/api/admin/attributes`  — *admin*  
inputType: select | text | number
```json
{
  "name": "Pack Size",
  "code": "pack_size",
  "categoryId": 1,
  "inputType": "select",
  "isVariantDefining": true,
  "sortOrder": 0
}
```

**POST** `/api/admin/attributes/1/values`  — *admin*
```json
{
  "value": "5 kg",
  "sortOrder": 0
}
```

**POST** `/api/admin/categories`  — *admin*
```json
{
  "name": "Grocery",
  "iconKey": "shopping_basket",
  "sortOrder": 1
}
```

**POST** `/api/admin/brands`  — *admin*
```json
{
  "name": "India Gate",
  "slug": "india-gate",
  "logoUrl": "https://example.com/ig.png",
  "description": "Basmati rice brand",
  "sortOrder": 0,
  "isActive": true
}
```

**POST** `/api/admin/catalogue/import`  — *admin*  
type: products | variants | inventory; dryRun:true validates without saving
```json
{
  "type": "products",
  "dryRun": true,
  "csv": "name,priceCents\nSample Product,10000\n"
}
```

## Admin — Storefront

**POST** `/api/admin/banners`  — *admin*  
placement: home | card_shop | card_b2b | card_nearme; imageData = base64 data URI
```json
{
  "title": "Big saving per day",
  "subtitle": "Shop top picks",
  "imageData": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "linkUrl": "/category/1",
  "sortOrder": 0,
  "placement": "home"
}
```

**POST** `/api/menu/admin`  — *admin*  
linkType: section | category | vendor | url
```json
{
  "label": "Offers",
  "iconKey": "local_offer",
  "linkType": "section",
  "linkValue": "offers",
  "sortOrder": 1,
  "isActive": true
}
```

**POST** `/api/admin/coupons`  — *admin*  
platform-wide coupon
```json
{
  "code": "PLATFORM50",
  "discountType": "flat",
  "discountValue": 5000,
  "minOrderValueCents": 30000,
  "expiresAt": "2027-12-31T23:59:59Z"
}
```

## Admin — Finance & Returns

**POST** `/api/admin/payments/1/refunds`  — *admin*  
cannot exceed captured minus refunded
```json
{
  "amountCents": 10000,
  "reason": "Damaged item",
  "orderId": 1
}
```

**POST** `/api/admin/refunds/1/approve`  — *admin*
```json
{
  "note": "Approved by finance"
}
```

**POST** `/api/admin/refunds/1/reject`  — *admin*
```json
{
  "note": "Not eligible"
}
```

**POST** `/api/admin/returns/1/approve`  — *admin*
```json
{
  "note": "Return approved, raise refund"
}
```

**POST** `/api/admin/returns/1/reject`  — *admin*
```json
{
  "note": "Item was used"
}
```

## Admin — Organisation

**POST** `/api/admin/org/states`  — *admin*
```json
{
  "name": "Tamil Nadu"
}
```

**POST** `/api/admin/org/districts`  — *admin*
```json
{
  "stateId": 1,
  "name": "Chennai"
}
```

**POST** `/api/admin/org/chapters`  — *admin*
```json
{
  "districtId": 1,
  "name": "T Nagar Chapter"
}
```
