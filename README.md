# Restaurant Management System
Node.js + Express backend, Supabase PostgreSQL, plain HTML/CSS/JS frontend (served by Express), Chart.js.

## Setup
1. Create a project at supabase.com. Open **SQL Editor**, paste `supabase/schema.sql`, click **Run**.
2. In Supabase **Project Settings > API**, copy the project URL and the `service_role` key.
3. `cp .env.example .env` and fill in `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, a random `JWT_SECRET` (32+ chars), and `ADMIN_EMAIL` / `ADMIN_PASSWORD`.
4. `npm install`, then `npm run seed` (creates the admin, categories, 6 tables, sample menu and ingredients; optional), then `npm start`.
5. Open http://localhost:3000 and sign in. Change the admin password under **User Roles & Permissions**, then add staff users with their roles.

## Deploy
Deploy the whole folder as one Node service (Render, Railway, Fly.io): build `npm install`, start `npm start`, and add the `.env` values as environment variables. The frontend is served from `public/`, so no second host is needed. If you host the frontend elsewhere, set `CORS_ORIGIN` and change the fetch base in `public/app.js`.

## How it protects data
- The service-role key lives only in the server environment. RLS is enabled on every table with no policies, so the anon key reads nothing.
- Passwords are bcrypt-hashed; logins are rate-limited; JWTs expire after 8 hours.
- Every route checks the role on the server. Generic CRUD routes whitelist writable columns.
- Order totals, tax and discounts are computed in the database from current prices, never trusted from the browser. A client idempotency key blocks duplicate orders.
- Stock is deducted once, when an order completes (row lock, flag and unique index). Purchases add stock only when received.
- Table reservations cannot overlap (database exclusion constraint).
- Card and digital payments need a reference and count as paid only after a manager verifies them.

## Recipes
Add dishes and ingredient quantities under **Inventory > Recipes** is not a sidebar item; recipes use the generic API at `/api/recipes`. See "Known gaps".

## Known gaps
Not yet built or tested against a live Supabase project: a Recipes page link in the sidebar, customer feedback, salary payment records, and automated tests. Loyalty points are stored but not auto-awarded.
