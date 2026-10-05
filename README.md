# Lavender — Updated WooCommerce Mini CRM

Lavender is a local-first WooCommerce CRM prototype built with Node.js, Express, SQLite and vanilla JavaScript. It turns WooCommerce order webhooks into customer profiles, order history, revenue reporting and relationship-management insights.

## What is included

- Dashboard with customers, orders, revenue and top-customer overview
- Customer CRUD and dedicated customer profiles
- Automatic customer segmentation: VIP, Repeat Buyer, One-Time, At-Risk, Inactive and New
- Customer Value Score with Bronze/Silver/Gold/Diamond tiers
- Customer notes and chronological relationship/activity timeline
- Customer communication workflow with ready-to-send email template
- Product preferences from WooCommerce `line_items`
- Orders CRUD with search and status filtering
- Dedicated order details with customer and product information
- Revenue and analytics pages
- Regional/customer-city revenue view
- Product demand insights
- Administrative activity/audit log
- WooCommerce webhook logs
- CSV export for customers and orders
- Local SQLite database; no paid database service required

## Tech stack

- Node.js
- Express.js
- SQLite / sqlite3
- HTML5 / CSS3
- Vanilla JavaScript
- CORS
- body-parser

## Run locally

```bash
npm install
npm start
```

Open `http://localhost:3000`.

## WooCommerce webhook

Use:

```text
http://YOUR-SERVER:3000/api/webhook/woocommerce
```

The webhook accepts a WooCommerce order payload, creates or updates the customer, creates or updates the order, stores line items, recalculates customer totals, and records the synchronization in the webhook and activity logs.

### Example PowerShell webhook

```powershell
$body = @{
  id = 5027
  number = "5027"
  status = "completed"
  currency = "INR"
  total = "4120.75"
  date_created = "2026-10-05T16:30:00"
  customer_id = 72
  billing = @{
    first_name = "Kabir"
    last_name = "Mehta"
    email = "kabir.mehta@example.com"
    phone = "+91 9876543210"
    city = "Bengaluru"
    country = "IN"
  }
  line_items = @(
    @{ product_id = 101; name = "Lavender Shoes"; sku = "LS-01"; quantity = 1; total = "2999.75" },
    @{ product_id = 102; name = "Lavender Socks"; sku = "LS-02"; quantity = 2; total = "1121.00" }
  )
} | ConvertTo-Json -Depth 6

Invoke-RestMethod `
  -Uri "http://localhost:3000/api/webhook/woocommerce" `
  -Method POST `
  -ContentType "application/json" `
  -Body $body
```

## Main pages

| Page | Purpose |
|---|---|
| Dashboard | CRM overview and top customers |
| Customers | Search, CRUD, segmentation and CSV export |
| Customer profile | Value score, notes, communication, products and order history |
| Segments | VIP, repeat, one-time and at-risk customer groups |
| Orders | Search, status filtering, CRUD and CSV export |
| Order details | Full order, customer, product and webhook payload information |
| Revenue | Revenue reporting and export |
| Analytics | Product, city and status insights |
| Activity Log | Administrative audit trail |
| Webhook Logs | WooCommerce synchronization history |
| Settings | Integration endpoint and data tools |

## API highlights

```text
GET    /api/health
GET    /api/dashboard
GET    /api/customers
GET    /api/customers/:id
POST   /api/customers
PUT    /api/customers/:id
DELETE /api/customers/:id
POST   /api/customers/:id/notes
GET    /api/orders
GET    /api/orders/:id
POST   /api/orders
PUT    /api/orders/:id
DELETE /api/orders/:id
GET    /api/segments
GET    /api/products
GET    /api/activity
GET    /api/webhooks
GET    /api/export/customers
GET    /api/export/orders
POST   /api/webhook/woocommerce
```

## Project structure

```text
Lavender_Updated/
├── public/
│   ├── app.js
│   ├── index.html
│   ├── logo.svg
│   └── style.css
├── .gitignore
├── package.json
├── README.md
└── server.js
```

`lavender.db` is generated automatically when the server starts and should not be committed to Git.

## Notes

Customer segmentation and value tiers are deterministic CRM heuristics, not machine-learning predictions. They are intentionally transparent and suitable for a hackathon prototype.

Product insights require WooCommerce `line_items` in the webhook payload.

For production deployment, add authentication, HTTPS, WooCommerce webhook signature verification, rate limiting and secure environment-variable configuration.
