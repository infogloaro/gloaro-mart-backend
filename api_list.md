# Gloaro Mart API Endpoints

## /api/auth
- **POST** /api/auth/signup
- **POST** /api/auth/login
- **POST** /api/auth/otp/send
- **POST** /api/auth/otp/verify
- **POST** /api/auth/forgot-password
- **POST** /api/auth/reset-password
- **PATCH** /api/auth/change-password
- **POST** /api/auth/logout
- **POST** /api/auth/refresh
- **GET** /api/auth/me
- **PATCH** /api/auth/me
- **DELETE** /api/auth/me

## /api/vendors
- **POST** /api/vendors/profile
- **GET** /api/vendors/profile
- **PATCH** /api/vendors/profile
- **GET** /api/vendors/delivery-settings
- **PUT** /api/vendors/delivery-settings
- **GET** /api/vendors/service-areas
- **POST** /api/vendors/service-areas
- **DELETE** /api/vendors/service-areas/:id
- **GET** /api/vendors
- **GET** /api/vendors/:id/products
- **GET** /api/vendors/:id/reviews
- **GET** /api/vendors/:id

## /api/products
- **POST** /api/products
- **GET** /api/products/mine
- **POST** /api/products/ai-search
- **GET** /api/products/search
- **PATCH** /api/products/:id
- **DELETE** /api/products/:id
- **GET** /api/products/:id/reviews
- **PUT** /api/products/:id/review
- **GET** /api/products/:id/tiers
- **PUT** /api/products/:id/tiers
- **GET** /api/products/:id
- **GET** /api/products

## /api/nearby
- **GET** /api/nearby/vendors

## /api/cart
- **GET** /api/cart
- **POST** /api/cart/items
- **PATCH** /api/cart/items/:productId
- **DELETE** /api/cart/items/:productId

## /api/wishlist
- **GET** /api/wishlist
- **GET** /api/wishlist/ids
- **POST** /api/wishlist
- **DELETE** /api/wishlist/:productId

## /api/orders
- **POST** /api/orders/checkout
- **GET** /api/orders/vendor
- **GET** /api/orders/groups
- **GET** /api/orders/groups/:id
- **GET** /api/orders/groups/:id/reassignments
- **GET** /api/orders
- **GET** /api/orders/:id/history
- **GET** /api/orders/:id/refunds
- **POST** /api/orders/:id/returns
- **GET** /api/orders/:id/returns
- **DELETE** /api/orders/:id/returns/:returnId
- **PUT** /api/orders/:id/review
- **GET** /api/orders/:id/review
- **GET** /api/orders/:id
- **PATCH** /api/orders/:id/status
- **POST** /api/orders/:id/cancel
- **POST** /api/orders/:id/reject

## /api/wallet
- **GET** /api/wallet
- **GET** /api/wallet/transactions
- **GET** /api/wallet/me
- **GET** /api/wallet/me/transactions
- **POST** /api/wallet/topup
- **GET** /api/wallet/topup/:id

## /api/coupons
- **POST** /api/coupons
- **GET** /api/coupons/mine
- **POST** /api/coupons/validate
- **PATCH** /api/coupons/:id
- **DELETE** /api/coupons/:id

## /api/org
- **GET** /api/org/states
- **POST** /api/org/states
- **GET** /api/org/states/:stateId/districts
- **POST** /api/org/districts
- **GET** /api/org/districts/:districtId/chapters
- **POST** /api/org/chapters
- **GET** /api/org/chapters/:chapterId/members
- **GET** /api/org/chapters/:chapterId
- **GET** /api/org/membership/me
- **POST** /api/org/membership
- **DELETE** /api/org/membership

## /api/referrals
- **POST** /api/referrals
- **GET** /api/referrals/chapter/:chapterId
- **GET** /api/referrals/sent
- **GET** /api/referrals/received
- **PATCH** /api/referrals/:id/status

## /api/analytics
- **GET** /api/analytics/vendor/summary

