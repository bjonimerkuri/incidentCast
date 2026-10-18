# IncidentCast - Complete User Guide & API Documentation

A modern incident and status page management system built with Angular (frontend) and Cloudflare Workers with D1 Database (backend).

## Table of Contents

1. [Getting Started](#getting-started)
2. [Running the Application](#running-the-application)
3. [Features Overview](#features-overview)
4. [How to Use Each Feature](#how-to-use-each-feature)
5. [API Reference](#api-reference)
6. [Test Values & Examples](#test-values--examples)
7. [Troubleshooting](#troubleshooting)

---

## Getting Started

### Prerequisites
- Node.js 18+ installed
- npm or yarn package manager
- Cloudflare account (for production deployment)

### Installation

#### Backend Setup
```bash
cd backend
npm install
```

#### Frontend Setup
```bash
cd frontend
npm install
```

---

## Running the Application

### Start Backend (Development)
```bash
cd backend
npm run dev
```
This starts the Cloudflare Workers dev server on `http://localhost:8787`

### Start Frontend (Development)
```bash
cd frontend
ng serve
```
This starts the Angular dev server on `http://localhost:4200`

### Access the Application
- **Frontend**: http://localhost:4200
- **Backend API**: http://localhost:8787
- **Public Status Page**: http://localhost:4200/status/{your-org-slug}

---

## Features Overview

### Core Features
| Feature | Description |
|---------|-------------|
| **Status Pages** | Public-facing pages showing system status |
| **Components** | Track status of individual services/systems |
| **Incidents** | Report and track outages and issues |
| **Maintenance** | Schedule and communicate planned maintenance |
| **Subscribers** | Email notifications for status updates |
| **Playbooks** | Pre-defined incident response procedures |

### Settings & Integrations
| Feature | Description |
|---------|-------------|
| **Team Management** | Invite members with different roles (owner/admin/member) |
| **Webhooks** | Send notifications to external services |
| **Integrations** | Slack and Microsoft Teams notifications |
| **API Keys** | External API access for monitoring tools |
| **Email Templates** | Customize notification emails |
| **Status Badge** | Embeddable status badges for your website |

---

## How to Use Each Feature

### 1. User Registration & Login

#### Sign Up
1. Go to http://localhost:4200/signup
2. Enter your email, password (min 8 chars), name, and organization name
3. Click "Create Account"
4. You'll be redirected to the dashboard

#### Login
1. Go to http://localhost:4200/login
2. Enter your email and password
3. Click "Sign In"

#### Edit Profile
1. Click your name/avatar at the bottom of the sidebar
2. Update your name or avatar URL
3. You can also change your password here

---

### 2. Components Management

Components represent the services/systems you want to track (e.g., API Server, Website, Database).

#### Create a Component
1. Go to **Dashboard > Components**
2. Click **"Add Component"**
3. Fill in:
   - **Name**: e.g., "API Server"
   - **Description**: e.g., "Main REST API endpoints"
   - **Status**: operational, degraded_performance, partial_outage, major_outage, or under_maintenance
   - **Group** (optional): Organize components into groups

#### Component Statuses
| Status | Color | Description |
|--------|-------|-------------|
| `operational` | 🟢 Green | Everything working normally |
| `degraded_performance` | 🟡 Yellow | Reduced performance |
| `partial_outage` | 🟠 Orange | Some features unavailable |
| `major_outage` | 🔴 Red | Complete service outage |
| `under_maintenance` | 🔵 Blue | Planned maintenance |

---

### 3. Incident Management

#### Create an Incident
1. Go to **Dashboard > Incidents**
2. Click **"New Incident"**
3. Fill in:
   - **Title**: e.g., "API Response Times Elevated"
   - **Status**: investigating, identified, monitoring, or resolved
   - **Impact**: none, minor, major, or critical
   - **Message**: Detailed description of the issue
   - **Affected Components**: Select which components are impacted
   - **Notify Subscribers**: Check to send email notifications

#### Incident Statuses
| Status | Description |
|--------|-------------|
| `investigating` | Issue detected, looking into it |
| `identified` | Root cause found |
| `monitoring` | Fix applied, monitoring for stability |
| `resolved` | Issue fully resolved |

#### Add Incident Updates
1. Open an incident detail page
2. Click **"Add Update"**
3. Change status if needed and add a message
4. Optionally notify subscribers

---

### 4. Scheduled Maintenance

#### Create Maintenance Window
1. Go to **Dashboard > Maintenance**
2. Click **"Schedule Maintenance"**
3. Fill in:
   - **Title**: e.g., "Database Migration"
   - **Message**: Describe what will happen
   - **Scheduled For**: Start date/time
   - **Scheduled Until**: End date/time
   - **Affected Components**: Which services will be impacted

#### Maintenance Calendar
- View all scheduled maintenance in calendar format at **Dashboard > Maintenance > Calendar**

---

### 5. Subscribers Management

#### View Subscribers
- Go to **Dashboard > Subscribers** to see all email subscribers

#### How Subscription Works
1. Users subscribe via the public status page
2. They receive a verification email
3. Once verified, they get notifications for incidents/maintenance

#### Export Subscribers
- Click "Export" to download subscriber list as CSV

---

### 6. Team Management

#### Invite Team Members
1. Go to **Dashboard > Settings > Team**
2. Click **"Invite Member"**
3. Enter their email and select role
4. They must already have an IncidentCast account

#### Roles
| Role | Permissions |
|------|-------------|
| **Owner** | Full access, cannot be removed |
| **Admin** | Manage incidents, components, settings (except team/billing) |
| **Member** | Create/update incidents only |

---

### 7. Integrations

#### Slack Integration
1. Go to **Dashboard > Settings > Integrations**
2. Enable Slack toggle
3. Create an [Incoming Webhook](https://api.slack.com/messaging/webhooks) in Slack
4. Paste the webhook URL
5. Click **"Test Connection"** to verify

#### Microsoft Teams Integration
1. Create an [Incoming Webhook](https://learn.microsoft.com/en-us/microsoftteams/platform/webhooks-and-connectors/how-to/add-incoming-webhook) in Teams
2. Enable Teams toggle
3. Paste the webhook URL
4. Test the connection

---

### 8. Webhooks

Create custom webhooks to notify your own systems.

1. Go to **Dashboard > Settings > Webhooks**
2. Click **"Add Webhook"**
3. Enter:
   - **Name**: e.g., "Datadog Webhook"
   - **URL**: Your endpoint URL
   - **Secret** (optional): For HMAC signature verification
   - **Events**: Select which events trigger the webhook

#### Available Events
- `incident.created` - New incident created
- `incident.updated` - Incident status changed
- `incident.resolved` - Incident resolved
- `component.status_changed` - Component status changed
- `maintenance.scheduled` - New maintenance scheduled
- `maintenance.started` - Maintenance started
- `maintenance.completed` - Maintenance completed

---

### 9. API Keys

Create API keys for external monitoring tools.

1. Go to **Dashboard > Settings > API Keys**
2. Click **"Create API Key"**
3. Set name, permissions (read/write), and expiration
4. **IMPORTANT**: Copy the key immediately - it won't be shown again!

#### Using the API Key
```bash
curl -H "Authorization: Bearer YOUR_API_KEY" \
  https://your-api.com/api/v1/components
```

---

### 10. Playbooks

Pre-defined runbooks for consistent incident response.

#### Create a Playbook
1. Go to **Dashboard > Playbooks**
2. Click **"Create Playbook"**
3. Add:
   - **Name**: e.g., "Database Outage Response"
   - **Description**: When to use this playbook
   - **Steps**: Add action items in order

#### Execute a Playbook
1. Open the playbook
2. Click **"Run Playbook"**
3. Optionally link to an incident
4. Mark steps as complete as you go

---

## API Reference

### Authentication

#### POST /api/auth/signup
Create a new account.
```json
{
  "email": "user@example.com",
  "password": "SecurePass123!",
  "name": "John Doe",
  "organizationName": "My Company"
}
```

#### POST /api/auth/login
```json
{
  "email": "user@example.com",
  "password": "SecurePass123!"
}
```

#### GET /api/auth/me
Get current user (requires Bearer token)

#### PATCH /api/auth/profile
Update profile name/avatar

#### POST /api/auth/change-password
```json
{
  "currentPassword": "OldPass123!",
  "newPassword": "NewPass456!"
}
```

### Components

#### GET /api/components/pages/:pageId
List all components for a status page

#### POST /api/components/pages/:pageId
Create a component
```json
{
  "name": "API Server",
  "description": "Main API endpoints",
  "status": "operational",
  "display_order": 0
}
```

#### PATCH /api/components/:id
Update a component

#### PATCH /api/components/:id/status
Quick status update
```json
{
  "status": "degraded_performance"
}
```

### Incidents

#### GET /api/incidents/pages/:pageId
List incidents (supports ?type=incident or ?type=maintenance)

#### POST /api/incidents/pages/:pageId
Create an incident
```json
{
  "title": "API Latency Issues",
  "status": "investigating",
  "impact": "minor",
  "message": "We are investigating elevated response times.",
  "component_ids": ["comp-123"],
  "notify_subscribers": true
}
```

#### POST /api/incidents/:id/updates
Add incident update
```json
{
  "status": "identified",
  "message": "Root cause identified as database connection pool exhaustion.",
  "notify_subscribers": true
}
```

### External API (v1)

For monitoring tool integrations. Requires API key authentication.

#### GET /api/v1/components
List all components

#### PATCH /api/v1/components/:id/status
Update component status (for automated monitoring)
```json
{
  "status": "operational"
}
```

#### POST /api/v1/incidents
Create incident via API
```json
{
  "title": "Automated Alert: High CPU Usage",
  "message": "CPU usage exceeded 90% threshold",
  "impact": "minor"
}
```

---

## Test Values & Examples

### Test User Account
```
Email: test@example.com
Password: TestPassword123!
Organization: Test Organization
```

### Sample Component Data
```json
{
  "name": "API Server",
  "description": "Main REST API for the application",
  "status": "operational"
}
```

```json
{
  "name": "Web Application",
  "description": "Customer-facing web interface",
  "status": "operational"
}
```

```json
{
  "name": "Database",
  "description": "PostgreSQL database cluster",
  "status": "operational"
}
```

### Sample Incident
```json
{
  "title": "API Response Times Elevated",
  "status": "investigating",
  "impact": "minor",
  "message": "We are investigating reports of slow API response times affecting some users."
}
```

### Sample Maintenance
```json
{
  "title": "Scheduled Database Maintenance",
  "message": "We will be performing routine database maintenance. Expect brief interruptions.",
  "scheduled_for": "2026-02-01T02:00:00Z",
  "scheduled_until": "2026-02-01T04:00:00Z"
}
```

### Sample Webhook Payload (incident.created)
```json
{
  "event": "incident.created",
  "timestamp": "2026-01-29T12:00:00Z",
  "data": {
    "id": "inc-123",
    "title": "API Outage",
    "status": "investigating",
    "impact": "major",
    "url": "https://status.example.com/incidents/inc-123"
  }
}
```

### cURL Examples

#### Create Component
```bash
curl -X POST http://localhost:8787/api/components/pages/YOUR_PAGE_ID \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "X-Organization-Id: YOUR_ORG_ID" \
  -H "Content-Type: application/json" \
  -d '{"name":"CDN","description":"Content delivery network","status":"operational"}'
```

#### Update Component Status (External API)
```bash
curl -X PATCH http://localhost:8787/api/v1/components/COMPONENT_ID/status \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"status":"degraded_performance"}'
```

#### Create Incident
```bash
curl -X POST http://localhost:8787/api/incidents/pages/YOUR_PAGE_ID \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "X-Organization-Id: YOUR_ORG_ID" \
  -H "Content-Type: application/json" \
  -d '{"title":"Service Disruption","status":"investigating","impact":"major","message":"We are aware of issues affecting our service."}'
```

---

## Troubleshooting

### Common Issues

#### "Invalid email or password"
- Ensure you're using the correct email (case-insensitive)
- Password is case-sensitive

#### "User with this email does not exist"
- When inviting team members, they must first create an IncidentCast account

#### Components not showing on public status page
- Ensure the status page is set to "public"
- Check that components are assigned to the correct status page

#### Webhooks not firing
- Verify the webhook URL is correct and accessible
- Check that the webhook is enabled
- View recent deliveries for error status codes

#### API Key not working
- Ensure the key hasn't expired
- Check that you're using the correct key (not the preview)
- Verify the key has the required permissions (read/write)

### Debug Mode

The backend returns debug information in some responses during development:
- Password reset tokens are logged and returned (remove in production!)
- Subscriber verification tokens are returned for testing

### Logs

Backend logs can be viewed in the terminal running `npm run dev`:
```
<-- GET /api/auth/me
--> GET /api/auth/me 200 3ms
```

---

## Architecture Overview

```
Frontend (Angular 20)          Backend (Cloudflare Workers + D1)
├── Public Pages              ├── /api/auth/*
│   ├── Landing               ├── /api/organizations/*
│   ├── Login/Signup          ├── /api/status-pages/*
│   └── Public Status         ├── /api/components/*
│                             ├── /api/incidents/*
├── Dashboard                 ├── /api/subscribers/*
│   ├── Overview              ├── /api/webhooks/*
│   ├── Incidents             ├── /api/integrations/*
│   ├── Maintenance           ├── /api/playbooks/*
│   ├── Components            ├── /api/uptime/*
│   ├── Subscribers           ├── /api/incident-reports/*
│   ├── Playbooks             └── /api/v1/* (External API)
│   └── Settings
│       ├── General
│       ├── Team
│       ├── Status Page
│       ├── Webhooks
│       ├── API Keys
│       ├── Integrations
│       ├── Email Templates
│       ├── Status Badge
│       └── Profile
```

---

## Security Considerations

1. **JWT Tokens**: Expire after 24 hours
2. **Password Reset Tokens**: Expire after 1 hour
3. **API Keys**: Can be set to expire
4. **Webhook Secrets**: Use HMAC-SHA256 for signature verification
5. **Rate Limiting**: Applied to auth and public endpoints

---

## Support

For questions or issues, please open an issue in the repository.
