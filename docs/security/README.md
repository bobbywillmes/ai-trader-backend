# Access Control & RBAC

## 🔐 Purpose

Explain that AI Trader has two access models:
- machine/automation access
- human Admin UI access

## 🧭 Access Boundaries

Machine:
- n8n
- `AI_TRADER_SIGNAL_API_KEY`
- signal routes only

Human:
- Admin UI login/session
- roles and permissions
- account-scoped access

Static admin API key:
- maintenance/admin key
- owner-equivalent
- not for n8n

## 👤 Roles

- owner
- account_manager
- account_viewer
- legacy admin role compatibility

## ✅ Permission Model

List permissions:
- system.settings.read/write
- system.security.read/write
- tradingAccount.read/write/risk.write
- subscription.read/write
- strategy.read/write
- exitProfile.read/write
- reports.read
- systemEvents.read

## 🧾 Role-to-Permission Matrix

A table showing what each role can do.

## 🏦 Trading Account Access

Explain:
- `TradingAccountAccess`
- assigned accounts
- viewer/manager/owner access roles
- account-scoped endpoints
- why global/default-account routes stay owner-only

## 🖥️ UI Experiences

Owner:
- Admin Console

Viewer:
- Account Portal
- `/portal`
- assigned account only
- read-only

## ✉️ User Invitations & Setup Links

Explain:
- owner-created invite
- no public registration
- no email sending yet
- copy setup link manually
- one-time setup token
- token hashed in DB
- expires after 7 days
- regenerate invalidates old link

## 🚫 What Viewers Cannot Do

Explicitly list:
- no settings
- no users/access
- no order placement
- no cancel/close
- no reconciliation
- no broker sync
- no admin tool routes

## 🧪 Validation Checklist

Owner smoke test
Viewer smoke test
Negative API checks
n8n smoke test

## 🧯 Operational Notes

- legacy `admin` role migration to `owner`
- disabled users cannot log in
- pending setup users cannot log in
- last active owner protections