## /api/admin
- **GET** /api/admin/me
- **POST** /api/admin/me/password/otp
- **POST** /api/admin/me/password/otp/confirm
- **GET** /api/admin/permissions
- **GET** /api/admin/audit-logs
- **GET** /api/admin/feature-flags
- **POST** /api/admin/feature-flags
- **PATCH** /api/admin/feature-flags/:id
- **DELETE** /api/admin/feature-flags/:id
- **GET** /api/admin/staff
- **POST** /api/admin/staff
- **PATCH** /api/admin/staff/:id
- **PATCH** /api/admin/staff/:id/password
- **DELETE** /api/admin/staff/:id
- **GET** /api/admin/roles
- **POST** /api/admin/roles
- **PATCH** /api/admin/roles/:id
- **DELETE** /api/admin/roles/:id
- **GET** /api/admin/users
- **GET** /api/admin/users/:id
- **PATCH** /api/admin/users/:id/role
- **GET** /api/admin/vendors
- **GET** /api/admin/vendors/performance
- **GET** /api/admin/vendors/kyc-summary
- **GET** /api/admin/vendors/:id/performance
- **GET** /api/admin/vendors/:id/documents
- **POST** /api/admin/vendors/:id/documents
- **PATCH** /api/admin/vendors/:id/status
- **PATCH** /api/admin/vendors/:id
- **GET** /api/admin/control-tower
- **GET** /api/admin/control-tower/summary
- **GET** /api/admin/catalogue/export
- **POST** /api/admin/catalogue/import
- **GET** /api/admin/products/moderation
- **GET** /api/admin/products/moderation-counts
- **PATCH** /api/admin/products/:id/moderation
- **DELETE** /api/admin/products/:id/moderation
- **GET** /api/admin/vendor-documents
- **PATCH** /api/admin/vendor-documents/:docId/status
- **GET** /api/admin/commission-plans/resolve
- **GET** /api/admin/commission-plans
- **POST** /api/admin/commission-plans
- **PATCH** /api/admin/commission-plans/:id
- **DELETE** /api/admin/commission-plans/:id
- **GET** /api/admin/matching/weights
- **PUT** /api/admin/matching/weights
- **GET** /api/admin/matching/logs
- **GET** /api/admin/orders
- **GET** /api/admin/orders/:id
- **PATCH** /api/admin/orders/:id/status
- **GET** /api/admin/products
- **POST** /api/admin/products
- **GET** /api/admin/products/:id/tiers
- **PUT** /api/admin/products/:id/tiers
- **GET** /api/admin/products/:id/variants
- **POST** /api/admin/products/:id/variants
- **PATCH** /api/admin/products/:id/variants/:variantId
- **DELETE** /api/admin/products/:id/variants/:variantId
- **GET** /api/admin/products/:id/media
- **POST** /api/admin/products/:id/media
- **DELETE** /api/admin/products/:id/media/:mediaId
- **GET** /api/admin/products/:id
- **PATCH** /api/admin/products/:id
- **DELETE** /api/admin/products/:id
- **PATCH** /api/admin/media/:id/primary
- **GET** /api/admin/attributes
- **POST** /api/admin/attributes
- **GET** /api/admin/attributes/:id/values
- **POST** /api/admin/attributes/:id/values
- **PATCH** /api/admin/attributes/:id/values/:valueId
- **PATCH** /api/admin/attributes/:id
- **DELETE** /api/admin/attributes/:id
- **GET** /api/admin/inventory
- **GET** /api/admin/inventory/:id/movements
- **PATCH** /api/admin/inventory/:id
- **GET** /api/admin/categories
- **POST** /api/admin/categories
- **PATCH** /api/admin/categories/:id
- **DELETE** /api/admin/categories/:id
- **GET** /api/admin/brands
- **POST** /api/admin/brands
- **PATCH** /api/admin/brands/:id
- **DELETE** /api/admin/brands/:id
- **GET** /api/admin/settings
- **PUT** /api/admin/settings
- **GET** /api/admin/coupons
- **POST** /api/admin/coupons
- **PATCH** /api/admin/coupons/:id
- **DELETE** /api/admin/coupons/:id
- **GET** /api/admin/reports/summary
- **GET** /api/admin/payments
- **GET** /api/admin/payments/:id
- **POST** /api/admin/payments/:id/refunds
- **GET** /api/admin/refunds
- **POST** /api/admin/refunds/:id/approve
- **POST** /api/admin/refunds/:id/reject
- **GET** /api/admin/returns
- **POST** /api/admin/returns/:returnId/approve
- **POST** /api/admin/returns/:returnId/reject
- **GET** /api/admin/org/states
- **POST** /api/admin/org/states
- **PATCH** /api/admin/org/states/:id
- **DELETE** /api/admin/org/states/:id
- **GET** /api/admin/org/districts
- **POST** /api/admin/org/districts
- **PATCH** /api/admin/org/districts/:id
- **DELETE** /api/admin/org/districts/:id
- **GET** /api/admin/org/chapters
- **POST** /api/admin/org/chapters
- **GET** /api/admin/org/chapters/:id/members
- **PATCH** /api/admin/org/chapters/:id
- **DELETE** /api/admin/org/chapters/:id
- **GET** /api/admin/referrals
- **GET** /api/admin/referrals/summary
- **PATCH** /api/admin/referrals/:id/status
- **GET** /api/admin/wallets
- **GET** /api/admin/wallets/:vendorId/transactions
- **GET** /api/admin/banners
- **POST** /api/admin/banners
- **PATCH** /api/admin/banners/:id
- **DELETE** /api/admin/banners/:id
- **GET** /api/admin/vendors/:id/service-areas
- **POST** /api/admin/vendors/:id/service-areas
- **DELETE** /api/admin/vendors/:id/service-areas/:areaId
- **GET** /api/admin/vendors/:id/delivery-settings
- **PUT** /api/admin/vendors/:id/delivery-settings

## /api/banners
- **GET** /api/banners

## /api/categories
- **GET** /api/categories

## /api/brands
- **GET** /api/brands

## /api/settings
- **GET** /api/settings

## /api/feature-flags
- **GET** /api/feature-flags/enabled

## /api/menu
- **GET** /api/menu
- **GET** /api/menu/admin
- **POST** /api/menu/admin
- **PUT** /api/menu/admin/reorder
- **PATCH** /api/menu/admin/:id
- **DELETE** /api/menu/admin/:id

## /api/addresses
- **GET** /api/addresses
- **POST** /api/addresses
- **PATCH** /api/addresses/:id/default
- **PATCH** /api/addresses/:id
- **DELETE** /api/addresses/:id

## /api/serviceability
- **POST** /api/serviceability/check

## /api/payments
- **POST** /api/payments/webhook/:provider
- **GET** /api/payments/group/:groupId
- **POST** /api/payments/group/:groupId/attempts

## /api/matching
- **POST** /api/matching/vendors
- **GET** /api/matching/alternatives/:productId
- **GET** /api/matching/reassignments
- **POST** /api/matching/reassignments/:id/respond

## /api/notifications
- **GET** /api/notifications
- **POST** /api/notifications/device-token
- **DELETE** /api/notifications/device-token
- **POST** /api/notifications/read-all
- **PATCH** /api/notifications/:id/read

## /api/vendor
- **GET** /api/vendor/dashboard
- **GET** /api/vendor/attributes
- **GET** /api/vendor/products/:id/variants
- **POST** /api/vendor/products/:id/variants
- **PATCH** /api/vendor/products/:id/variants/:variantId
- **DELETE** /api/vendor/products/:id/variants/:variantId
- **GET** /api/vendor/products/:id/media
- **POST** /api/vendor/products/:id/media
- **DELETE** /api/vendor/products/:id/media/:mediaId
- **PATCH** /api/vendor/media/:id/primary
- **GET** /api/vendor/inventory
- **GET** /api/vendor/inventory/:id/movements
- **PATCH** /api/vendor/inventory/:id

